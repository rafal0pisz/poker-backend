// Shared types — common definitions for room, player, events, and game state
import type { Card } from './deck.js';

export type PlayerRole = 'player' | 'vice-admin' | 'admin';

// Game variants for Dealer's Choice (Mix Poker)
// Texas:    2 hole cards + 5 community, best 5 of 7
// Omaha:    4 hole cards + 5 community, must use EXACTLY 2 hole + 3 community
// Drawmaha: 5 hole cards + draw phase after flop + 1-card reveal + split pot (Omaha half + Texas half)
export type GameVariant = 'texas' | 'omaha' | 'omaha-pl' | 'drawmaha' | 'drawmaha-pl' | 'pineapple' | 'pineapple-classic';

export type PlayerStatus =
  | 'playing'
  | 'folded'
  | 'all-in'
  | 'sitting-out'
  | 'waiting'
  | 'no-chips'
  | 'disconnected'
  | 'spectator';

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
  handContribution: number; // total chips invested this hand (reset at startNewHand)
  chipRequest?: number;       // pending chip request amount
  isBot?: boolean;             // true for AI bot players (player asks admin for chips)
  totalBetInHand: number;
  hasActedThisRound: boolean;
  // Dealer's Choice — preferred game variant when this player is the dealer
  // Default: 'texas'. Changed via 'game:set-variant' event.
  preferredVariant: GameVariant;
  // Session tracking: total chips added by admin (for buy-in/profit summary)
  totalBuyIn: number;
  // Chips to add/remove after current hand ends (for mid-hand admin adjustments)
  pendingChipsAdjustment: number;
  // Pre-action: player can select check/fold or fold before their turn
  // When it becomes their turn, this action fires automatically.
  pendingAction: 'check-fold' | 'fold' | null;
}

export interface RoomSettings {
  smallBlind: number;
  bigBlind: number;
  startingBuyIn: number;
  maxSeats: number;
  actionTimeoutSec: 15 | 30 | 60;
  tableColor?: string;
}

export type HandPhase = 'preflop' | 'flop' | 'draw' | 'pineapple-discard' | 'turn' | 'river' | 'showdown';

export interface SidePot {
  amount: number;
  eligiblePlayers: string[];
}

export interface HandResult {
  winnings: { sessionToken: string; amount: number; netAmount?: number; handDescription?: string }[];
  showdownCards: { sessionToken: string; cards: Card[]; handName: string }[];
  // The cards that formed the winning hand (5 cards). Used to highlight on the UI.
  winningCards: Card[];
  // Drawmaha split pot result (optional)
  drawmahaResult?: {
    omahaWinner: { sessionToken: string; amount: number; handDescription: string };
    texasWinner: { sessionToken: string; amount: number; handDescription: string };
  };
  // Per-pot breakdown — lets the UI show "Main pot: X +100, Side pot 1: Y +50" etc.
  // Empty if there was only one pot (main pot, no side pots).
  // For each pot in order: main pot first, then side pots in creation order.
  potBreakdown?: PotWinBreakdown[];
}

export interface PotWinBreakdown {
  // Pot label for the UI — "Main pot" or "Side pot 1", "Side pot 2", etc.
  label: string;
  // Total amount in this pot
  amount: number;
  // Winners of this specific pot (may be split between multiple players in case of tie)
  winners: {
    sessionToken: string;
    amount: number; // chips received from THIS pot specifically
    handDescription?: string;
    // For Drawmaha: which half (Omaha or Draw) this player won
    // Undefined for Texas/Omaha/other variants
    drawmahaHalf?: 'omaha' | 'draw';
  }[];
}

// ===== DRAWMAHA DRAW STATE =====

export interface DrawPlayerState {
  // Cards player chose to DISCARD (indices 0-4 into holeCards). Empty = keep all.
  discardIndices: number[];
  // The single card revealed to table (from their new cards after draw)
  revealedCard: Card | null;
  // Whether they accepted or rejected the revealed card
  accepted: boolean | null;
  // Whether this player has submitted their draw action
  hasDrawn: boolean;
  // Whether this player has submitted their reveal decision
  hasDecided: boolean;
}

export interface DrawState {
  // Map of sessionToken → draw state
  playerStates: Record<string, DrawPlayerState>;
  // The one card from the deck that's shown to the table for each player
  // after they discard. Keyed by sessionToken.
  openCards: Record<string, Card>;
  // Timer deadline for reveal-decision phase (15 seconds per player)
  decideDeadline: number | null;
  // Current player deciding on their open card
  currentDecidingSeat: number | null;
  // Timer deadline for the draw submission phase (all players discard simultaneously)
  drawSubmitDeadline: number | null;
}

export interface PineappleDiscardState {
  // Map of sessionToken → whether player has discarded
  playerStates: Record<string, { hasDiscarded: boolean; discardIndex: number | null }>;
  // Deadline for all players to submit discard
  discardDeadline: number | null;
}

export interface GameState {
  phase: HandPhase;
  // Game variant for this specific hand (determined when hand starts, based on dealer's preference)
  variant: GameVariant;
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
  // Only present during Drawmaha draw/draw-reveal phases
  drawState?: DrawState;
  // Only present during Pineapple Classic pineapple-discard phase
  pineappleDiscardState?: PineappleDiscardState;
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

export interface PlayerStats {
  sessionToken: string;
  nick: string;
  handsPlayed: number;       // total hands dealt to player
  handsWon: number;          // hands where player won chips
  vpip: number;              // voluntary put in pot (preflop call/raise, %)
  vpipHands: number;         // hands where player voluntarily entered pot
  biggestPot: number;        // largest pot won
  biggestPotHand: string;    // hand description of biggest pot win
  totalWon: number;          // cumulative net chips won (sum of netAmounts)
  bestHand: string;          // best hand description seen
  allInCount: number;        // times went all-in
  foldCount: number;         // times folded
}

export interface SessionResult {
  sessionToken: string;
  nick: string;
  totalBuyIn: number;    // total chips received from admin
  finalChips: number;    // chips when player left (or current chips)
  netResult: number;     // finalChips - totalBuyIn (positive = profit)
  leftAt: number;        // timestamp of leaving (0 if still in room)
}

export interface Room {
  id: string;
  createdAt: number;
  players: Player[];
  settings: RoomSettings;
  gameState: GameState | null;
  messages: ChatMessage[];
  paused: boolean; // admin can pause the game // chat history (kept while room exists)
  // Persistent session summary — includes players who left
  sessionSummary: SessionResult[];
  playerStats: Record<string, PlayerStats>;  // keyed by sessionToken
}

// ===== CLIENT → SERVER EVENTS =====

export interface ClientToServerEvents {
  'game:show-hand': () => void;
  'game:pineapple-discard': (payload: { discardIndex: number }, callback: (r: { ok: boolean; error?: string }) => void) => void;
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
  // Spectator → take a seat (join the game when next hand starts)
  'game:take-seat': (
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  // Pre-action — select action before your turn
  'game:pre-action': (
    payload: { action: 'check-fold' | 'fold' | null },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  // Dealer's Choice — set preferred variant for when I'm dealer
  'game:set-variant': (
    payload: { variant: GameVariant },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  // Admin: pause/unpause the game
  'game:pause': (callback?: (response: { ok: boolean; error?: string }) => void) => void;
  'game:unpause': (callback?: (response: { ok: boolean; error?: string }) => void) => void;

  // Drawmaha — Draw phase: submit which cards to discard (0–5 indices)
  'game:draw-discard': (
    payload: { discardIndices: number[] },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  // Drawmaha — Reveal phase: accept or reject open card
  'game:draw-decide': (
    payload: { accept: boolean },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  'admin:transfer': (
    payload: { targetSessionToken: string },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;

  'room:create-with-bot': (
    payload: { nick: string; botCount?: number },
    callback: (response: { ok: boolean; roomId?: string; sessionToken?: string; error?: string }) => void
  ) => void;
  'game:request-chips': (
    payload: { amount: number },
    callback: (response: { ok: boolean; error?: string }) => void
  ) => void;
  'game:cancel-chip-request': (
    payload: Record<string, never>,
    callback: (response: { ok: boolean }) => void
  ) => void;
  'admin:decline-chip-request': (
    payload: { targetSessionToken: string },
    callback: (response: { ok: boolean }) => void
  ) => void;
  'admin:approve-chip-request': (
    payload: { targetSessionToken: string },
    callback: (response: { ok: boolean; error?: string }) => void
  ) => void;
  'admin:force-next-hand': (
    payload: Record<string, never>,
    callback: (response: { ok: boolean; error?: string }) => void
  ) => void;
  'admin:set-table-color': (
    payload: { color: string },
    callback: (response: { ok: boolean; error?: string }) => void
  ) => void;
  'admin:add-chips': (
    payload: { targetSessionToken: string; amount: number },
    callback?: (response: { ok: boolean; error?: string; queued?: boolean }) => void,
  ) => void;
  'admin:remove-chips': (
    payload: { targetSessionToken: string; amount: number },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  'admin:remove-player': (
    payload: { targetSessionToken: string },
    callback?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  // Move a player to a different seat. Only allowed when no hand is in progress.
  'admin:move-player-seat': (
    payload: { targetSessionToken: string; newSeat: number },
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
  // Drawmaha: sent to each player individually when open card is assigned
  'game:draw-open-card': (payload: { sessionToken: string; card: Card }) => void;
  'game:hand-revealed': (payload: { sessionToken: string; nick: string; cards: Card[] }) => void;
  'game:all-in-reveal': (players: { sessionToken: string; nick: string; cards: Card[] }[]) => void;
  'chat:message': (message: ChatMessage) => void; // single new message
  error: (message: string) => void;
}

export interface SocketData {
  sessionToken?: string;
  roomId?: string;
}
