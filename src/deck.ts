// Poker deck — 52 cards
// Card format: "As" = Ace of spades, "Td" = 10 of diamonds, "Kh" = King of hearts, "2c" = 2 of clubs
// (compatible with the pokersolver library format)

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
 * Shuffles the deck using Fisher-Yates algorithm.
 * NOTE: Math.random() in Node.js is sufficient for friendly games.
 * For online casinos, use crypto.randomInt() or a cryptographic generator.
 */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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
