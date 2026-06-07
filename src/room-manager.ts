// Room manager — in-memory state of rooms

import { customAlphabet } from 'nanoid';
import type { Card } from './deck.js';
import type { Player, Room, RoomSettings, ChatMessage } from './types.js';

const generateRoomId = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 6);
const generateSessionToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);
const generateMessageId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const MAX_MESSAGES_PER_ROOM = 500;

class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private sessionToRoom: Map<string, string> = new Map();
  private decks: Map<string, Card[]> = new Map();
  private rateLimits: Map<string, number[]> = new Map();

  createRoom(nick: string, settings: RoomSettings): { room: Room; sessionToken: string } {
    let roomId = generateRoomId();
    while (this.rooms.has(roomId)) {
      roomId = generateRoomId();
    }
    const sessionToken = generateSessionToken();

    const admin: Player = {
      sessionToken,
      nick: this.sanitizeNick(nick),
      chips: settings.startingBuyIn,
      seat: 0,
      role: 'admin',
      status: 'waiting',
      connected: true,
      lastSeenAt: Date.now(),
      currentBet: 0,
      totalBetInHand: 0,
      hasActedThisRound: false,
      preferredVariant: 'texas',
      totalBuyIn: settings.startingBuyIn, // initial buy-in from room creation
      pendingChipsAdjustment: 0,
      pendingAction: null,
    };

    const room: Room = {
      id: roomId,
      createdAt: Date.now(),
      players: [admin],
      settings,
      gameState: null,
      messages: [],
      sessionSummary: [],
      paused: false,
    };

    this.rooms.set(roomId, room);
    this.sessionToRoom.set(sessionToken, roomId);
    return { room, sessionToken };
  }

  joinRoom(
    roomId: string,
    nick: string,
    sessionToken?: string,
  ): { ok: true; room: Room; sessionToken: string } | { ok: false; error: string } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, error: 'Room not found' };
    }

    if (sessionToken) {
      const existing = room.players.find((p) => p.sessionToken === sessionToken);
      if (existing) {
        existing.connected = true;
        existing.lastSeenAt = Date.now();
        if (existing.status === 'disconnected') {
          existing.status = 'waiting';
        }
        return { ok: true, room, sessionToken };
      }
    }

    if (room.players.length >= room.settings.maxSeats) {
      return { ok: false, error: 'All seats are taken' };
    }

    const cleanNick = this.sanitizeNick(nick);
    if (room.players.some((p) => p.nick.toLowerCase() === cleanNick.toLowerCase())) {
      return { ok: false, error: 'This nickname is already taken in this room' };
    }

    const occupiedSeats = new Set(room.players.map((p) => p.seat));
    const maxSeats = room.settings.maxSeats;
    const dealerSeat = room.gameState?.dealerSeat ?? -1;

    // Assign seat clockwise after dealer (or last player) so new players
    // always join in natural table order rather than filling gaps from 0.
    let seat = -1;
    if (occupiedSeats.size === 0) {
      seat = 0;
    } else {
      // Find the highest occupied seat, start searching after it (clockwise)
      const sortedSeats = [...occupiedSeats].sort((a, b) => a - b);
      const startAfter = dealerSeat >= 0
        ? dealerSeat
        : sortedSeats[sortedSeats.length - 1];
      // Try seats clockwise from startAfter
      for (let i = 1; i <= maxSeats; i++) {
        const candidate = (startAfter + i) % maxSeats;
        if (!occupiedSeats.has(candidate)) {
          seat = candidate;
          break;
        }
      }
      // Fallback: first free seat (should never happen if maxSeats enforced)
      if (seat === -1) {
        seat = 0;
        while (occupiedSeats.has(seat)) seat++;
      }
    }

    const newSessionToken = generateSessionToken();

    const newPlayer: Player = {
      sessionToken: newSessionToken,
      nick: cleanNick,
      chips: 0,
      seat,
      role: 'player',
      status: 'spectator',
      connected: true,
      lastSeenAt: Date.now(),
      currentBet: 0,
      totalBetInHand: 0,
      hasActedThisRound: false,
      preferredVariant: 'texas',
      totalBuyIn: 0, // chips received via admin panel (tracked separately)
      pendingChipsAdjustment: 0,
      pendingAction: null,
    };

    room.players.push(newPlayer);
    this.sessionToRoom.set(newSessionToken, roomId);

    return { ok: true, room, sessionToken: newSessionToken };
  }

  disconnectPlayer(sessionToken: string): { roomId: string; room: Room } | null {
    const roomId = this.sessionToRoom.get(sessionToken);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (player) {
      player.connected = false;
      player.lastSeenAt = Date.now();
      if (room.gameState && (player.status === 'playing' || player.status === 'all-in')) {
        if (player.status === 'playing') {
          player.status = 'folded';
        }
      }
    }

    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      this.schedulePotentialRemoval(roomId);
    }

    return { roomId, room };
  }

  removePlayer(sessionToken: string): { roomId: string; room: Room | null } | null {
    const roomId = this.sessionToRoom.get(sessionToken);
    if (!roomId) return null;

    this.sessionToRoom.delete(sessionToken);
    this.rateLimits.delete(sessionToken);
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Save to session summary before removing
    const leavingPlayer = room.players.find((p) => p.sessionToken === sessionToken);
    if (leavingPlayer) {
      // If player is leaving mid-hand, their currentBet is in the pot (not returned yet).
      // For summary purposes, count chips + currentBet as their actual chip count.
      const effectiveChips = leavingPlayer.chips + (leavingPlayer.currentBet || 0);
      const existing = room.sessionSummary.find((s) => s.sessionToken === sessionToken);
      if (existing) {
        // Update if already in summary (e.g. reconnected player)
        existing.finalChips = effectiveChips;
        existing.netResult = effectiveChips - existing.totalBuyIn;
        existing.leftAt = Date.now();
      } else {
        room.sessionSummary.push({
          sessionToken: leavingPlayer.sessionToken,
          nick: leavingPlayer.nick,
          totalBuyIn: leavingPlayer.totalBuyIn,
          finalChips: effectiveChips,
          netResult: effectiveChips - leavingPlayer.totalBuyIn,
          leftAt: Date.now(),
        });
      }
    }

    room.players = room.players.filter((p) => p.sessionToken !== sessionToken);

    if (room.players.length === 0) {
      this.rooms.delete(roomId);
      this.decks.delete(roomId);
      return { roomId, room: null };
    }

    if (!room.players.some((p) => p.role === 'admin')) {
      const viceAdmin = room.players.find((p) => p.role === 'vice-admin');
      if (viceAdmin) {
        viceAdmin.role = 'admin';
      } else if (room.players.length > 0) {
        room.players[0].role = 'admin';
      }
    }

    return { roomId, room };
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) || null;
  }

  getRoomBySessionToken(sessionToken: string): Room | null {
    const roomId = this.sessionToRoom.get(sessionToken);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  setDeck(roomId: string, deck: Card[]): void {
    this.decks.set(roomId, deck);
  }

  getDeck(roomId: string): Card[] | null {
    return this.decks.get(roomId) || null;
  }

  addChatMessage(
    sessionToken: string,
    type: 'text' | 'reaction',
    content: string,
  ): { ok: true; message: ChatMessage } | { ok: false; error: string } {
    const room = this.getRoomBySessionToken(sessionToken);
    if (!room) return { ok: false, error: 'Not in a room' };

    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) return { ok: false, error: 'Player not found' };

    const trimmed = content.trim();
    if (trimmed.length === 0) return { ok: false, error: 'Empty message' };
    if (trimmed.length > 200) return { ok: false, error: 'Message too long (max 200)' };

    const now = Date.now();
    const recent = (this.rateLimits.get(sessionToken) || []).filter((t) => now - t < 1000);
    if (recent.length >= 5) {
      return { ok: false, error: 'Slow down — too many messages' };
    }
    recent.push(now);
    this.rateLimits.set(sessionToken, recent);

    const message: ChatMessage = {
      id: generateMessageId(),
      type,
      senderSessionToken: sessionToken,
      senderNick: player.nick,
      content: trimmed,
      timestamp: now,
    };

    room.messages.push(message);

    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
    }

    return { ok: true, message };
  }

  addSystemMessage(roomId: string, content: string): ChatMessage | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const message: ChatMessage = {
      id: generateMessageId(),
      type: 'system',
      senderSessionToken: null,
      senderNick: 'System',
      content,
      timestamp: Date.now(),
    };

    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
    }

    return message;
  }

  /**
   * Removes sensitive data (other players' cards) before sending to client.
   *
   * Card-reveal rules (strict, standard online-poker behavior):
   * - The viewer always sees their own cards.
   * - Cards of other players are revealed when:
   *   a) ALL-IN SHOWDOWN: at least one player is all-in AND there are zero
   *      players still in 'playing' status (i.e. no one can act anymore, all
   *      remaining live players are either all-in or folded). In this state
   *      no future betting can occur, so we can safely reveal the cards of
   *      every player who is still in the hand (all-in or playing-but-actually-
   *      all-in-equivalent).
   *   b) SHOWDOWN: the hand has just been resolved (lastHandResult present).
   *      Cards of all showdown participants are revealed.
   *
   * If there is even ONE player still in 'playing' status (can act, raise,
   * fold, etc.), NOBODY else's cards are revealed — because their decisions
   * could be influenced by knowing opponents' cards.
   */
  sanitizeRoomForPlayer(room: Room, sessionToken: string): Room {
    // Build the set of sessionTokens whose cards should be revealed to everyone
    const revealedTokens = new Set<string>();

    if (room.gameState) {
      // Players still in the hand (not folded, not sitting out, etc.)
      const stillInHand = room.players.filter(
        (p) => p.status === 'playing' || p.status === 'all-in',
      );

      // Count players who can still ACT (i.e. not all-in)
      const playersWhoCanStillAct = stillInHand.filter((p) => p.status === 'playing');
      const anyAllIn = stillInHand.some((p) => p.status === 'all-in');

      // RULE A: All-in reveal
      // Only when no one can act anymore — meaning all remaining live players
      // are all-in (or there's at most 1 'playing' player who is also already all-in
      // in effect because everyone else is all-in/folded).
      // Strict check: zero players in 'playing' status, at least one all-in.
      //
      // DRAWMAHA EXCEPTION: never reveal cards before the draw phase is complete.
      // Knowing opponents' cards before exchanging would give an unfair advantage.
      // Cards are hidden during preflop, flop, and the draw phase itself.
      // They can be revealed normally from the turn onwards.
      const isDrawmahaPreDraw =
        room.gameState.variant === 'drawmaha' &&
        (room.gameState.phase === 'preflop' ||
          room.gameState.phase === 'flop' ||
          room.gameState.phase === 'draw');

      if (anyAllIn && playersWhoCanStillAct.length === 0 && !isDrawmahaPreDraw) {
        // Reveal cards of every player still in the hand
        for (const p of stillInHand) {
          revealedTokens.add(p.sessionToken);
        }
      }

      // RULE B: Showdown reveal — handled below via showdownCardsMap
    }

    // Build a map of showdown cards (for re-injection)
    const showdownCardsMap = new Map<string, typeof room.players[number]['holeCards']>();
    if (room.gameState?.lastHandResult) {
      for (const sc of room.gameState.lastHandResult.showdownCards) {
        showdownCardsMap.set(sc.sessionToken, sc.cards);
      }
    }

    return {
      ...room,
      players: room.players.map((p) => {
        // The player always sees their own cards
        if (p.sessionToken === sessionToken) {
          return { ...p };
        }

        // Check if we should show this player's cards (via all-in reveal OR showdown)
        const isAllInRevealed = revealedTokens.has(p.sessionToken);
        const showdownCards = showdownCardsMap.get(p.sessionToken);
        const shouldReveal = isAllInRevealed || !!showdownCards;

        if (shouldReveal) {
          // If holeCards are still in memory (before finishHand) use them.
          // After finishHand they are cleared to undefined — fall back to showdownCards.
          // This is critical so that cards remain visible during the post-showdown delay.
          const cardsToShow = p.holeCards || showdownCards;
          return { ...p, holeCards: cardsToShow };
        }

        // Otherwise hide their cards
        return { ...p, holeCards: undefined };
      }),
    };
  }

  private sanitizeNick(nick: string): string {
    return nick.trim().slice(0, 16);
  }

  private schedulePotentialRemoval(roomId: string) {
    setTimeout(
      () => {
        const room = this.rooms.get(roomId);
        if (!room) return;
        const anyConnected = room.players.some((p) => p.connected);
        if (!anyConnected) {
          console.log(`[RoomManager] Removing inactive room ${roomId}`);
          for (const player of room.players) {
            this.sessionToRoom.delete(player.sessionToken);
            this.rateLimits.delete(player.sessionToken);
          }
          this.rooms.delete(roomId);
          this.decks.delete(roomId);
        }
      },
      60 * 60 * 1000,
    );
  }
}

export const roomManager = new RoomManager();
