// Poker deck — 52 cards
// Card format: "As" = Ace of spades, "Td" = 10 of diamonds, "Kh" = King of hearts, "2c" = 2 of clubs
// (compatible with the pokersolver library format)

import { randomInt } from 'crypto';

export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

const SUITS: Suit[] = ['s', 'h', 'd', 'c'];
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/**
 * Creates a fresh deck of 52 cards.
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(`${rank}${suit}` as Card);
    }
  }
  return deck;
}

/**
 * Shuffles the deck using Fisher-Yates algorithm with a
 * cryptographically secure random number generator (CSPRNG).
 *
 * crypto.randomInt(min, max) uses Node.js's built-in crypto module —
 * the same entropy source used for TLS keys and password hashing.
 * Unlike Math.random() (a seeded PRNG), this is unpredictable even
 * if an attacker knows the previous outputs.
 *
 * 52! ≈ 8 × 10^67 possible shuffles — crypto.randomInt covers
 * the full space without modulo bias.
 */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    // randomInt(0, i+1) returns a uniform integer in [0, i] — no modulo bias
    const j = randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Returns a freshly shuffled deck.
 */
export function shuffledDeck(): Card[] {
  return shuffle(createDeck());
}
