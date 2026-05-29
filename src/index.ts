import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { roomManager } from './room-manager.js';
import {
  startNewHand,
  performAction,
  isBettingRoundComplete,
  isHandComplete,
  advancePhase,
  nextPlayer,
  finishHand,
  performDrawDiscard,
  performDrawDecide,
  isDrawPhaseComplete,
  isRevealPhaseComplete,
  getNextDecidingPlayer,
} from './game-engine.js';
import type {
  ClientToServerEvents,
  GameVariant,
  ServerToClientEvents,
  SocketData,
  Room,
} from './types.js';

const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const app = express();
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'poker-backend', version: '0.5.0' });
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  httpServer,
  { cors: { origin: FRONTEND_URL, credentials: true } },
);

const sessionToSocket = new Map<string, string>();

// Drawmaha decide timers — keyed by roomId
const drawDecideTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Action timers — auto check/fold when player times out
const actionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearActionTimer(roomId: string) {
  const t = actionTimers.get(roomId);
  if (t) { clearTimeout(t); actionTimers.delete(roomId); }
}

function scheduleActionTimer(roomId: string) {
  clearActionTimer(roomId);
  const room = roomManager.getRoom(roomId);
  if (!room || !room.gameState) return;

  const { currentPlayerSeat, actionDeadline, currentBet, phase } = room.gameState;
  if (!currentPlayerSeat || !actionDeadline || phase === 'showdown') return;

  const delay = Math.max(0, actionDeadline - Date.now());

  const timer = setTimeout(() => {
    actionTimers.delete(roomId);
    const r = roomManager.getRoom(roomId);
    if (!r || !r.gameState) return;
    // Guard: player may have already acted
    if (r.gameState.currentPlayerSeat !== currentPlayerSeat) return;

    const player = r.players.find((p) => p.seat === currentPlayerSeat);
    if (!player || player.status !== 'playing') return;

    const toCall = r.gameState.currentBet - player.currentBet;

    if (toCall === 0) {
      // No bet to face — auto-check
      performAction(r, player.sessionToken, 'check');
      console.log(`[timeout] ${player.nick} auto-check in ${roomId}`);
      emitSystemMessage(roomId, `${player.nick} timed out — auto-check`);
    } else {
      // Bet/raise to face — auto-fold and sit them out
      performAction(r, player.sessionToken, 'fold');
      // Fix 3: auto sit-out so they don't block future hands
      player.status = 'sitting-out';
      console.log(`[timeout] ${player.nick} auto-fold + sit-out in ${roomId}`);
      emitSystemMessage(roomId, `${player.nick} timed out — folded and sitting out`);
    }

    broadcastRoomState(r);
    progressGame(roomId);
  }, delay + 500); // +500ms grace period

  actionTimers.set(roomId, timer);
}

// Draw submit timers — auto stand-pat when draw phase times out
const drawSubmitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDrawSubmitTimer(roomId: string) {
  const t = drawSubmitTimers.get(roomId);
  if (t) { clearTimeout(t); drawSubmitTimers.delete(roomId); }
}

function scheduleDrawSubmitTimer(roomId: string) {
  clearDrawSubmitTimer(roomId);
  const room = roomManager.getRoom(roomId);
  if (!room || !room.gameState?.drawState) return;

  const deadline = room.gameState.drawState.drawSubmitDeadline;
  if (!deadline) return;

  const delay = Math.max(0, deadline - Date.now());

  const timer = setTimeout(() => {
    drawSubmitTimers.delete(roomId);
    const r = roomManager.getRoom(roomId);
    if (!r || !r.gameState?.drawState) return;

    const deck = roomManager.getDeck(roomId);
    if (!deck) return;

    // Auto stand-pat for any player who hasn't submitted their draw
    const ds = r.gameState.drawState;
    const pending = r.players.filter(
      (p) => ds.playerStates[p.sessionToken] && !ds.playerStates[p.sessionToken].hasDrawn
    );

    for (const player of pending) {
      console.log(`[draw-timeout] ${player.nick} auto stand-pat in ${roomId}`);
      performDrawDiscard(r, player.sessionToken, [], deck);
      emitSystemMessage(roomId, `⏱ ${player.nick} timed out — stands pat (keeps all cards)`);
    }

    if (pending.length > 0) {
      broadcastRoomState(r);
      progressGame(roomId);
    }
  }, delay + 500);

  drawSubmitTimers.set(roomId, timer);
}

function broadcastRoomState(room: Room) {
  for (const player of room.players) {
    const socketId = sessionToSocket.get(player.sessionToken);
    if (socketId) {
      const sanitized = roomManager.sanitizeRoomForPlayer(room, player.sessionToken);
      io.to(socketId).emit('room:state', sanitized);
    }
  }
}

function sendHoleCards(room: Room) {
  for (const player of room.players) {
    if (!player.holeCards) continue;
    const socketId = sessionToSocket.get(player.sessionToken);
    if (socketId) {
      io.to(socketId).emit('game:your-cards', player.holeCards);
    }
  }
}

function tryStartNextHand(roomId: string): boolean {
  const room = roomManager.getRoom(roomId);
  if (!room) return false;

  const eligible = room.players.filter(
    (p) =>
      p.chips > 0 &&
      p.status !== 'sitting-out' &&
      p.status !== 'disconnected' &&
      p.connected,
  );

  if (eligible.length < 2) {
    if (room.gameState) {
      room.gameState.currentPlayerSeat = null;
      room.gameState.actionDeadline = null;
    }
    broadcastRoomState(room);
    return false;
  }

  try {
    const { deck } = startNewHand(room);
    roomManager.setDeck(roomId, deck);
    broadcastRoomState(room);
    sendHoleCards(room);
    scheduleActionTimer(roomId); // preflop — first to act
    console.log(`[tryStartNextHand] Started hand #${room.gameState?.handNumber} in ${roomId}`);
    return true;
  } catch (err) {
    console.error('[tryStartNextHand]', err);
    return false;
  }
}

/**
 * Helper: emits a system chat message to everyone in the room.
 */
function emitSystemMessage(roomId: string, content: string) {
  const msg = roomManager.addSystemMessage(roomId, content);
  if (msg) {
    io.to(roomId).emit('chat:message', msg);
  }
}

/**
 * Generates a readable system message for a hand result.
 */
function describeHandResult(room: Room): string {
  const result = room.gameState?.lastHandResult;
  if (!result) return '';

  // Drawmaha split pot description
  if (result.drawmahaResult) {
    const { omahaWinner, texasWinner } = result.drawmahaResult;
    const omahaPlayer = room.players.find((p) => p.sessionToken === omahaWinner.sessionToken);
    const texasPlayer = room.players.find((p) => p.sessionToken === texasWinner.sessionToken);
    const omahaNick = omahaPlayer?.nick || '?';
    const texasNick = texasPlayer?.nick || '?';

    if (omahaWinner.sessionToken === texasWinner.sessionToken) {
      return `🎯 ${omahaNick} scooped the pot (${omahaWinner.handDescription} / ${texasWinner.handDescription})`;
    }
    return (
      `🃏 Split pot — ` +
      `${omahaNick} won ${omahaWinner.amount} (Omaha: ${omahaWinner.handDescription}), ` +
      `${texasNick} won ${texasWinner.amount} (Texas: ${texasWinner.handDescription})`
    );
  }

  const parts = result.winnings.map((w) => {
    const player = room.players.find((p) => p.sessionToken === w.sessionToken);
    const nick = player?.nick || '?';
    const hand = w.handDescription ? ` with ${w.handDescription}` : '';
    return `${nick} won ${w.amount}${hand}`;
  });
  return parts.join(', ');
}

// ===== DRAWMAHA: reveal phase sequencer =====

/**
 * Starts the reveal-decide phase for the next player who hasn't decided yet.
 * Sets a 15s auto-reject timer.
 */
function advanceRevealPhase(roomId: string) {
  // Clear any existing timer
  const existingTimer = drawDecideTimers.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    drawDecideTimers.delete(roomId);
  }

  const room = roomManager.getRoom(roomId);
  if (!room || !room.gameState?.drawState) return;

  const nextPlayer = getNextDecidingPlayer(room);

  if (!nextPlayer) {
    // All players decided — advance to turn
    console.log(`[Drawmaha] All reveal decisions done in ${roomId}, advancing to turn`);
    room.gameState.drawState.currentDecidingSeat = null;
    room.gameState.drawState.decideDeadline = null;
    const deck = roomManager.getDeck(roomId);
    if (!deck) return;
    advancePhase(room, deck); // draw → turn
    broadcastRoomState(room);

    const stillCanAct = room.players.filter(
      (p) => p.status === 'playing' && !p.hasActedThisRound,
    );
    if (stillCanAct.length <= 1 && room.gameState.phase !== 'showdown') {
      setTimeout(() => progressGame(roomId), 1500);
    }
    return;
  }

  // Set current deciding seat + 15s deadline
  room.gameState.drawState.currentDecidingSeat = nextPlayer.seat;
  room.gameState.drawState.decideDeadline = Date.now() + 15000;
  broadcastRoomState(room);

  // Emit open card to everyone (table can see it)
  const openCard = room.gameState.drawState.openCards[nextPlayer.sessionToken];
  if (openCard) {
    io.to(roomId).emit('game:draw-open-card', {
      sessionToken: nextPlayer.sessionToken,
      card: openCard,
    });
  }

  console.log(`[Drawmaha] ${nextPlayer.nick} has 15s to decide on open card`);

  // Auto-reject after 15 seconds
  const timer = setTimeout(() => {
    const r = roomManager.getRoom(roomId);
    if (!r || !r.gameState?.drawState) return;
    const ds = r.gameState.drawState.playerStates[nextPlayer.sessionToken];
    if (ds && !ds.hasDecided) {
      console.log(`[Drawmaha] Auto-rejecting for ${nextPlayer.nick} (timeout)`);
      const autoRejectDeck = roomManager.getDeck(roomId);
      if (autoRejectDeck) performDrawDecide(r, nextPlayer.sessionToken, false, autoRejectDeck);
      emitSystemMessage(roomId, `⏱ ${nextPlayer.nick} timed out — open card rejected, drew blind card`);
      advanceRevealPhase(roomId);
    }
  }, 15000);

  drawDecideTimers.set(roomId, timer);
}

function progressGame(roomId: string) {
  const room = roomManager.getRoom(roomId);
  if (!room || !room.gameState) return;

  // ===== DRAWMAHA: draw phase handling =====
  if (room.gameState.phase === 'draw') {
    // Check if all players have submitted their draw
    if (isDrawPhaseComplete(room)) {
      console.log(`[Drawmaha] All draws submitted in ${roomId}, starting reveal phase`);
      advanceRevealPhase(roomId);
    }
    // During draw phase we don't run normal betting logic
    return;
  }

  if (isHandComplete(room) && room.gameState.phase !== 'showdown') {
    const result = finishHand(room);
    room.gameState.lastHandResult = result;
    broadcastRoomState(room);
    io.to(roomId).emit('game:hand-result', result);

    const desc = describeHandResult(room);
    if (desc) emitSystemMessage(roomId, desc);

    clearActionTimer(roomId); // hand over
    setTimeout(() => tryStartNextHand(roomId), 6000);
    return;
  }

  if (isBettingRoundComplete(room)) {
    if (room.gameState.phase === 'river') {
      advancePhase(room, roomManager.getDeck(roomId) || []);
      const result = finishHand(room);
      room.gameState.lastHandResult = result;
      broadcastRoomState(room);
      io.to(roomId).emit('game:hand-result', result);

      const desc = describeHandResult(room);
      if (desc) emitSystemMessage(roomId, desc);

      clearActionTimer(roomId); // hand over
      setTimeout(() => tryStartNextHand(roomId), 6000);
      return;
    }
    const deck = roomManager.getDeck(roomId);
    if (!deck) return;
    advancePhase(room, deck);
    broadcastRoomState(room);
    scheduleActionTimer(roomId); // first player of new round

    // Re-read phase after advancePhase — TypeScript narrows the type incorrectly
    // based on earlier checks, so cast to string to get the actual runtime value.
    const phaseAfterAdvance: string = room.gameState.phase;
    if (phaseAfterAdvance === 'draw') {
      scheduleDrawSubmitTimer(roomId); // auto stand-pat timer for draw phase
      return;
    }

    const stillCanAct = room.players.filter(
      (p) => p.status === 'playing' && !p.hasActedThisRound,
    );
    if (stillCanAct.length <= 1 && room.gameState.phase !== 'showdown') {
      setTimeout(() => progressGame(roomId), 1500);
    }
    return;
  }

  nextPlayer(room);
  broadcastRoomState(room);
  scheduleActionTimer(roomId);
}

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on('room:create', (payload, callback) => {
    try {
      if (!payload.nick || payload.nick.trim().length === 0) {
        return callback({ ok: false, error: 'Please enter a nickname' });
      }
      const { settings } = payload;
      if (settings.smallBlind < 1 || settings.bigBlind < settings.smallBlind * 2) {
        return callback({ ok: false, error: 'Invalid blinds' });
      }
      if (settings.maxSeats < 2 || settings.maxSeats > 9) {
        return callback({ ok: false, error: 'Number of seats must be between 2 and 9' });
      }

      const { room, sessionToken } = roomManager.createRoom(payload.nick, settings);
      socket.data.sessionToken = sessionToken;
      socket.data.roomId = room.id;
      socket.join(room.id);
      sessionToSocket.set(sessionToken, socket.id);

      console.log(`[room:create] ${payload.nick} created room ${room.id}`);
      callback({ ok: true, room, sessionToken });
      broadcastRoomState(room);
      emitSystemMessage(room.id, `${payload.nick.trim()} created the room`);
    } catch (err) {
      console.error('[room:create] error:', err);
      callback({ ok: false, error: 'Server error' });
    }
  });

  socket.on('room:join', (payload, callback) => {
    try {
      if (!payload.roomId || !payload.nick) {
        return callback({ ok: false, error: 'Provide room code and nickname' });
      }
      const result = roomManager.joinRoom(
        payload.roomId.toUpperCase().trim(),
        payload.nick,
        payload.sessionToken,
      );
      if (!result.ok) {
        return callback({ ok: false, error: result.error });
      }
      socket.data.sessionToken = result.sessionToken;
      socket.data.roomId = result.room.id;
      socket.join(result.room.id);
      sessionToSocket.set(result.sessionToken, socket.id);

      const isReconnect = payload.sessionToken === result.sessionToken;
      console.log(`[room:join] ${payload.nick} ${isReconnect ? 'reconnected' : 'joined'} ${result.room.id}`);
      callback({ ok: true, room: result.room, sessionToken: result.sessionToken });
      broadcastRoomState(result.room);

      const player = result.room.players.find((p) => p.sessionToken === result.sessionToken);
      if (player?.holeCards) {
        socket.emit('game:your-cards', player.holeCards);
      }

      if (!isReconnect) {
        emitSystemMessage(result.room.id, `${payload.nick.trim()} joined the room`);
      }
    } catch (err) {
      console.error('[room:join] error:', err);
      callback({ ok: false, error: 'Server error' });
    }
  });

  socket.on('room:leave', () => {
    const sessionToken = socket.data.sessionToken;
    if (!sessionToken) return;
    const roomId = socket.data.roomId;

    const room = roomManager.getRoom(roomId || '');
    const leavingPlayer = room?.players.find((p) => p.sessionToken === sessionToken);
    const leavingNick = leavingPlayer?.nick;

    const result = roomManager.removePlayer(sessionToken);
    sessionToSocket.delete(sessionToken);
    if (result?.room) {
      broadcastRoomState(result.room);
      if (leavingNick) {
        emitSystemMessage(result.roomId, `${leavingNick} left the room`);
      }
    }
    if (roomId) socket.leave(roomId);
    socket.data.sessionToken = undefined;
    socket.data.roomId = undefined;
  });

  socket.on('game:start', (callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player || (player.role !== 'admin' && player.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'Only the admin can start the game' });
    }

    const eligible = room.players.filter((p) => p.chips > 0 && p.connected);
    if (eligible.length < 2) {
      return callback?.({ ok: false, error: 'Need at least 2 players with chips' });
    }

    if (tryStartNextHand(roomId)) {
      emitSystemMessage(roomId, '🎰 Game started');
      callback?.({ ok: true });
    } else {
      callback?.({ ok: false, error: 'Could not start the game' });
    }
  });

  socket.on('game:next-hand', (callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player || (player.role !== 'admin' && player.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'Only the admin can force next hand' });
    }

    const eligible = room.players.filter((p) => p.chips > 0 && p.connected);
    if (eligible.length < 2) {
      return callback?.({ ok: false, error: 'Need at least 2 players with chips' });
    }

    console.log(`[game:next-hand] Admin ${player.nick} forced next hand in ${roomId}`);
    if (tryStartNextHand(roomId)) {
      callback?.({ ok: true });
    } else {
      callback?.({ ok: false, error: 'Could not start the next hand' });
    }
  });

  socket.on('game:action', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    clearActionTimer(roomId); // player acted — cancel auto-action timer
    const result = performAction(room, sessionToken, payload.action, payload.amount);
    if (!result.ok) {
      return callback?.({ ok: false, error: result.error });
    }
    callback?.({ ok: true });
    progressGame(roomId);
  });

  // ===== DRAWMAHA: Draw phase — submit discard =====
  socket.on('game:draw-discard', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const deck = roomManager.getDeck(roomId);
    if (!deck) return callback?.({ ok: false, error: 'No deck' });

    const result = performDrawDiscard(room, sessionToken, payload.discardIndices, deck);
    if (!result.ok) {
      return callback?.({ ok: false, error: result.error });
    }

    // Send updated hole cards privately to this player
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (player?.holeCards) {
      socket.emit('game:your-cards', player.holeCards);
    }

    // System message: how many cards the player exchanged
    const discardCount = payload.discardIndices.length;
    const playerForMsg = room.players.find((p) => p.sessionToken === sessionToken);
    if (playerForMsg) {
      if (discardCount === 0) {
        emitSystemMessage(roomId, `🂠 ${playerForMsg.nick} stands pat (keeps all 5 cards)`);
      } else if (discardCount === 1) {
        emitSystemMessage(roomId, `🂠 ${playerForMsg.nick} exchanges 1 card — open card revealed`);
      } else {
        emitSystemMessage(roomId, `🂠 ${playerForMsg.nick} exchanges ${discardCount} cards`);
      }
    }

    callback?.({ ok: true });
    broadcastRoomState(room);

    // Check if all players have drawn
    progressGame(roomId);
  });

  // ===== DRAWMAHA: Reveal phase — accept or reject open card =====
  socket.on('game:draw-decide', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const decideDeck = roomManager.getDeck(roomId);
    if (!decideDeck) return callback?.({ ok: false, error: 'No deck' });
    const result = performDrawDecide(room, sessionToken, payload.accept, decideDeck);
    if (!result.ok) {
      return callback?.({ ok: false, error: result.error });
    }

    // Clear decide timer
    const timer = drawDecideTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      drawDecideTimers.delete(roomId);
    }

    // Always send updated hole cards — both accept (open card added) and
    // reject (blind card drawn) change the player's hand to 5 cards.
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (player?.holeCards) {
      socket.emit('game:your-cards', player.holeCards);
    }

    const action = payload.accept
      ? `✅ ${player?.nick} accepted the open card`
      : `🂠 ${player?.nick} rejected the open card — drew a blind card instead`;
    emitSystemMessage(roomId, action);

    callback?.({ ok: true });
    broadcastRoomState(room);

    // Move to next player or advance phase
    advanceRevealPhase(roomId);
  });

  socket.on('game:sit-out', () => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return;

    if (
      room.gameState?.currentPlayerSeat === player.seat &&
      player.status === 'playing'
    ) {
      performAction(room, sessionToken, 'fold');
      player.status = 'sitting-out';
      broadcastRoomState(room);
      progressGame(roomId);
    } else {
      if (player.status === 'playing' || player.status === 'waiting' || player.status === 'no-chips') {
        player.status = 'sitting-out';
      }
      broadcastRoomState(room);
    }
    emitSystemMessage(roomId, `${player.nick} is sitting out`);
  });

  socket.on('game:sit-back', () => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return;
    if (player.status === 'sitting-out') {
      player.status = player.chips > 0 ? 'waiting' : 'no-chips';
      broadcastRoomState(room);
      emitSystemMessage(roomId, `${player.nick} is back`);
    }
  });

  socket.on('game:take-seat', (callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return callback?.({ ok: false, error: 'Player not found' });

    if (player.status !== 'spectator') {
      return callback?.({ ok: false, error: 'Already at the table' });
    }

    player.status = player.chips > 0 ? 'waiting' : 'no-chips';
    console.log(`[game:take-seat] ${player.nick} took a seat in ${roomId}`);
    broadcastRoomState(room);
    callback?.({ ok: true });
    emitSystemMessage(roomId, `${player.nick} took a seat at the table`);
  });

  socket.on('game:set-variant', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return callback?.({ ok: false, error: 'Player not found' });

    const allowed: GameVariant[] = ['texas', 'omaha', 'drawmaha'];
    if (!allowed.includes(payload.variant)) {
      return callback?.({ ok: false, error: 'Unknown variant' });
    }

    player.preferredVariant = payload.variant;
    console.log(`[game:set-variant] ${player.nick} set variant to ${payload.variant}`);
    broadcastRoomState(room);
    callback?.({ ok: true });
  });

  socket.on('admin:add-chips', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const admin = room.players.find((p) => p.sessionToken === sessionToken);
    if (!admin || (admin.role !== 'admin' && admin.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'No permission' });
    }

    if (payload.amount <= 0) {
      return callback?.({ ok: false, error: 'Amount must be positive' });
    }

    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    if (!target) return callback?.({ ok: false, error: 'Player not found' });

    target.chips += payload.amount;
    target.totalBuyIn += payload.amount; // track for session summary
    if (target.status === 'no-chips' || target.status === 'spectator') {
      target.status = 'waiting';
    }

    console.log(`[admin:add-chips] +${payload.amount} for ${target.nick}`);
    broadcastRoomState(room);
    callback?.({ ok: true });
    emitSystemMessage(roomId, `${admin.nick} added ${payload.amount} chips to ${target.nick}`);

    const gameHalted =
      room.gameState !== null &&
      room.gameState.currentPlayerSeat === null &&
      room.gameState.phase === 'showdown';

    if (gameHalted) {
      const eligible = room.players.filter(
        (p) =>
          p.chips > 0 &&
          p.status !== 'sitting-out' &&
          p.status !== 'disconnected' &&
          p.connected,
      );
      if (eligible.length >= 2) {
        console.log(`[admin:add-chips] Resuming game after chip add in ${roomId}`);
        setTimeout(() => tryStartNextHand(roomId), 1500);
      }
    }
  });

  socket.on('admin:remove-chips', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const admin = room.players.find((p) => p.sessionToken === sessionToken);
    if (!admin || (admin.role !== 'admin' && admin.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'No permission' });
    }

    if (payload.amount <= 0) {
      return callback?.({ ok: false, error: 'Amount must be positive' });
    }

    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    if (!target) return callback?.({ ok: false, error: 'Player not found' });

    if (room.gameState && (target.status === 'playing' || target.status === 'all-in')) {
      return callback?.({
        ok: false,
        error: 'Cannot remove chips from active player during a hand. Wait for the hand to finish.',
      });
    }

    const actualRemoved = Math.min(payload.amount, target.chips);
    target.chips -= actualRemoved;
    if (target.chips <= 0 && target.status === 'waiting') {
      target.status = 'no-chips';
    }

    console.log(`[admin:remove-chips] -${actualRemoved} from ${target.nick}`);
    broadcastRoomState(room);
    callback?.({ ok: true });
    emitSystemMessage(roomId, `${admin.nick} removed ${actualRemoved} chips from ${target.nick}`);
  });

  socket.on('admin:remove-player', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const admin = room.players.find((p) => p.sessionToken === sessionToken);
    if (!admin || (admin.role !== 'admin' && admin.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'No permission' });
    }

    if (payload.targetSessionToken === sessionToken) {
      return callback?.({ ok: false, error: "You can't remove yourself" });
    }

    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    const targetNick = target?.nick;

    const targetSocketId = sessionToSocket.get(payload.targetSessionToken);
    if (targetSocketId) {
      io.to(targetSocketId).emit('room:closed', 'You have been removed from the room by the admin');
    }

    const result = roomManager.removePlayer(payload.targetSessionToken);
    sessionToSocket.delete(payload.targetSessionToken);
    if (result?.room) {
      broadcastRoomState(result.room);
      if (targetNick) {
        emitSystemMessage(result.roomId, `${admin.nick} removed ${targetNick} from the room`);
      }
    }
    callback?.({ ok: true });
  });

  socket.on('chat:send', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) {
      return callback?.({ ok: false, error: 'No session' });
    }

    if (payload.type !== 'text' && payload.type !== 'reaction') {
      return callback?.({ ok: false, error: 'Invalid message type' });
    }

    const result = roomManager.addChatMessage(sessionToken, payload.type, payload.content);
    if (!result.ok) {
      return callback?.({ ok: false, error: result.error });
    }

    io.to(roomId).emit('chat:message', result.message);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const sessionToken = socket.data.sessionToken;
    if (!sessionToken) return;
    sessionToSocket.delete(sessionToken);
    const result = roomManager.disconnectPlayer(sessionToken);
    if (result) {
      broadcastRoomState(result.room);
      if (result.room.gameState) {
        progressGame(result.roomId);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`🎰 Poker backend running on http://localhost:${PORT}`);
  console.log(`📡 Accepting connections from: ${FRONTEND_URL}`);
});
