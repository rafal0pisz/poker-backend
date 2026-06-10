import { Room, Player } from './types.js';
import { Hand } from 'pokersolver';

export const BOT_NAMES = [
  'Shadow', 'Viper', 'Blaze', 'Storm', 'Phoenix',
  'Frost', 'Titan', 'Nova', 'Raven', 'Cobra',
  'Dagger', 'Ember', 'Flux', 'Ghost', 'Hydra',
];

export function getBotNick(): string {
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  return `Bot_${name}`;
}

// Rank value map
const RANK_VAL: Record<string, number> = {
  'A': 14, 'K': 13, 'Q': 12, 'J': 11, 'T': 10,
  '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
};

function cardRank(c: string): number { return RANK_VAL[c[0]] ?? 2; }
function cardSuit(c: string): string { return c[1]; }

// Preflop hand score 1-9 for 2 hole cards (Texas)
function preflopScore2(cards: string[]): number {
  if (cards.length < 2) return 1;
  const r1 = cardRank(cards[0]), r2 = cardRank(cards[1]);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const pair = r1 === r2;
  const suited = cardSuit(cards[0]) === cardSuit(cards[1]);
  const gap = hi - lo;

  if (pair && hi >= 11) return 9;       // JJ+
  if (pair && hi >= 8)  return 7;       // 88-TT
  if (pair)             return 5;       // 22-77
  if (hi === 14 && lo >= 11) return 8;  // AK, AQ, AJ
  if (hi === 14 && lo >= 9)  return 6;  // AT, A9
  if (hi === 14)        return suited ? 5 : 3; // Ax
  if (hi >= 12 && lo >= 10)  return suited ? 6 : 5; // KQ, KJ, QJ
  if (hi >= 10 && gap <= 2)  return suited ? 5 : 4; // connectors
  return suited ? 3 : 2;
}

// Preflop score for 4 hole cards (Omaha) — look for pairs, double-suited, connected
function preflopScore4(cards: string[]): number {
  const ranks = cards.map(cardRank);
  const suits = cards.map(cardSuit);
  let score = 2;
  // Pairs
  const pairCount = ranks.filter((r, i) => ranks.indexOf(r) !== i).length;
  score += pairCount * 1.5;
  // High cards
  const aces = ranks.filter(r => r === 14).length;
  const kings = ranks.filter(r => r === 13).length;
  score += aces * 1.5 + kings * 0.5;
  // Double-suited
  const suitCounts = suits.reduce((m, s) => { m[s] = (m[s] ?? 0) + 1; return m; }, {} as Record<string, number>);
  if (Object.values(suitCounts).some(n => n >= 2)) score += 1;
  // Connectedness
  const sorted = [...ranks].sort((a, b) => b - a);
  if (sorted[0] - sorted[3] <= 4) score += 1;
  return Math.min(9, Math.round(score));
}

// Postflop score using pokersolver (1-9 mapped from hand class)
function postflopScore(holeCards: string[], board: string[]): number {
  try {
    const all = [...holeCards, ...board];
    if (all.length < 5) return preflopScore2(holeCards);
    const hand = Hand.solve(all);
    // pokersolver rank: 1=Royal Flush ... 9=High Card (inverted)
    // hand.rank is numeric — higher = better in pokersolver
    const r = hand.rank as number;
    if (r >= 7)   return 9; // straight flush+
    if (r >= 6)   return 8; // four of a kind
    if (r >= 5)   return 7; // full house
    if (r >= 4)   return 6; // flush
    if (r >= 3)   return 5; // straight
    if (r >= 2.5) return 4; // three of a kind
    if (r >= 2)   return 3; // two pair
    if (r >= 1.5) return 2; // one pair
    return 1;               // high card
  } catch { return 1; }
}

function getHandScore(room: Room, bot: Player): number {
  const hole = bot.holeCards ?? [];
  const board = room.gameState?.communityCards ?? [];
  if (board.length === 0) {
    // Preflop
    return hole.length >= 4 ? preflopScore4(hole) : preflopScore2(hole);
  }
  return postflopScore(hole, board);
}

type BotDecision = { action: 'fold' | 'check' | 'call' | 'raise' | 'all-in'; amount?: number };

export function decideBotAction(room: Room): BotDecision | null {
  if (!room.gameState) return null;

  const bot = room.players.find(
    (p) => (p as any).isBot && p.seat === room.gameState!.currentPlayerSeat && p.status === 'playing'
  );
  if (!bot) return null;

  const gs = room.gameState;
  const toCall = gs.currentBet - bot.currentBet;
  const pot = gs.pot + gs.sidePots.reduce((s, sp) => s + sp.amount, 0)
            + room.players.reduce((s, p) => s + p.currentBet, 0);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const score = getHandScore(room, bot);
  const rand = Math.random();
  const bb = gs.bigBlind ?? 10;

  // Short stack → shove with decent hand
  if (bot.chips <= bb * 4 && score >= 5) return { action: 'all-in' };
  if (bot.chips <= bb * 4 && toCall === 0) return { action: 'check' };
  if (bot.chips <= bb * 4) return score >= 3 ? { action: 'call' } : { action: 'fold' };

  const raiseSmall = Math.min(gs.currentBet + bb * 2, bot.chips + bot.currentBet);
  const raisePot   = Math.min(Math.floor(pot * 0.75) + gs.currentBet, bot.chips + bot.currentBet);

  if (score <= 2) {
    // Weak — mostly fold/check
    if (toCall === 0) return { action: 'check' };
    if (potOdds < 0.15 && rand < 0.3) return { action: 'call' };
    return { action: 'fold' };
  }

  if (score <= 4) {
    // Marginal
    if (toCall === 0) return rand < 0.75 ? { action: 'check' } : { action: 'raise', amount: raiseSmall };
    if (potOdds < 0.25) return rand < 0.55 ? { action: 'call' } : { action: 'fold' };
    return rand < 0.3 ? { action: 'call' } : { action: 'fold' };
  }

  if (score <= 6) {
    // Good
    if (toCall === 0) return rand < 0.4 ? { action: 'check' } : { action: 'raise', amount: raiseSmall };
    return rand < 0.65 ? { action: 'call' } : rand < 0.85 ? { action: 'raise', amount: raiseSmall } : { action: 'fold' };
  }

  if (score <= 8) {
    // Strong
    if (toCall === 0) return rand < 0.15 ? { action: 'check' } : { action: 'raise', amount: raisePot };
    return rand < 0.15 ? { action: 'call' } : { action: 'raise', amount: raisePot };
  }

  // Monster
  if (toCall === 0) return rand < 0.35 ? { action: 'check' } : { action: 'all-in' };
  return rand < 0.2 ? { action: 'call' } : { action: 'all-in' };
}
