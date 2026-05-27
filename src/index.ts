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
  res.json({ status: 'ok', service: 'poker-backend', version: '0.4.0' });
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  httpServer,
  { cors: { origin: FRONTEND_URL, credentials: true } },
);

const sessionToSocket = new Map<string, string>();

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

  const parts = result.winnings.map((w) => {
    const player = room.players.find((p) => p.sessionToken === w.sessionToken);
    const nick = player?.nick || '?';
    const hand = w.handDescription ? ` with ${w.handDescription}` : '';
    return `${nick} won ${w.amount}${hand}`;
  });
  return parts.join(', ');
}

function progressGame(roomId: string) {
  const room = roomManager.getRoom(roomId);
  if (!room || !room.gameState) return;

  if (isHandComplete(room) && room.gameState.phase !== 'showdown') {
    const result = finishHand(room);
    room.gameState.lastHandResult = result;
    broadcastRoomState(room);
    io.to(roomId).emit('game:hand-result', result);

    // System message
    const desc = describeHandResult(room);
    if (desc) emitSystemMessage(roomId, desc);

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

      setTimeout(() => tryStartNextHand(roomId), 6000);
      return;
    }
    const deck = roomManager.getDeck(roomId);
    if (!deck) return;
    advancePhase(room, deck);
    broadcastRoomState(room);

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

    const result = performAction(room, sessionToken, payload.action, payload.amount);
    if (!result.ok) {
      return callback?.({ ok: false, error: result.error });
    }
    callback?.({ ok: true });
    progressGame(roomId);
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

  // Spectator → take a seat. Promotes them to 'no-chips' or 'waiting' depending on
  // whether they have chips already (e.g. on reconnect they might).
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

  // Dealer's Choice — set preferred variant for when this player is dealer
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
    // Promote to 'waiting' if the player has no chips or is just a spectator
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

  // ===== CHAT =====
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
