import { decideBotAction, getBotNick } from './bot.js';
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
  performPineappleDiscard,
  isPineappleDiscardComplete,
  initPineappleDiscardState,
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
// Allow both http and https, and pokero.pl variants
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  'https://pokero.pl',
  'https://www.pokero.pl',
  'http://localhost:3000',
];

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'poker-backend', version: '0.5.0' });
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  httpServer,
  {
    cors: { origin: ALLOWED_ORIGINS, credentials: true },
    // Increase ping timeouts — default 20s too short for mobile/free-tier latency
    pingTimeout: 60000,   // 60s before declaring socket dead
    pingInterval: 25000,  // check every 25s
    // Allow bigger payloads (room state with many players)
    maxHttpBufferSize: 1e6,
  },
);

const sessionToSocket = new Map<string, string>();

// Room expiry — clean up inactive rooms every 30 minutes
// Prevents memory leak on Railway free tier (512MB RAM)
const ROOM_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [roomId, room] of (roomManager as any).rooms.entries()) {
    const lastActivity = room.players.reduce(
      (max: number, p: any) => Math.max(max, p.lastSeenAt || 0), room.createdAt || 0
    );
    if (now - lastActivity > ROOM_EXPIRY_MS && room.players.every((p: any) => !p.connected)) {
      (roomManager as any).rooms.delete(roomId);
      (roomManager as any).decks?.delete(roomId);
      cleaned++;
      console.log(`[cleanup] Expired room ${roomId}`);
    }
  }
  if (cleaned > 0) console.log(`[cleanup] Removed ${cleaned} expired rooms`);
}, 30 * 60 * 1000); // run every 30 minutes

// Bot action timers
const botTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleBotAction(roomId: string) {
  if (botTimers.has(roomId)) return; // already scheduled
  const room = roomManager.getRoom(roomId);
  if (!room?.gameState) return;

  const currentSeat = room.gameState.currentPlayerSeat;
  if (!currentSeat) return;
  const currentPlayer = room.players.find((p) => p.seat === currentSeat);
  if (!currentPlayer || !(currentPlayer as any).isBot) return;

  // Random delay 1.2–2.5s to feel natural
  const delay = 1200 + Math.floor(Math.random() * 1300);
  const timer = setTimeout(() => {
    botTimers.delete(roomId);
    const r = roomManager.getRoom(roomId);
    if (!r?.gameState) return;
    // Re-check it's still bot's turn
    const bot = r.players.find(
      (p) => (p as any).isBot && p.seat === r.gameState!.currentPlayerSeat && p.status === 'playing'
    );
    if (!bot) return;

    const decision = decideBotAction(r);
    if (!decision) return;

    console.log(`[Bot] ${bot.nick} → ${decision.action}${decision.amount ? ' ' + decision.amount : ''}`);
    const result = performAction(r, bot.sessionToken, decision.action, decision.amount);
    if (!result.ok) {
      // Fallback: check or fold
      const fallback = r.gameState!.currentBet > bot.currentBet ? 'fold' : 'check';
      performAction(r, bot.sessionToken, fallback);
    }
    broadcastRoomState(r);
    withRoomLock(roomId, () => progressGame(roomId));
  }, delay);

  botTimers.set(roomId, timer);
}

// Per-room processing queue — prevents concurrent progressGame calls
// that could corrupt game state (action timer fires same time as player action)
const roomProcessing = new Map<string, boolean>();

function withRoomLock(roomId: string, fn: () => void): void {
  if (roomProcessing.get(roomId)) {
    // Already processing — queue this call for after current finishes
    setImmediate(() => withRoomLock(roomId, fn));
    return;
  }
  roomProcessing.set(roomId, true);
  try {
    fn();
  } finally {
    roomProcessing.delete(roomId);
  }
}

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
  if (!currentPlayerSeat || !actionDeadline || phase === 'showdown' || phase === 'pineapple-discard' || phase === 'draw') return;

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
const pineappleDiscardTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Player stats update ──────────────────────────────────────────────────
function updatePlayerStats(room: Room, result: import('./types.js').HandResult): void {
  if (!room.gameState) return;
  const activePlayers = room.players.filter(
    (p) => p.status !== 'spectator'
  );

  // Track each active player
  for (const player of activePlayers) {
    const token = player.sessionToken;
    if (!room.playerStats[token]) {
      room.playerStats[token] = {
        sessionToken: token,
        nick: player.nick,
        handsPlayed: 0,
        handsWon: 0,
        vpip: 0,
        vpipHands: 0,
        biggestPot: 0,
        biggestPotHand: '',
        totalWon: 0,
        bestHand: '',
        allInCount: 0,
        foldCount: 0,
      };
    }
    const stats = room.playerStats[token];
    stats.nick = player.nick; // keep nick updated

    // Count hand
    if (player.status === 'playing' || player.status === 'all-in' ||
        player.status === 'folded' || player.totalBetInHand > 0) {
      stats.handsPlayed++;
    }

    // VPIP: player voluntarily put chips in preflop (not just BB check)
    if (player.totalBetInHand > 0 && player.status !== 'no-chips') {
      stats.vpipHands++;
    }
    if (stats.handsPlayed > 0) {
      stats.vpip = Math.round((stats.vpipHands / stats.handsPlayed) * 100);
    }

    // Status tracking
    if (player.status === 'folded') stats.foldCount++;
    if (player.status === 'all-in') stats.allInCount++;
  }

  // Winnings
  for (const w of result.winnings) {
    const stats = room.playerStats[w.sessionToken];
    if (!stats) continue;
    stats.handsWon++;
    const net = w.netAmount ?? w.amount;
    stats.totalWon += net;
    if (w.amount > stats.biggestPot) {
      stats.biggestPot = w.amount;
      stats.biggestPotHand = w.handDescription ?? '';
    }
  }

  // Best hand from showdown
  for (const sc of result.showdownCards) {
    const stats = room.playerStats[sc.sessionToken];
    if (!stats) continue;
    // Simple hand rank ordering
    // Note: pokersolver reports Royal Flush as "Straight Flush, As High"
    // (no separate "Royal Flush" name), so we only use Straight Flush here.
    const HAND_RANK: Record<string, number> = {
      'Straight Flush': 8, 'Four of a Kind': 7,
      'Full House': 6, 'Flush': 5, 'Straight': 4,
      'Three of a Kind': 3, 'Two Pair': 2, 'Pair': 1, 'High Card': 0,
    };
    const currentRank = HAND_RANK[stats.bestHand?.split(',')[0]] ?? -1;
    const newRank = HAND_RANK[sc.handName?.split(',')[0]] ?? -1;
    if (newRank > currentRank) {
      stats.bestHand = sc.handName ?? '';
    }
  }
}

// Grace period before folding a disconnected player
// Mobile connections often drop briefly (iOS background, network switch)
const DISCONNECT_GRACE_MS = 30_000; // 30 seconds
const disconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

function clearPineappleDiscardTimer(roomId: string) {
  const t = pineappleDiscardTimers.get(roomId);
  if (t) { clearTimeout(t); pineappleDiscardTimers.delete(roomId); }
}

function schedulePineappleDiscardTimer(roomId: string) {
  clearPineappleDiscardTimer(roomId);
  const room = roomManager.getRoom(roomId);
  if (!room || !room.gameState?.pineappleDiscardState) return;

  const deadline = room.gameState.pineappleDiscardState.discardDeadline;
  if (!deadline) return;

  const delay = Math.max(0, deadline - Date.now());

  const timer = setTimeout(() => {
    pineappleDiscardTimers.delete(roomId);
    const r = roomManager.getRoom(roomId);
    if (!r || r.gameState?.phase !== 'pineapple-discard' || !r.gameState?.pineappleDiscardState) return;

    const ds = r.gameState.pineappleDiscardState;
    const pending = r.players.filter(
      (p) => ds.playerStates[p.sessionToken] && !ds.playerStates[p.sessionToken].hasDiscarded
    );

    for (const player of pending) {
      console.log(`[pineapple-timeout] ${player.nick} auto-discards last card in ${roomId}`);
      // Auto-discard last card (index 2)
      const result = performPineappleDiscard(r, player.sessionToken, 2);
      if (!result.ok) console.error(`[pineapple-timeout] Discard failed: ${result.error}`);
      emitSystemMessage(roomId, `⏱ ${player.nick} timed out — last card discarded`);
    }

    if (pending.length > 0) {
      broadcastRoomState(r);
      progressGame(roomId);
    }
  }, delay + 500);

  pineappleDiscardTimers.set(roomId, timer);
}


function applyPendingChips(room: Room) {
  let applied = false;
  for (const player of room.players) {
    const pending = player.pendingChipsAdjustment || 0;
    if (pending !== 0) {
      const adjustment = pending > 0
        ? pending
        : Math.max(-player.chips, pending); // can't go below 0
      player.chips = Math.max(0, player.chips + adjustment);
      player.totalBuyIn += Math.max(0, pending);
      player.pendingChipsAdjustment = 0;
      if (player.chips > 0 && (player.status === 'no-chips' || player.status === 'waiting')) {
        player.status = 'waiting';
      }
      applied = true;
    }
  }
  return applied;
}

function broadcastRoomState(room: Room) {
  // Schedule bot action if it's a bot's turn
  scheduleBotAction(room.id);
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

  // Guard: don't start a new hand if one is already in progress (not in showdown/null)
  if (room.gameState && room.gameState.phase !== 'showdown') {
    console.log(`[tryStartNextHand] Skipped — hand already in progress (phase=${room.gameState.phase})`);
    return false;
  }

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
    // Apply pending sit-outs before starting new hand
    for (const p of room.players) {
      if ((p as any).pendingSitOut) {
        p.status = 'sitting-out';
        (p as any).pendingSitOut = false;
      }
    }
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

  // Omaha Hi-Lo description
  if (result.omahaHlResult) {
    const { highWinners, lowWinners, noLow } = result.omahaHlResult;
    const nick = (token: string) => room.players.find((p) => p.sessionToken === token)?.nick ?? '?';

    if (noLow || !lowWinners) {
      const names = highWinners.map((w) => nick(w.sessionToken)).join(' & ');
      return `🏆 No qualifying low — ${names} wins (${highWinners[0]?.handDescription ?? ''})`;
    }

    // Check scoop: same player(s) in both high and low
    const highTokens = new Set(highWinners.map((w) => w.sessionToken));
    const lowTokens = new Set(lowWinners.map((w) => w.sessionToken));
    const scoopTokens = [...highTokens].filter((t) => lowTokens.has(t));
    if (scoopTokens.length === highTokens.size && scoopTokens.length === lowTokens.size) {
      const names = scoopTokens.map(nick).join(' & ');
      return `🎯 ${names} scooped (High: ${highWinners[0].handDescription} | Low: ${lowWinners[0].handDescription})`;
    }

    const highNames = highWinners.map((w) => nick(w.sessionToken)).join(' & ');
    const lowNames = lowWinners.map((w) => nick(w.sessionToken)).join(' & ');
    return (
      `🃏 Hi-Lo split — High: ${highNames} (${highWinners[0].handDescription}) | Low: ${lowNames} (${lowWinners[0].handDescription})`
    );
  }

  const parts = result.winnings.map((w) => {
    const player = room.players.find((p) => p.sessionToken === w.sessionToken);
    const nick = player?.nick || '?';
    const hand = w.handDescription ? ` with ${w.handDescription}` : '';
    return `${nick} won ${w.netAmount ?? w.amount}${hand}`;
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
      const playingCount = room.players.filter((p) => p.status === 'playing').length;
      const allInCount = room.players.filter((p) => p.status === 'all-in').length;

      // Full runout: everyone is all-in
      const fullAllInRunout = playingCount === 0 && allInCount >= 2;
      // Caller runout: one player called but didn't go all-in, opponents are all-in
      // That player has no one to bet against — auto-check and reveal cards
      const lastManRunout = playingCount === 1 && allInCount >= 1;
      const isRunout = fullAllInRunout || lastManRunout;

      if (isRunout) {
        room.gameState.currentPlayerSeat = null;
        room.gameState.actionDeadline = null;

        // Auto-check the last 'playing' player so betting round completes cleanly
        if (lastManRunout) {
          const lastPlayer = room.players.find((p) => p.status === 'playing');
          if (lastPlayer) lastPlayer.hasActedThisRound = true;
        }

        // Reveal all active players' hole cards
        // Exception: Drawmaha never reveals mid-hand (split pot + draw phase confusion)
        const isDrawmaha = room.gameState.variant === 'drawmaha' || room.gameState.variant === 'drawmaha-pl';
        if (!isDrawmaha) {
          const revealPayload = room.players
            .filter((p) => (p.status === 'all-in' || p.status === 'playing') && p.holeCards)
            .map((p) => ({ sessionToken: p.sessionToken, nick: p.nick, cards: p.holeCards! }));
          if (revealPayload.length >= 2) {
            io.to(roomId).emit('game:all-in-reveal', revealPayload);
          }
        }
        broadcastRoomState(room);
      }

      const delay = isRunout ? 3500 : 1500;
      setTimeout(() => progressGame(roomId), delay);
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

  // ===== PINEAPPLE CLASSIC: pineapple-discard phase handling =====
  if (room.gameState.phase === 'pineapple-discard') {
    if (isPineappleDiscardComplete(room)) {
      const deck2 = roomManager.getDeck(roomId) || [];
      advancePhase(room, deck2);
      broadcastRoomState(room);
      scheduleActionTimer(roomId);
    }
    // During discard phase we don't run normal betting logic
    return;
  }

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
    updatePlayerStats(room, result);
    broadcastRoomState(room);
    io.to(roomId).emit('game:hand-result', result);

    const desc = describeHandResult(room);
    if (desc) emitSystemMessage(roomId, desc);

    clearActionTimer(roomId); // hand over
    const resultDelay1 = (room.gameState.variant === 'drawmaha' || room.gameState.variant === 'drawmaha-pl') ? 9000 : 6000;
    setTimeout(() => {
      const r = roomManager.getRoom(roomId);
      if (r && applyPendingChips(r)) broadcastRoomState(r);
      tryStartNextHand(roomId);
    }, resultDelay1);
    return;
  }

  if (isBettingRoundComplete(room)) {
    if (room.gameState.phase === 'river') {
      advancePhase(room, roomManager.getDeck(roomId) || []);
      const result = finishHand(room);
      room.gameState.lastHandResult = result;
      updatePlayerStats(room, result);
      broadcastRoomState(room);
      io.to(roomId).emit('game:hand-result', result);

      const desc = describeHandResult(room);
      if (desc) emitSystemMessage(roomId, desc);

      clearActionTimer(roomId); // hand over
      const resultDelay2 = (room.gameState.variant === 'drawmaha' || room.gameState.variant === 'drawmaha-pl') ? 9000 : 6000;
      setTimeout(() => {
        const r = roomManager.getRoom(roomId);
        if (r && applyPendingChips(r)) broadcastRoomState(r);
        tryStartNextHand(roomId);
      }, resultDelay2);
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
    if (phaseAfterAdvance === 'pineapple-discard') {
      schedulePineappleDiscardTimer(roomId); // auto-discard last card if player times out
      return;
    }

    const stillCanAct = room.players.filter(
      (p) => p.status === 'playing' && !p.hasActedThisRound,
    );
    // Draw phase is already handled above (scheduleDrawSubmitTimer) — never skip it
    // even during all-in runout. All players participate in the draw.
    if (stillCanAct.length <= 1 && room.gameState.phase !== 'showdown' && (room.gameState.phase as string) !== 'draw') {
      // All-in runout: detect if ALL remaining players are all-in (no one can act).
      // Use a dramatic delay so players can see each street reveal.
      // Normal all-in situations (1 player can still act) get standard delay.
      const playingCount = room.players.filter((p) => p.status === 'playing').length;
      const allInCount = room.players.filter((p) => p.status === 'all-in').length;

      // Full runout: everyone is all-in
      const fullAllInRunout = playingCount === 0 && allInCount >= 2;
      // Caller runout: one player called but didn't go all-in, opponents are all-in
      // That player has no one to bet against — auto-check and reveal cards
      const lastManRunout = playingCount === 1 && allInCount >= 1;
      const isRunout = fullAllInRunout || lastManRunout;

      if (isRunout) {
        room.gameState.currentPlayerSeat = null;
        room.gameState.actionDeadline = null;

        // Auto-check the last 'playing' player so betting round completes cleanly
        if (lastManRunout) {
          const lastPlayer = room.players.find((p) => p.status === 'playing');
          if (lastPlayer) lastPlayer.hasActedThisRound = true;
        }

        // Reveal all active players' hole cards
        // Exception: Drawmaha never reveals mid-hand (split pot + draw phase confusion)
        const isDrawmaha = room.gameState.variant === 'drawmaha' || room.gameState.variant === 'drawmaha-pl';
        if (!isDrawmaha) {
          const revealPayload = room.players
            .filter((p) => (p.status === 'all-in' || p.status === 'playing') && p.holeCards)
            .map((p) => ({ sessionToken: p.sessionToken, nick: p.nick, cards: p.holeCards! }));
          if (revealPayload.length >= 2) {
            io.to(roomId).emit('game:all-in-reveal', revealPayload);
          }
        }
        broadcastRoomState(room);
      }

      const delay = isRunout ? 3500 : 1500;
      setTimeout(() => progressGame(roomId), delay);
    }
    return;
  }

  nextPlayer(room);

  // Fire pre-action if the new current player had one queued
  const newCurrentPlayer = room.players.find(
    (p) => p.seat === room.gameState?.currentPlayerSeat && p.pendingAction
  );
  if (newCurrentPlayer && newCurrentPlayer.pendingAction) {
    const preAction = newCurrentPlayer.pendingAction;
    newCurrentPlayer.pendingAction = null;
    const toCall = (room.gameState?.currentBet ?? 0) - newCurrentPlayer.currentBet;
    if (preAction === 'fold') {
      performAction(room, newCurrentPlayer.sessionToken, 'fold');
      emitSystemMessage(roomId, `${newCurrentPlayer.nick} folded (pre-action)`);
    } else if (preAction === 'check-fold') {
      if (toCall === 0) {
        performAction(room, newCurrentPlayer.sessionToken, 'check');
        emitSystemMessage(roomId, `${newCurrentPlayer.nick} checked (pre-action)`);
      } else {
        performAction(room, newCurrentPlayer.sessionToken, 'fold');
        emitSystemMessage(roomId, `${newCurrentPlayer.nick} folded (pre-action — had to call ${toCall})`);
      }
    }
    broadcastRoomState(room);
    progressGame(roomId);
    return;
  }

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

      // Cancel any pending grace-period fold timer for this player
      if (isReconnect && result.sessionToken) {
        const graceTimer = disconnectGraceTimers.get(result.sessionToken);
        if (graceTimer) {
          clearTimeout(graceTimer);
          disconnectGraceTimers.delete(result.sessionToken);
          console.log(`[reconnect] ${payload.nick} reconnected within grace period — fold cancelled`);
        }
        // Restore status if they were folded prematurely (shouldn't happen with grace period,
        // but as a safety net: if player reconnects and was playing before disconnect)
        const player = result.room.players.find((p) => p.sessionToken === result.sessionToken);
        if (player) {
          player.connected = true;
          // If they reconnect during an active hand and their turn hasn't come yet, restore
          if (result.room.gameState?.phase && player.status === 'disconnected') {
            player.status = 'waiting';
          }
        }
      }

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

    // If player is leaving during an active hand and has a live bet (e.g. blind),
    // fold them first so their currentBet gets collected into the pot correctly.
    if (room?.gameState && leavingPlayer) {
      const isInHand = leavingPlayer.status === 'playing' || leavingPlayer.status === 'all-in';
      if (isInHand) {
        performAction(room, sessionToken, 'fold');
        // If their fold ends the hand, run progressGame to settle the pot
        if (isHandComplete(room)) {
          // Let progressGame handle finishHand via its normal path.
          // Calling finishHand directly here would race with the existing
          // progressGame timeout and potentially start two hands.
          progressGame(roomId!);
        }
      }
    }

    // Clear any pending disconnect grace timer — player is leaving voluntarily
    const graceTimer = disconnectGraceTimers.get(sessionToken);
    if (graceTimer) {
      clearTimeout(graceTimer);
      disconnectGraceTimers.delete(sessionToken);
    }

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
    if (room.paused) {
      return callback?.({ ok: false, error: '⏸ Game is paused by admin' });
    }
    const result = performAction(room, sessionToken, payload.action, payload.amount);
    if (!result.ok) {
      return callback?.({ ok: false, error: result.error });
    }
    callback?.({ ok: true });
    withRoomLock(roomId, () => progressGame(roomId));
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

    const isInActiveHand = room.gameState && (player.status === 'playing' || player.status === 'all-in');

    if (isInActiveHand) {
      // Always queue — never fold mid-hand on sit-out request
      // Player finishes current hand, then sits out before next hand starts
      (player as any).pendingSitOut = true;
      broadcastRoomState(room);
      emitSystemMessage(roomId, `${player.nick} will sit out after this hand`);
    } else {
      // Not in a hand — sit out immediately
      if (player.status === 'waiting' || player.status === 'no-chips') {
        player.status = 'sitting-out';
        emitSystemMessage(roomId, `${player.nick} is sitting out`);
      }
      broadcastRoomState(room);
    }
  });

  socket.on('game:sit-back', () => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return;
    if ((player as any).pendingSitOut) {
      // Cancel pending sit-out (player is still in the hand)
      (player as any).pendingSitOut = false;
      broadcastRoomState(room);
      emitSystemMessage(roomId, `${player.nick} cancelled sit-out`);
    } else if (player.status === 'sitting-out') {
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

    const allowed: GameVariant[] = ['texas', 'omaha', 'omaha-pl', 'omaha5', 'omaha-hl', 'drawmaha', 'drawmaha-pl', 'pineapple', 'pineapple-classic'];
    if (!allowed.includes(payload.variant)) {
      return callback?.({ ok: false, error: 'Unknown variant' });
    }

    player.preferredVariant = payload.variant;
    console.log(`[game:set-variant] ${player.nick} set variant to ${payload.variant}`);
    broadcastRoomState(room);
    callback?.({ ok: true });
  });

  // Admin: force advance to next hand — returns pot to active players, starts fresh
  // Player requests chips from admin (when at 0 chips)
  // Create a room pre-populated with bots for testing
  socket.on('room:create-with-bot', (payload: { nick: string; botCount?: number }, callback) => {
    try {
      const nick = payload.nick?.trim();
      if (!nick || nick.length < 2) return callback({ ok: false, error: 'Nick too short' });

      const botCount = Math.min(payload.botCount ?? 8, 8);
      const { room, sessionToken } = roomManager.createRoom(nick, {
        startingBuyIn: 1000,
        smallBlind: 5,
        bigBlind: 10,
        actionTimeoutSec: 30,
        maxSeats: 9,
      });

      socket.data.sessionToken = sessionToken;
      socket.data.roomId = room.id;
      socket.join(room.id);

      // Add bots
      for (let i = 0; i < botCount; i++) {
        const botNick = getBotNick();
        roomManager.createBotPlayer(room.id, botNick, 1000);
      }

      broadcastRoomState(room);
      console.log(`[Bot room] ${nick} created room ${room.id} with ${botCount} bots`);
      callback({ ok: true, roomId: room.id, sessionToken });
    } catch (err) {
      console.error('[room:create-with-bot]', err);
      callback({ ok: false, error: 'Server error' });
    }
  });

  socket.on('game:request-chips', (payload: { amount: number }, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback({ ok: false, error: 'Room not found' });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return callback({ ok: false, error: 'Player not found' });
    if (player.chips > 0) return callback({ ok: false, error: 'You still have chips' });
    const amount = Math.floor(payload.amount);
    if (amount < 1 || amount > 100000) return callback({ ok: false, error: 'Invalid amount' });
    player.chipRequest = amount;
    broadcastRoomState(room);
    emitSystemMessage(roomId, `🪙 ${player.nick} requests ${amount} chips`);
    callback({ ok: true });
  });

  socket.on('game:cancel-chip-request', (_payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback({ ok: false });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback({ ok: false });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (player) { player.chipRequest = undefined; broadcastRoomState(room); }
    callback({ ok: true });
  });

  socket.on('admin:decline-chip-request', (payload: { targetSessionToken: string }, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback?.({ ok: false });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false });
    const isAdm = room.players.some((p) => p.sessionToken === sessionToken && p.role === 'admin');
    if (!isAdm) return callback?.({ ok: false });
    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    if (target) { target.chipRequest = undefined; broadcastRoomState(room); }
    callback?.({ ok: true });
  });

  socket.on('admin:approve-chip-request', (payload: { targetSessionToken: string }, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback({ ok: false, error: 'Room not found' });
    const isAdm = room.players.some((p) => p.sessionToken === sessionToken && p.role === 'admin');
    if (!isAdm) return callback({ ok: false, error: 'Not admin' });
    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    if (!target) return callback({ ok: false, error: 'Player not found' });
    const amount = target.chipRequest;
    if (!amount) return callback({ ok: false, error: 'No request pending' });
    target.chips += amount;
    target.totalBuyIn += amount;
    target.chipRequest = undefined;
    if (target.status === 'sitting-out' && target.chips > 0) target.status = 'waiting';
    broadcastRoomState(room);
    emitSystemMessage(roomId, `✅ ${target.nick} received ${amount} chips`);
    callback({ ok: true });
  });

  socket.on('admin:force-next-hand', (_payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback({ ok: false, error: 'Room not found' });
    const isAdm = room.players.some((p) => p.sessionToken === sessionToken && p.role === 'admin');
    if (!isAdm) return callback({ ok: false, error: 'Not admin' });

    // Clear all pending timers
    clearActionTimer(roomId);
    clearDrawSubmitTimer(roomId);
    const decideTimer = drawDecideTimers.get(roomId);
    if (decideTimer) { clearTimeout(decideTimer); drawDecideTimers.delete(roomId); }

    if (room.gameState) {
      // Return exactly what each player invested this hand.
      // handContribution tracks every chip taken from each player across all streets.
      // It already includes currentBet (incremented at bet-time, before collectBets).
      // So we ONLY return handContribution — not currentBet separately (double count!)
      // and NOT the pot separately (pot was built FROM handContributions — double count!)
      const totalHandContributions = room.players.reduce(
        (s, p) => s + (p.handContribution || 0), 0
      );

      if (totalHandContributions > 0) {
        // Normal case: tracking is active, return exactly what each player put in
        for (const p of room.players) {
          p.chips += (p.handContribution || 0);
          p.currentBet = 0;
          p.handContribution = 0;
        }
      } else {
        // Fallback: first hand after deploy (no tracking yet) — equal split of pot
        for (const p of room.players) {
          p.currentBet = 0;
          p.handContribution = 0;
        }
        const totalPot =
          room.gameState.pot +
          room.gameState.sidePots.reduce((s, sp) => s + sp.amount, 0);
        if (totalPot > 0) {
          const seated = room.players.filter((p) => p.status !== 'spectator');
          if (seated.length > 0) {
            const share = Math.floor(totalPot / seated.length);
            const rem = totalPot % seated.length;
            seated.forEach((p, i) => { p.chips += share + (i === 0 ? rem : 0); });
          }
        }
      }

      // Step 3: Reset all player statuses to 'waiting' (not sitting-out)
      for (const p of room.players) {
        if (p.status === 'playing' || p.status === 'all-in' || p.status === 'folded') {
          p.status = p.chips > 0 ? 'waiting' : 'sitting-out';
        }
        p.holeCards = undefined;
        p.hasActedThisRound = false;
      }

      // Step 4: Wipe game state
      room.gameState = null;
    }

    emitSystemMessage(roomId, '⚡ Admin forced next hand — pot returned to players');
    broadcastRoomState(room);

    // Start next hand after a short delay
    setTimeout(() => {
      const started = tryStartNextHand(roomId);
      if (!started) {
        // Not enough players yet — broadcast lobby state
        const r = roomManager.getRoom(roomId);
        if (r) broadcastRoomState(r);
      }
    }, 1500);

    callback({ ok: true });
  });

  socket.on('admin:set-table-color', (payload: { color: string }, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback({ ok: false, error: 'Room not found' });
    const adminPlayer = room.players.find(p => p.sessionToken === sessionToken && p.role === 'admin');
    if (!adminPlayer) return callback({ ok: false, error: 'Not admin' });

    const allowed = ['#1a3a1a', '#1F0808', '#0a1a2e', '#1a1a2e', '#1a1208', '#0d0d17'];
    if (!allowed.includes(payload.color)) return callback({ ok: false, error: 'Invalid color' });

    room.settings.tableColor = payload.color;
    broadcastRoomState(room);
    callback({ ok: true });
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

    // Determine if player is ACTIVELY IN a running hand (not showdown, not halted).
    // Showdown phase = hand is over, chips should be applied now even if gameState exists.
    const isActiveInHand =
      room.gameState !== null &&
      room.gameState.phase !== 'showdown' &&
      (target.status === 'playing' || target.status === 'all-in');

    let queued = false;

    if (isActiveInHand) {
      // Queue chips — hand is still running, apply after it ends
      target.pendingChipsAdjustment = (target.pendingChipsAdjustment || 0) + payload.amount;
      queued = true;
      emitSystemMessage(roomId, `${admin.nick} queued +${payload.amount} chips for ${target.nick} (will apply after this hand)`);
    } else {
      // Apply immediately — no active hand, or hand is in showdown
      target.chips += payload.amount;
      target.totalBuyIn += payload.amount;
      if (target.status === 'no-chips' || target.status === 'spectator' || target.status === 'folded') {
        target.status = 'waiting';
      }
      emitSystemMessage(roomId, `${admin.nick} added ${payload.amount} chips to ${target.nick}`);
    }

    console.log(`[admin:add-chips] +${payload.amount} for ${target.nick} (queued=${queued})`);
    broadcastRoomState(room);
    // Tell admin whether chips were applied now or queued
    callback?.({ ok: true, queued });

    // Auto-restart check: try to start a new hand if we now have enough players.
    // Covers 3 cases:
    //   1. gameState is null (game never started / ended with no eligible players)
    //   2. gameState is in showdown and now halted (not enough chips to continue)
    //   3. Chips were queued but game is in showdown (apply them now too)
    if (!isActiveInHand) {
      // Apply any other pending adjustments (in case multiple were queued earlier)
      applyPendingChips(room);

      const isHalted =
        !room.gameState ||
        (room.gameState.currentPlayerSeat === null && room.gameState.phase === 'showdown');

      if (isHalted) {
        const eligible = room.players.filter(
          (p) =>
            p.chips > 0 &&
            p.status !== 'sitting-out' &&
            p.status !== 'disconnected' &&
            p.connected,
        );
        if (eligible.length >= 2) {
          console.log(`[admin:add-chips] Auto-starting next hand in ${roomId} (${eligible.length} eligible)`);
          setTimeout(() => tryStartNextHand(roomId), 1500);
        }
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

    let actualRemoved = 0;

    if (room.gameState && (target.status === 'playing' || target.status === 'all-in')) {
      // Player is active — queue the removal for after the hand
      target.pendingChipsAdjustment = (target.pendingChipsAdjustment || 0) - payload.amount;
      emitSystemMessage(roomId, `${admin.nick} queued -${payload.amount} chips for ${target.nick} (applied after this hand)`);
    } else {
      actualRemoved = Math.min(payload.amount, target.chips);
      target.chips -= actualRemoved;
      if (target.chips <= 0 && target.status === 'waiting') {
        target.status = 'no-chips';
      }
      console.log(`[admin:remove-chips] -${actualRemoved} from ${target.nick}`);
      emitSystemMessage(roomId, `${admin.nick} removed ${actualRemoved} chips from ${target.nick}`);
    }

    broadcastRoomState(room);
    callback?.({ ok: true });
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

  // Move a player to a different seat. Only allowed when no hand is in progress.
  socket.on('admin:move-player-seat', (payload, callback) => {
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

    // Only allow when no hand is in progress
    if (room.gameState && room.gameState.phase !== 'showdown') {
      return callback?.({ ok: false, error: 'Cannot move seats while a hand is in progress' });
    }

    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    if (!target) return callback?.({ ok: false, error: 'Player not found' });

    const newSeat = payload.newSeat;
    if (newSeat < 0 || newSeat >= room.settings.maxSeats) {
      return callback?.({ ok: false, error: 'Invalid seat number' });
    }

    // Check if the seat is occupied
    const occupant = room.players.find((p) => p.seat === newSeat && p.sessionToken !== target.sessionToken);
    if (occupant) {
      return callback?.({ ok: false, error: `Seat ${newSeat} is already taken by ${occupant.nick}` });
    }

    const oldSeat = target.seat;
    target.seat = newSeat;
    // Re-sort players by seat to keep array order consistent
    room.players.sort((a, b) => a.seat - b.seat);

    console.log(`[admin:move-player-seat] ${admin.nick} moved ${target.nick} from seat ${oldSeat} to seat ${newSeat}`);
    broadcastRoomState(room);
    emitSystemMessage(roomId, `${admin.nick} moved ${target.nick} to seat ${newSeat}`);
    callback?.({ ok: true });
  });

  // ===== Pause / Unpause =====
  socket.on('game:pause', (callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback?.({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player || (player.role !== 'admin' && player.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'No permission' });
    }
    room.paused = true;
    broadcastRoomState(room);
    emitSystemMessage(roomId, `⏸ ${player.nick} paused the game`);
    callback?.({ ok: true });
  });

  socket.on('game:unpause', (callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback?.({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player || (player.role !== 'admin' && player.role !== 'vice-admin')) {
      return callback?.({ ok: false, error: 'No permission' });
    }
    room.paused = false;
    broadcastRoomState(room);
    emitSystemMessage(roomId, `▶ ${player.nick} resumed the game`);
    callback?.({ ok: true });
  });

  // ===== Admin transfer =====
  socket.on('admin:transfer', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback?.({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });
    const admin = room.players.find((p) => p.sessionToken === sessionToken);
    if (!admin || admin.role !== 'admin') return callback?.({ ok: false, error: 'Only admin can transfer' });
    const target = room.players.find((p) => p.sessionToken === payload.targetSessionToken);
    if (!target) return callback?.({ ok: false, error: 'Player not found' });
    // Transfer: demote current admin, promote target
    admin.role = 'player';
    target.role = 'admin';
    emitSystemMessage(roomId, `👑 ${admin.nick} transferred admin to ${target.nick}`);
    broadcastRoomState(room);
    callback?.({ ok: true });
  });

  // ===== Pre-action =====
  socket.on('game:pre-action', (payload, callback) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback?.({ ok: false, error: 'No session' });
    const room = roomManager.getRoom(roomId);
    if (!room) return callback?.({ ok: false, error: 'Room not found' });
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return callback?.({ ok: false, error: 'Player not found' });
    if (room.gameState?.currentPlayerSeat === player.seat) {
      return callback?.({ ok: false, error: "It's your turn — act now" });
    }
    player.pendingAction = payload.action;
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

  // Show hand — player reveals their hole cards after hand is over
  // Pineapple Classic — player discards 1 card after flop
  socket.on('game:pineapple-discard', (payload: { discardIndex: number }, callback: (r: { ok: boolean; error?: string }) => void) => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return callback?.({ ok: false, error: 'Not in a room' });

    const room = roomManager.getRoom(roomId);
    if (!room || room.gameState?.phase !== 'pineapple-discard') {
      return callback?.({ ok: false, error: 'Not in pineapple discard phase' });
    }

    const result = performPineappleDiscard(room, sessionToken, payload.discardIndex ?? 0);
    if (!result.ok) return callback?.({ ok: false, error: result.error });

    broadcastRoomState(room);
    callback?.({ ok: true });

    // Check if all players have discarded
    progressGame(roomId);
  });

  socket.on('game:show-hand', () => {
    const sessionToken = socket.data.sessionToken;
    const roomId = socket.data.roomId;
    if (!sessionToken || !roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return;
    // Only allowed during showdown phase (hand result visible, new hand not started)
    if (room.gameState?.phase !== 'showdown') return;

    // holeCards are preserved until the next hand starts, so they're
    // always available here during the showdown window.
    const cards = player.holeCards;
    if (!cards || cards.length === 0) return;

    io.to(roomId).emit('game:hand-revealed', {
      sessionToken: player.sessionToken,
      nick: player.nick,
      cards,
    });
    console.log(`[show-hand] ${player.nick} revealed cards in ${roomId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const sessionToken = socket.data.sessionToken;
    if (!sessionToken) return;
    sessionToSocket.delete(sessionToken);

    const result = roomManager.disconnectPlayer(sessionToken);
    if (!result) return;

    // Delay "offline" broadcast by 3s — iOS PWA reconnects in ~1-2s
    // This prevents the "player went offline" flash for fast reconnects
    setTimeout(() => {
      const room = roomManager.getRoom(result.roomId);
      if (!room) return;
      const player = room.players.find((p) => p.sessionToken === sessionToken);
      if (!player || player.connected) return; // already reconnected — skip broadcast
      broadcastRoomState(room);
    }, 3000);

    // Start grace period — give mobile players time to reconnect
    // before folding them out of the hand
    const existingTimer = disconnectGraceTimers.get(sessionToken);
    if (existingTimer) clearTimeout(existingTimer);

    const graceTimer = setTimeout(() => {
      disconnectGraceTimers.delete(sessionToken);
      const room = roomManager.getRoom(result.roomId);
      if (!room) return;

      const player = room.players.find((p) => p.sessionToken === sessionToken);
      if (!player || player.connected) return; // reconnected during grace period

      console.log(`[disconnect-grace] ${player.nick} did not reconnect in ${DISCONNECT_GRACE_MS}ms — folding`);

      // Now actually fold the player if they were active
      if (room.gameState && player.status === 'playing') {
        // Don't fold if player already acted this round (e.g. call sent just before disconnect)
        if (player.hasActedThisRound) {
          console.log(`[disconnect-grace] ${player.nick} already acted — NOT folding`);
          broadcastRoomState(room);
          return;
        }
        player.status = 'folded';
        broadcastRoomState(room);
        const phase = room.gameState.phase;
        if (phase && phase !== 'showdown') {
          progressGame(result.roomId);
        }
      } else if (room.gameState && player.status === 'all-in') {
        // All-in players don't need to act — leave them in
      } else if (!room.gameState) {
        // No game running — just mark as disconnected
        player.status = 'disconnected';
        broadcastRoomState(room);
      }
    }, DISCONNECT_GRACE_MS);

    disconnectGraceTimers.set(sessionToken, graceTimer);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🎰 Poker backend running on http://localhost:${PORT}`);
  console.log(`📡 Accepting connections from: ${FRONTEND_URL}`);
});


