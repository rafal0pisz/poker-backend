// Shared types — common definitions for room, player, events, and game state
import type { Card } from './deck.js';

export type PlayerRole = 'player' | 'vice-admin' | 'admin';

export type PlayerStatus =
  | 'playing'
  | 'folded'
  | 'all-in'
  | 'sitting-out'
  | 'waiting'
  | 'no-chips'
  | 'disconnected';

export type ActionType = 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'all-in';

export interface Action {
  type: ActionType;
  amount?: number;
  playerSessionToken: string;
  timestamp: number;
}

export interface Player {
  sessionToken: string;
  nick: string;
  chips: number;
  seat: number;
  role: PlayerRole;
  status: PlayerStatus;
  connected: boolean;
  lastSeenAt: number;
  holeCards?: Card[];
  currentBet: number;
  totalBetInHand: number;
  hasActedThisRound: boolean;
}

export interface RoomSettings {
  smallBlind: number;
  bigBlind: number;
  startingBuyIn: number;
  maxSeats: number;
  actionTimeoutSec: 15 | 30 | 60;
}

export type HandPhase = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface SidePot {
  amount: number;
  eligiblePlayers: string[];
}

export interface HandResult {
  winnings: { sessionToken: string; amount: number; handDescription?: string }[];
  showdownCards: { sessionToken: string; cards: Card[]; handName: string }[];
}

export interface GameState {
  phase: HandPhase;
  communityCards: Card[];
  pot: number;
  sidePots: SidePot[];
  currentBet: number;
  minRaise: number;
  dealerSeat: number;
  currentPlayerSeat: number | null;
  actionDeadline: number | null;
  lastAction: Action | null;
  handNumber: number;
  lastHandResult: HandResult | null;
}

// ===== CHAT =====

export type ChatMessageType = 'text' | 'reaction' | 'system';

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  senderSessionToken: string | null; // null for system messages
  senderNick: string; // for system: "System"
  content: string; // text, or emoji for reaction
  timestamp: number;
}

export interface Room {
  id: string;
  createdAt: number;
  players: Player[];
  settings: RoomSettings;
  gameState: GameState | null;
  messages: ChatMessage[]; // chat history (kept while room exists)
}

// ===== CLIENT → SERVER EVENTS =====

export interface ClientToServerEvents {
  'room:create': (
    payload: { nick: string; settings: RoomSettings },
    callback: (response: CreateRoomResponse) => void,
  ) => void;

  'room:join': (
    payload: { roomId: string; nick: string; sessionToken?: string },
    callback: (response: JoinRoomResponse) => void,
  ) => void;

  'room:leave': () => void;

  'game:start': (callback?: (response: { ok: boolean; error?: string }) => void) => void;
  'game:next-hand': (callback?: (response: { ok: boolean; error?: string }) => void) => void;
  'game:action': (
    payload: { action: ActionType; amount?: number },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  'game:sit-out': () => void;
  'game:sit-back': () => void;

  'admin:add-chips': (
    payload: { targetSessionToken: string; amount: number },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  'admin:remove-chips': (
    payload: { targetSessionToken: string; amount: number },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  'admin:remove-player': (
    payload: { targetSessionToken: string },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  // Chat
  'chat:send': (
    payload: { type: 'text' | 'reaction'; content: string },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
}

export type CreateRoomResponse =
  | { ok: true; room: Room; sessionToken: string }
  | { ok: false; error: string };

export type JoinRoomResponse =
  | { ok: true; room: Room; sessionToken: string }
  | { ok: false; error: string };

// ===== SERVER → CLIENT EVENTS =====

export interface ServerToClientEvents {
  'room:state': (room: Room) => void;
  'room:closed': (reason: string) => void;
  'game:your-cards': (cards: Card[]) => void;
  'game:hand-result': (result: HandResult) => void;
  'chat:message': (message: ChatMessage) => void; // single new message
  error: (message: string) => void;
}

export interface SocketData {
  sessionToken?: string;
  roomId?: string;
}
