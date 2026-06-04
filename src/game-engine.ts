// Texas Hold'em / Omaha / Drawmaha game engine
// Central object managing hand progression

import { shuffledDeck, shuffle, type Card } from './deck.js';
import type {
  ActionType,
  DrawPlayerState,
  DrawState,
  GameVariant,
  HandPhase,
  HandResult,
  Player,
  Room,
  SidePot,
} from './types.js';

import pokersolverImport from 'pokersolver';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Hand } = pokersolverImport as any;

/**
 * Generates all C(n, k) combinations of `k` elements from `arr`.
 * Used for Omaha / Drawmaha hand evaluation.
 */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  if (k === arr.length) return [arr];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

/**
 * Solves an Omaha hand: best 5-card hand using EXACTLY 2 hole cards + 3 board cards.
 * Tries all C(4,2) × C(5,3) = 60 combinations and picks the best.
 */
export function solveOmaha(
  holeCards: Card[],
  boardCards: Card[],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): { hand: any; holeUsed: Card[]; boardUsed: Card[] } {
  if (holeCards.length < 2) {
    throw new Error(`Omaha requires at least 2 hole cards, got ${holeCards.length}`);
  }
  if (boardCards.length < 3) {
    throw new Error(`Need at least 3 board cards for Omaha, got ${boardCards.length}`);
  }

  const holeCombos = combinations(holeCards, 2);
  const boardCombos = combinations(boardCards, 3);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bestHand: any = null;
  let bestHoleUsed: Card[] = [];
  let bestBoardUsed: Card[] = [];

  for (const hc of holeCombos) {
    for (const bc of boardCombos) {
      const hand = Hand.solve([...hc, ...bc]);
      if (!bestHand) {
        bestHand = hand;
        bestHoleUsed = hc;
        bestBoardUsed = bc;
      } else {
        const winners = Hand.winners([bestHand, hand]);
        if (winners.includes(hand) && !winners.includes(bestHand)) {
          bestHand = hand;
          bestHoleUsed = hc;
          bestBoardUsed = bc;
        }
      }
    }
  }

  return { hand: bestHand, holeUsed: bestHoleUsed, boardUsed: bestBoardUsed };
}

/**
 * Collects discarded/folded cards back into the deck and reshuffles them.
 * Used in Drawmaha when the deck runs out during the draw phase.
 * Returns number of cards added back.
 */
export function refillDeckFromMuck(room: Room, deck: Card[]): number {
  // Collect cards from folded players (they can't win so their cards are "dead")
  const muck: Card[] = [];
  for (const player of room.players) {
    if (player.status === 'folded' && player.holeCards && player.holeCards.length > 0) {
      muck.push(...player.holeCards);
      // Don't clear holeCards — they'll be cleared at hand end, but mark them
    }
  }
  if (muck.length === 0) return 0;
  // Shuffle the muck and add to bottom of deck
  const shuffled = shuffle([...muck]);
  deck.unshift(...shuffled); // add to bottom (next pops from top)
  console.log(`[Drawmaha] Refilled deck with ${shuffled.length} muck cards from folded players`);
  return shuffled.length;
}

/**
 * Crazy Pineapple: 3 hole cards, must use EXACTLY 1 or 2 from hand (not all 3).
 * Best 5-card hand from any combo of 1-2 hole + 3-4 board cards.
 * This is stricter than Texas (which can use 0-5 hole cards freely).
 */
export function solvePineapple(
  holeCards: Card[],
  boardCards: Card[],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): { hand: any; holeUsed: Card[]; boardUsed: Card[] } {
  // Crazy Pineapple uses Texas Hold'em rules — free choice of any cards.
  // Best 5-card hand from any combination of hole cards (0-3) + board cards.
  // No restriction on how many hole cards must be used (unlike Omaha).
  const allCards = [...holeCards, ...boardCards];
  const hand = Hand.solve(allCards);

  // hand.cards contains exactly the 5 cards that form the best hand.
  // Split them back into hole vs board so the frontend highlights only those 5.
  // Card is a string like "As", "Td", "2h".
  // pokersolver returns cards with {value, suit} where value matches rank.
  const winningKeys = new Set(
    hand.cards.map((c: { value: string; suit: string }) => c.value + c.suit)
  );
  // Card string IS already "rank+suit" e.g. "As" — use directly as key.
  const holeUsed = holeCards.filter(c => winningKeys.has(c));
  const boardUsed = boardCards.filter(c => winningKeys.has(c));

  return { hand, holeUsed, boardUsed };
}

/**
 * Starts a new hand.
 * Shuffles deck, deals cards, posts blinds, sets first to act.
 */
export function startNewHand(room: Room): { deck: Card[] } {
  for (const player of room.players) {
    player.currentBet = 0;
    player.totalBetInHand = 0;
    player.hasActedThisRound = false;
    player.holeCards = undefined;
    player.pendingAction = null;

    if (
      player.status === 'sitting-out' ||
      player.status === 'disconnected' ||
      player.status === 'spectator'
    ) {
      continue;
    }
    if (player.chips <= 0) {
      player.status = 'no-chips';
      continue;
    }
    player.status = 'playing';
  }

  const activePlayers = getActivePlayers(room);

  if (activePlayers.length < 2) {
    throw new Error('Not enough active players to start a hand');
  }

  const handNumber = (room.gameState?.handNumber ?? 0) + 1;
  const prevDealer = room.gameState?.dealerSeat ?? -1;
  const dealerSeat = getNextActiveSeat(room, prevDealer, true);

  // ===== DEALER'S CHOICE: variant comes from dealer's preference =====
  const dealerPlayer = room.players.find((p) => p.seat === dealerSeat);
  const variant: GameVariant = dealerPlayer?.preferredVariant || 'texas';

  // Number of hole cards based on variant
  // Texas: 2, Omaha: 4, Drawmaha: 5
  const cardsPerPlayer = variant === 'omaha' ? 4 : variant === 'drawmaha' ? 5 : (variant === 'pineapple' || variant === 'pineapple-classic') ? 3 : 2;

  const deck = shuffledDeck();
  for (const player of activePlayers) {
    player.holeCards = [];
    for (let i = 0; i < cardsPerPlayer; i++) {
      player.holeCards.push(deck.pop()!);
    }
  }

  const sbSeat = getNextActiveSeat(room, dealerSeat, false);
  const bbSeat = getNextActiveSeat(room, sbSeat, false);

  const sbPlayer = room.players.find((p) => p.seat === sbSeat);
  const bbPlayer = room.players.find((p) => p.seat === bbSeat);

  if (!sbPlayer || !bbPlayer) {
    throw new Error('Blind players not found');
  }

  const sb = Math.min(room.settings.smallBlind, sbPlayer.chips);
  const bb = Math.min(room.settings.bigBlind, bbPlayer.chips);

  sbPlayer.chips -= sb;
  sbPlayer.currentBet = sb;
  sbPlayer.totalBetInHand = sb;
  if (sbPlayer.chips === 0) sbPlayer.status = 'all-in';

  bbPlayer.chips -= bb;
  bbPlayer.currentBet = bb;
  bbPlayer.totalBetInHand = bb;
  if (bbPlayer.chips === 0) bbPlayer.status = 'all-in';

  const firstToAct =
    activePlayers.length === 2
      ? sbSeat
      : getNextActiveSeat(room, bbSeat, false);

  room.gameState = {
    phase: 'preflop',
    variant,
    communityCards: [],
    pot: 0,
    sidePots: [],
    currentBet: bb,
    minRaise: bb,
    dealerSeat,
    currentPlayerSeat: firstToAct,
    actionDeadline: Date.now() + room.settings.actionTimeoutSec * 1000,
    lastAction: null,
    handNumber,
    lastHandResult: null,
  };

  return { deck };
}

export function performAction(
  room: Room,
  sessionToken: string,
  actionType: ActionType,
  amount?: number,
): { ok: true } | { ok: false; error: string } {
  if (!room.gameState) {
    return { ok: false, error: 'Game not started' };
  }

  // Block regular actions during draw phases
  if (room.gameState.phase === 'draw') {
    return { ok: false, error: 'Use game:draw-discard during draw phase' };
  }

  const player = room.players.find((p) => p.sessionToken === sessionToken);
  if (!player) return { ok: false, error: 'Player not found' };

  if (player.seat !== room.gameState.currentPlayerSeat) {
    return { ok: false, error: "It's not your turn" };
  }

  if (player.status !== 'playing') {
    return { ok: false, error: 'You are not an active player' };
  }

  const toCall = room.gameState.currentBet - player.currentBet;

  switch (actionType) {
    case 'fold':
      player.status = 'folded';
      player.hasActedThisRound = true;
      break;

    case 'check':
      if (toCall > 0) {
        return { ok: false, error: "You can't check — call or fold" };
      }
      player.hasActedThisRound = true;
      break;

    case 'call': {
      if (toCall === 0) {
        return { ok: false, error: 'Nothing to call — use check' };
      }
      const callAmount = Math.min(toCall, player.chips);
      player.chips -= callAmount;
      player.currentBet += callAmount;
      player.totalBetInHand += callAmount;
      if (player.chips === 0) player.status = 'all-in';
      player.hasActedThisRound = true;
      break;
    }

    case 'bet':
    case 'raise': {
      if (!amount || amount <= 0) {
        return { ok: false, error: 'Enter an amount' };
      }
      const additionalChips = amount - player.currentBet;
      if (additionalChips <= 0) {
        return { ok: false, error: 'Amount must be higher than your current bet' };
      }
      if (additionalChips > player.chips) {
        return { ok: false, error: "You don't have enough chips" };
      }
      const minRequired = room.gameState.currentBet + room.gameState.minRaise;
      const isAllIn = additionalChips === player.chips;
      if (amount < minRequired && !isAllIn) {
        return { ok: false, error: `Minimum raise is ${minRequired}` };
      }
      const raiseSize = amount - room.gameState.currentBet;
      player.chips -= additionalChips;
      player.currentBet = amount;
      player.totalBetInHand += additionalChips;
      room.gameState.currentBet = amount;
      room.gameState.minRaise = Math.max(raiseSize, room.settings.bigBlind);
      for (const p of room.players) {
        if (p.sessionToken !== player.sessionToken && p.status === 'playing') {
          p.hasActedThisRound = false;
        }
      }
      player.hasActedThisRound = true;
      if (player.chips === 0) player.status = 'all-in';
      break;
    }

    case 'all-in': {
      const allInAmount = player.currentBet + player.chips;
      const totalChipsIn = player.chips;
      if (totalChipsIn === 0) {
        return { ok: false, error: 'No chips left' };
      }
      player.chips = 0;
      player.currentBet = allInAmount;
      player.totalBetInHand += totalChipsIn;
      player.status = 'all-in';
      if (allInAmount > room.gameState.currentBet) {
        const raiseSize = allInAmount - room.gameState.currentBet;
        room.gameState.currentBet = allInAmount;
        if (raiseSize >= room.gameState.minRaise) {
          room.gameState.minRaise = raiseSize;
        }
        for (const p of room.players) {
          if (p.sessionToken !== player.sessionToken && p.status === 'playing') {
            p.hasActedThisRound = false;
          }
        }
      }
      player.hasActedThisRound = true;
      break;
    }
  }

  room.gameState.lastAction = {
    type: actionType,
    amount,
    playerSessionToken: sessionToken,
    timestamp: Date.now(),
  };

  return { ok: true };
}

// ===== DRAWMAHA — DRAW PHASE =====

/**
 * Initializes DrawState when entering the draw phase.
 * Called by advancePhase when transitioning flop → draw.
 */
export function initDrawState(room: Room): DrawState {
  const active = room.players.filter(
    (p) => p.status === 'playing' || p.status === 'all-in',
  );

  const playerStates: Record<string, DrawPlayerState> = {};
  for (const p of active) {
    playerStates[p.sessionToken] = {
      discardIndices: [],
      revealedCard: null,
      accepted: null,
      hasDrawn: false,
      hasDecided: false,
    };
  }

  return {
    playerStates,
    openCards: {},
    decideDeadline: null,
    currentDecidingSeat: null,
    // Players have actionTimeoutSec seconds to submit their draw choices
    drawSubmitDeadline: Date.now() + room.settings.actionTimeoutSec * 1000,
  };
}

/**
 * Player submits which cards to discard (0–5 indices).
 * All-in players automatically keep all cards.
 * Returns new cards drawn from deck for this player.
 */
export function performDrawDiscard(
  room: Room,
  sessionToken: string,
  discardIndices: number[],
  deck: Card[],
): { ok: true; openCard: Card | null } | { ok: false; error: string } {
  if (!room.gameState || room.gameState.phase !== 'draw') {
    return { ok: false, error: 'Not in draw phase' };
  }
  if (!room.gameState.drawState) {
    return { ok: false, error: 'Draw state not initialized' };
  }

  const player = room.players.find((p) => p.sessionToken === sessionToken);
  if (!player) return { ok: false, error: 'Player not found' };

  const drawState = room.gameState.drawState;
  const ps = drawState.playerStates[sessionToken];
  if (!ps) return { ok: false, error: 'Player not in draw state' };
  if (ps.hasDrawn) return { ok: false, error: 'Already submitted draw' };

  // Validate indices
  const holeCount = player.holeCards?.length ?? 5;
  const uniqueIndices = [...new Set(discardIndices)];
  for (const idx of uniqueIndices) {
    if (idx < 0 || idx >= holeCount) {
      return { ok: false, error: `Invalid card index: ${idx}` };
    }
  }

  ps.discardIndices = uniqueIndices;
  ps.hasDrawn = true;

  if (uniqueIndices.length === 1) {
    // ── Exactly 1 card discarded ──
    // Correct sequence:
    //   1. Remove the discarded card → player has 4 cards
    //   2. Reveal an open card to the table (visible to everyone)
    //   3. Player decides (accept → gets open card → 5 cards,
    //                      reject → gets blind card from deck → 5 cards)
    // At no point should the player have 5 cards BEFORE making their decision.
    player.holeCards!.splice(uniqueIndices[0], 1); // 5 → 4 cards
    if (deck.length === 0) refillDeckFromMuck(room, deck);
    const openCard = deck.pop();
    if (!openCard) {
      // Even muck exhausted — stand pat with 4 cards, game continues
      console.warn(`[Drawmaha] Deck exhausted — ${player.nick} stands pat after splice`);
      ps.revealedCard = null;
      ps.accepted = null;
      ps.hasDecided = true;
      return { ok: true, openCard: null };
    }
    ps.revealedCard = openCard;
    drawState.openCards[sessionToken] = openCard;
    // hasDecided stays false — player must accept or reject in reveal phase
    return { ok: true, openCard };

  } else if (uniqueIndices.length === 0) {
    // Stand pat — keep all 5 cards, skip reveal phase
    ps.revealedCard = null;
    ps.accepted = null;
    ps.hasDecided = true;
    return { ok: true, openCard: null };

  } else {
    // 2–5 cards discarded — replace each with new card from deck, skip reveal phase.
    // If deck runs out, refill from muck (folded players' cards, reshuffled).
    if (player.holeCards) {
      for (const idx of uniqueIndices) {
        if (deck.length === 0) {
          const added = refillDeckFromMuck(room, deck);
          if (added === 0) {
            console.warn(`[Drawmaha] Deck + muck exhausted for ${player.nick} — keeping remaining cards`);
            break; // can't replace remaining cards
          }
        }
        const newCard = deck.pop();
        if (!newCard) break;
        player.holeCards[idx] = newCard;
      }
    }
    ps.revealedCard = null;
    ps.accepted = null;
    ps.hasDecided = true;
    return { ok: true, openCard: null };
  }
}

/**
 * Initializes PineappleDiscardState when entering pineapple-discard phase.
 */
export function initPineappleDiscardState(room: Room): import('./types.js').PineappleDiscardState {
  const active = room.players.filter(
    (p) => p.status === 'playing' || p.status === 'all-in',
  );
  const playerStates: Record<string, { hasDiscarded: boolean; discardIndex: number | null }> = {};
  for (const p of active) {
    if (p.status === 'all-in') {
      // All-in players auto-discard last card (index 2)
      playerStates[p.sessionToken] = { hasDiscarded: true, discardIndex: 2 };
      if (p.holeCards && p.holeCards.length === 3) {
        p.holeCards.splice(2, 1);
      }
    } else {
      playerStates[p.sessionToken] = { hasDiscarded: false, discardIndex: null };
    }
  }
  return {
    playerStates,
    discardDeadline: Date.now() + room.settings.actionTimeoutSec * 1000,
  };
}

/**
 * Player submits which card to discard in Pineapple Classic (exactly 1 of 3).
 */
export function performPineappleDiscard(
  room: Room,
  sessionToken: string,
  discardIndex: number,
): { ok: true } | { ok: false; error: string } {
  if (!room.gameState || room.gameState.phase !== 'pineapple-discard') {
    return { ok: false, error: 'Not in pineapple discard phase' };
  }
  if (!room.gameState.pineappleDiscardState) {
    return { ok: false, error: 'Discard state not initialized' };
  }

  const player = room.players.find((p) => p.sessionToken === sessionToken);
  if (!player) return { ok: false, error: 'Player not found' };

  const ps = room.gameState.pineappleDiscardState.playerStates[sessionToken];
  if (!ps) return { ok: false, error: 'Player not in discard state' };
  if (ps.hasDiscarded) return { ok: false, error: 'Already discarded' };

  if (!player.holeCards || player.holeCards.length !== 3) {
    return { ok: false, error: 'Player must have exactly 3 cards to discard' };
  }
  if (discardIndex < 0 || discardIndex > 2) {
    return { ok: false, error: 'Discard index must be 0, 1, or 2' };
  }

  // Remove the discarded card
  player.holeCards.splice(discardIndex, 1);
  ps.discardIndex = discardIndex;
  ps.hasDiscarded = true;

  console.log(`[Pineapple] ${player.nick} discarded card at index ${discardIndex}, has ${player.holeCards.length} cards left`);
  return { ok: true };
}

/**
 * Check if all active players have submitted their pineapple discard.
 */
export function isPineappleDiscardComplete(room: Room): boolean {
  if (!room.gameState?.pineappleDiscardState) return false;
  const states = Object.values(room.gameState.pineappleDiscardState.playerStates);
  return states.length > 0 && states.every((s) => s.hasDiscarded);
}

/**
 * Check if all active players have submitted their draw.
 */
export function isDrawPhaseComplete(room: Room): boolean {
  if (!room.gameState?.drawState) return false;
  const states = Object.values(room.gameState.drawState.playerStates);
  return states.length > 0 && states.every((s) => s.hasDrawn);
}

/**
 * Player decides to accept or reject their open card.
 * Accept: open card is added as 6th hole card (they'll use best 5 for Omaha eval)
 * Reject: open card is discarded, player keeps current 5
 *
 * Players decide in seat order. Auto-reject fires after 15s timer.
 */
export function performDrawDecide(
  room: Room,
  sessionToken: string,
  accept: boolean,
  deck: Card[],
): { ok: true } | { ok: false; error: string } {
  if (!room.gameState || room.gameState.phase !== 'draw') {
    return { ok: false, error: 'Not in draw phase' };
  }
  if (!room.gameState.drawState) {
    return { ok: false, error: 'Draw state not initialized' };
  }

  const player = room.players.find((p) => p.sessionToken === sessionToken);
  if (!player) return { ok: false, error: 'Player not found' };

  // Must be this player's turn to decide
  if (room.gameState.drawState.currentDecidingSeat !== player.seat) {
    return { ok: false, error: "Not your turn to decide" };
  }

  const drawState = room.gameState.drawState;
  const ps = drawState.playerStates[sessionToken];
  if (!ps) return { ok: false, error: 'Player not in draw state' };
  if (ps.hasDecided) return { ok: false, error: 'Already decided' };

  if (!player.holeCards) player.holeCards = [];

  if (accept && ps.revealedCard) {
    // Accept: add open card → player goes from 4 → 5 cards
    player.holeCards.push(ps.revealedCard);
    console.log(`[Drawmaha] ${player.nick} accepted open card ${ps.revealedCard} → ${player.holeCards.length} cards`);
  } else {
    // Reject: open card discarded, draw 1 blind card from deck → 4 → 5 cards
    // Only the player sees this new card (sent via game:your-cards privately)
    if (deck.length === 0) refillDeckFromMuck(room, deck);
    const blindCard = deck.pop();
    if (!blindCard) {
      // Deck + muck exhausted — force-accept the open card instead
      console.warn(`[Drawmaha] Deck exhausted for blind card — ${player.nick} forced to accept open card`);
      if (ps.revealedCard) player.holeCards.push(ps.revealedCard);
    } else {
      player.holeCards.push(blindCard);
      console.log(`[Drawmaha] ${player.nick} rejected, drew blind card → ${player.holeCards.length} cards`);
    }
  }

  ps.accepted = accept;
  ps.hasDecided = true;

  return { ok: true };
}

/**
 * Returns the next player who needs to decide on their open card,
 * in seat order starting from dealer+1.
 */
export function getNextDecidingPlayer(room: Room): Player | null {
  if (!room.gameState?.drawState) return null;

  const active = room.players
    .filter((p) => p.status === 'playing' || p.status === 'all-in')
    .sort((a, b) => {
      // Start from dealer+1, wrap around
      const dealer = room.gameState!.dealerSeat;
      const aSeat = a.seat > dealer ? a.seat : a.seat + 100;
      const bSeat = b.seat > dealer ? b.seat : b.seat + 100;
      return aSeat - bSeat;
    });

  const drawState = room.gameState.drawState;
  return active.find((p) => {
    const ps = drawState.playerStates[p.sessionToken];
    return ps && ps.hasDrawn && !ps.hasDecided && ps.revealedCard !== null;
  }) ?? null;
}

/**
 * Check if all active players have decided on their open cards.
 */
export function isRevealPhaseComplete(room: Room): boolean {
  if (!room.gameState?.drawState) return false;
  const states = Object.values(room.gameState.drawState.playerStates);
  return states.length > 0 && states.every((s) => s.hasDecided);
}

// ===== DRAWMAHA — SHOWDOWN (split pot) =====

/**
 * Finalize a Drawmaha hand — split pot 50/50 between:
 * - Omaha winner (EXACTLY 2 hole + 3 board)
 * - Texas winner (best 5 of all cards)
 *
 * Odd chip goes to Omaha winner.
 * If one player wins both halves, they scoop.
 */
export function finalizeDrawmahaHand(room: Room): HandResult {
  if (!room.gameState) throw new Error('No game state');

  collectBets(room);

  const remaining = room.players.filter(
    (p) => p.status === 'playing' || p.status === 'all-in',
  );

  const result: HandResult = {
    winnings: [],
    showdownCards: [],
    winningCards: [],
  };

  // Helper: add chips to a player and record in winnings
  const addWinnings = (
    player: Player,
    amount: number,
    desc?: string,
  ) => {
    if (amount <= 0) return;
    player.chips += amount;
    const existing = result.winnings.find((w) => w.sessionToken === player.sessionToken);
    if (existing) {
      existing.amount += amount;
    } else {
      result.winnings.push({ sessionToken: player.sessionToken, amount, handDescription: desc });
    }
  };

  // Build ordered list of all pots (main pot first, then side pots in creation order)
  // Each pot has an amount and a set of eligible session tokens.
  // All pots stored in sidePots with correct eligibility (see collectBets).
  const allPots: SidePot[] = room.gameState.sidePots.length > 0
    ? [...room.gameState.sidePots]
    : [{ amount: room.gameState.pot, eligiblePlayers: remaining.map((p) => p.sessionToken) }];

  const totalPot = allPots.reduce((s, p) => s + p.amount, 0);

  const board = room.gameState.communityCards;

  console.log(
    `[Drawmaha showdown] board=${board.length} cards, players=${remaining.length}, ` +
    `pots=${allPots.map((p) => `${p.amount}(${p.eligiblePlayers.length} elig.)`).join(' + ')}`,
  );
  for (const p of remaining) {
    console.log(`  ${p.nick}: ${p.holeCards?.length ?? 0} cards: ${p.holeCards?.join(',')}`);
  }

  // Edge case: everyone folded except one
  if (remaining.length === 1) {
    const winner = remaining[0];
    addWinnings(winner, totalPot);
    console.log(`[Drawmaha] Last player standing: ${winner.nick} wins ${totalPot}`);
    room.gameState.phase = 'showdown';
    room.gameState.currentPlayerSeat = null;
    room.gameState.actionDeadline = null;
    room.gameState.lastHandResult = result;
    room.gameState.pot = 0;
    room.gameState.sidePots = [];
    for (const p of room.players) p.holeCards = undefined;
    return result;
  }

  // Guard: board must have at least 3 cards for Omaha eval
  if (board.length < 3) {
    console.error('[Drawmaha] Board too short for evaluation:', board.length);
    addWinnings(remaining[0], totalPot);
    room.gameState.phase = 'showdown';
    room.gameState.currentPlayerSeat = null;
    room.gameState.actionDeadline = null;
    room.gameState.lastHandResult = result;
    room.gameState.pot = 0;
    room.gameState.sidePots = [];
    for (const p of room.players) p.holeCards = undefined;
    return result;
  }

  // Pre-evaluate hands for all remaining players (once, reused across pots)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const omahaEvalMap = new Map<string, { hand: any; holeUsed: Card[]; boardUsed: Card[] }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const texasEvalMap = new Map<string, { hand: any }>();

  for (const p of remaining) {
    try {
      const { hand, holeUsed, boardUsed } = solveOmaha(p.holeCards ?? [], board);
      console.log(`[Drawmaha eval] ${p.nick} Omaha hand: ${hand.descr} (hole: ${holeUsed.join(',')}, board: ${boardUsed.join(',')})`);
      omahaEvalMap.set(p.sessionToken, { hand, holeUsed, boardUsed });
    } catch (err) {
      console.error(`[Drawmaha] Omaha eval failed for ${p.nick}:`, err);
      throw err;
    }
    const drawCards = p.holeCards ?? [];
    if (drawCards.length < 3) {
      console.error(`[Drawmaha] ${p.nick} has only ${drawCards.length} draw cards — unexpected`);
    }
    // Draw portion: evaluate hole cards as a 5-card draw hand (no board used)
    const hand = Hand.solve(drawCards);
    console.log(`[Drawmaha eval] ${p.nick} Draw hand: ${hand.descr} (cards: ${drawCards.join(',')})`);
    texasEvalMap.set(p.sessionToken, { hand });
  }

  // Showdown cards — show both evaluations for each player
  for (const p of remaining) {
    const oE = omahaEvalMap.get(p.sessionToken);
    const tE = texasEvalMap.get(p.sessionToken);
    result.showdownCards.push({
      sessionToken: p.sessionToken,
      cards: p.holeCards ?? [],
      handName: `Omaha: ${oE?.hand?.descr ?? '?'} | Draw: ${tE?.hand?.descr ?? '?'}`,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Process each pot separately with correct eligibility
  // For each pot: split 50/50 between Omaha winner and Draw winner
  //               (only among eligible players for that pot)
  // If a side pot has only 1 eligible player, they scoop it entirely
  //   (no split — they were the only one who could win it)
  // ──────────────────────────────────────────────────────────────────────

  // For drawmahaResult: track totals from the main pot (first pot)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mainPotOmahaWinner: { player: Player; hand: any } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mainPotTexasWinner: { player: Player; hand: any } | null = null;
  let mainPotOmahaAmount = 0;
  let mainPotTexasAmount = 0;

  for (let potIndex = 0; potIndex < allPots.length; potIndex++) {
    const pot = allPots[potIndex];
    const eligible = remaining.filter((p) => pot.eligiblePlayers.includes(p.sessionToken));

    if (eligible.length === 0 || pot.amount === 0) continue;

    if (eligible.length === 1) {
      // Only one player can win this pot — they take it all regardless of hand strength
      const winner = eligible[0];
      addWinnings(winner, pot.amount);
      console.log(`[Drawmaha] Pot #${potIndex} (${pot.amount}): ${winner.nick} wins uncontested`);
      continue;
    }

    // Multiple eligible players — split this pot 50/50
    const halfPot = Math.floor(pot.amount / 2);
    const omahaShare = halfPot + (pot.amount % 2); // odd chip → Omaha winner
    const texasShare = halfPot;

    // Omaha winner(s) for this pot
    const omahaEligible = eligible.map((p) => ({
      player: p,
      ...omahaEvalMap.get(p.sessionToken)!,
    }));
    const omahaWinnerHands = Hand.winners(omahaEligible.map((e) => e.hand));
    const omahaWinners = omahaEligible.filter((e) => omahaWinnerHands.includes(e.hand));

    // Draw (Texas) winner(s) for this pot
    const texasEligible = eligible.map((p) => ({
      player: p,
      ...texasEvalMap.get(p.sessionToken)!,
    }));
    const texasWinnerHands = Hand.winners(texasEligible.map((e) => e.hand));
    const texasWinners = texasEligible.filter((e) => texasWinnerHands.includes(e.hand));

    // Distribute Omaha share
    const omahaPerWinner = Math.floor(omahaShare / omahaWinners.length);
    const omahaRemainder = omahaShare % omahaWinners.length;
    omahaWinners.forEach(({ player, hand }, i) => {
      const share = omahaPerWinner + (i === 0 ? omahaRemainder : 0);
      addWinnings(player, share, `Omaha: ${hand.descr}`);
    });

    // Distribute Draw share
    const texasPerWinner = Math.floor(texasShare / texasWinners.length);
    const texasRemainder = texasShare % texasWinners.length;
    texasWinners.forEach(({ player, hand }, i) => {
      const share = texasPerWinner + (i === 0 ? texasRemainder : 0);
      addWinnings(player, share, `Draw: ${hand.descr}`);
    });

    // Safety check: ensure total distributed == pot.amount (no chips lost to rounding)
    const totalDistributed =
      omahaPerWinner * omahaWinners.length + omahaRemainder +
      texasPerWinner * texasWinners.length + texasRemainder;
    const missing = pot.amount - totalDistributed;
    if (missing > 0) {
      // Give any remaining chip(s) to the omaha winner (standard casino rule)
      addWinnings(omahaWinners[0].player, missing, 'Odd chip');
      console.warn(`[Drawmaha] Odd chip(s) +${missing} → ${omahaWinners[0].player.nick}`);
    }

    const omahaDescr = omahaWinners[0]?.hand?.descr ?? '?';
    const texasDescr = texasWinners[0]?.hand?.descr ?? '?';
    console.log(
      `[Drawmaha] Pot #${potIndex} (${pot.amount}): ` +
      `Omaha → ${omahaWinners[0]?.player?.nick} (${omahaDescr}) +${omahaShare}  |  ` +
      `Draw → ${texasWinners[0]?.player?.nick} (${texasDescr}) +${texasShare}`,
    );

    // Record main pot result for drawmahaResult (used for UI display)
    if (potIndex === 0) {
      mainPotOmahaWinner = omahaWinners[0] ?? null;
      mainPotTexasWinner = texasWinners[0] ?? null;
      mainPotOmahaAmount = omahaShare;
      mainPotTexasAmount = texasShare;
    }
  }

  // drawmahaResult — describes the MAIN POT split for the UI
  if (mainPotOmahaWinner && mainPotTexasWinner) {
    const omahaDescr = mainPotOmahaWinner.hand?.descr ?? '?';
    const texasDescr = mainPotTexasWinner.hand?.descr ?? '?';
    const isScoop = mainPotOmahaWinner.player.sessionToken === mainPotTexasWinner.player.sessionToken;
    if (isScoop) {
      console.log(`[Drawmaha] SCOOP by ${mainPotOmahaWinner.player.nick}`);
    }
    result.drawmahaResult = {
      omahaWinner: {
        sessionToken: mainPotOmahaWinner.player.sessionToken,
        amount: mainPotOmahaAmount,
        handDescription: omahaDescr,
      },
      texasWinner: {
        sessionToken: mainPotTexasWinner.player.sessionToken,
        amount: mainPotTexasAmount,
        handDescription: texasDescr,
      },
    };
  }

  // Highlight the Omaha winner's 2+3 cards from the main pot
  if (mainPotOmahaWinner) {
    const oE = omahaEvalMap.get(mainPotOmahaWinner.player.sessionToken);
    if (oE) result.winningCards = [...oE.holeUsed, ...oE.boardUsed];
  }

  room.gameState.phase = 'showdown';
  room.gameState.currentPlayerSeat = null;
  room.gameState.actionDeadline = null;
  room.gameState.lastHandResult = result;
  room.gameState.pot = 0;
  room.gameState.sidePots = [];

  // Calculate netAmount for each winner
  for (const w of result.winnings) {
    const player = room.players.find(p => p.sessionToken === w.sessionToken);
    if (player) {
      w.netAmount = Math.max(0, w.amount - (player.totalBetInHand || 0));
    }
  }

  // Note: holeCards are intentionally NOT cleared here.
  // They remain available so players can use "Show Hand" during the showdown window.
  // holeCards are cleared at the start of the NEXT hand in startNewHand().

  // Calculate netAmount for each winner: pot received minus their own bets contributed
  for (const w of result.winnings) {
    const player = room.players.find(p => p.sessionToken === w.sessionToken);
    if (player) {
      w.netAmount = Math.max(0, w.amount - (player.totalBetInHand || 0));
    }
  }

  return result;
}

export function isBettingRoundComplete(room: Room): boolean {
  if (!room.gameState) return false;
  const active = room.players.filter((p) => p.status === 'playing');
  if (active.length === 0) return true;

  const allActed = active.every((p) => p.hasActedThisRound);
  const allBetsEqual = active.every(
    (p) => p.currentBet === room.gameState!.currentBet,
  );
  return allActed && allBetsEqual;
}

export function isHandComplete(room: Room): boolean {
  if (!room.gameState) return false;
  const notFolded = room.players.filter(
    (p) => p.status === 'playing' || p.status === 'all-in',
  );
  return notFolded.length <= 1 || room.gameState.phase === 'showdown';
}

export function advancePhase(room: Room, deck: Card[]): void {
  if (!room.gameState) return;

  const variant = room.gameState.variant;

  collectBets(room);

  for (const player of room.players) {
    player.currentBet = 0;
    if (player.status === 'playing') {
      player.hasActedThisRound = false;
    }
  }
  room.gameState.currentBet = 0;
  room.gameState.minRaise = room.settings.bigBlind;

  // Drawmaha phase order: preflop → flop → draw → turn → river → showdown
  // Texas/Omaha:          preflop → flop → turn → river → showdown
  let nextPhase: HandPhase;

  if (variant === 'pineapple-classic') {
    const pineappleClassicOrder: HandPhase[] = ['preflop', 'flop', 'pineapple-discard', 'turn', 'river', 'showdown'];
    const currentIdx = pineappleClassicOrder.indexOf(room.gameState.phase);
    const nextPhase = pineappleClassicOrder[currentIdx + 1];
    if (!nextPhase) return;

    if (nextPhase === 'pineapple-discard') {
      collectBets(room);
      room.gameState.phase = 'pineapple-discard';
      room.gameState.currentPlayerSeat = null;
      room.gameState.actionDeadline = null;
      room.gameState.pineappleDiscardState = initPineappleDiscardState(room);
      return;
    }

    collectBets(room);
    room.gameState.phase = nextPhase;
    room.gameState.currentBet = 0;
    room.gameState.minRaise = room.settings.bigBlind;
    for (const p of room.players) p.hasActedThisRound = false;
    if (nextPhase === 'turn' || nextPhase === 'river') {
      room.gameState.communityCards.push(deck.pop()!);
    }
    room.gameState.pineappleDiscardState = undefined;
    return;
  }

  if (variant === 'drawmaha') {
    const drawmahaOrder: HandPhase[] = ['preflop', 'flop', 'draw', 'turn', 'river', 'showdown'];
    const currentIdx = drawmahaOrder.indexOf(room.gameState.phase);
    nextPhase = drawmahaOrder[currentIdx + 1] ?? 'showdown';
  } else {
    const standardOrder: HandPhase[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];
    const currentIdx = standardOrder.indexOf(room.gameState.phase);
    nextPhase = standardOrder[currentIdx + 1] ?? 'showdown';
  }

  room.gameState.phase = nextPhase;

  if (nextPhase === 'flop') {
    deck.pop();
    room.gameState.communityCards.push(deck.pop()!, deck.pop()!, deck.pop()!);
  } else if (nextPhase === 'turn' || nextPhase === 'river') {
    deck.pop();
    room.gameState.communityCards.push(deck.pop()!);
  } else if (nextPhase === 'draw') {
    // Initialize draw state — no community cards dealt here
    room.gameState.drawState = initDrawState(room);
    room.gameState.currentPlayerSeat = null; // all players act simultaneously
    room.gameState.actionDeadline = null;
    return; // early return — draw phase doesn't use normal betting
  }

  if (nextPhase !== 'showdown') {
    const firstSeat = getNextActiveSeat(room, room.gameState.dealerSeat, false);
    room.gameState.currentPlayerSeat = firstSeat;
    room.gameState.actionDeadline =
      Date.now() + room.settings.actionTimeoutSec * 1000;

    const stillPlaying = room.players.filter((p) => p.status === 'playing');
    if (stillPlaying.length <= 1) {
      for (const p of stillPlaying) p.hasActedThisRound = true;
    }
  } else {
    room.gameState.currentPlayerSeat = null;
    room.gameState.actionDeadline = null;
  }
}

export function nextPlayer(room: Room): void {
  if (!room.gameState || room.gameState.currentPlayerSeat === null) return;
  const next = getNextActiveSeat(room, room.gameState.currentPlayerSeat, false);
  room.gameState.currentPlayerSeat = next;
  room.gameState.actionDeadline = Date.now() + room.settings.actionTimeoutSec * 1000;
}

export function finishHand(room: Room): HandResult {
  if (!room.gameState) {
    throw new Error('No game state');
  }

  // Drawmaha uses its own split-pot finisher
  if (room.gameState.variant === 'drawmaha') {
    return finalizeDrawmahaHand(room);
  }

  collectBets(room);

  const remaining = room.players.filter(
    (p) => p.status === 'playing' || p.status === 'all-in',
  );

  const result: HandResult = {
    winnings: [],
    showdownCards: [],
    winningCards: [],
  };

  // Safety: if sidePots is still empty after collectBets (e.g. all currentBets were 0
  // because they were already zeroed somehow), recalculate from room.gameState.pot.
  // Also check for any uncollected currentBets across ALL players (including folded).
  const uncollected = room.players.reduce((s, p) => s + (p.currentBet || 0), 0);
  if (uncollected > 0) {
    // There are still bets not collected — add them to the pot manually
    room.gameState.pot += uncollected;
    if (room.gameState.sidePots.length > 0) {
      room.gameState.sidePots[room.gameState.sidePots.length - 1].amount += uncollected;
    } else {
      room.gameState.sidePots.push({
        amount: uncollected,
        eligiblePlayers: remaining.map((p) => p.sessionToken),
      });
    }
    room.players.forEach(p => { p.currentBet = 0; });
    console.warn(`[finishHand] Safety net caught ${uncollected} uncollected chips`);
  }

  // Build pot list here so it's available in both branches (single winner and multi)
  const allPots: SidePot[] = room.gameState.sidePots.length > 0
    ? [...room.gameState.sidePots]
    : [{ amount: room.gameState.pot, eligiblePlayers: remaining.map((p) => p.sessionToken) }];

  if (remaining.length === 1) {
    const winner = remaining[0];
    const totalPot = allPots.reduce((s, p) => s + p.amount, 0);
    winner.chips += totalPot;
    result.winnings.push({ sessionToken: winner.sessionToken, amount: totalPot });
    const totalChips = room.players.reduce((s, p) => s + p.chips, 0);
    console.log(`[finishHand] winner=${winner.nick} pot=${totalPot} winner.chips=${winner.chips} allPlayerChips=${totalChips} sidePots=${JSON.stringify(allPots)}`);
  } else {
    const variant = room.gameState.variant;

    const evaluateHand = (
      player: Player,
    ): {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hand: any;
      winningHoleCards?: Card[];
      winningBoardCards?: Card[];
    } => {
      const holeCards = player.holeCards || [];
      const board = room.gameState!.communityCards;

      if (variant === 'omaha') {
        const { hand, holeUsed, boardUsed } = solveOmaha(holeCards, board);
        return { hand, winningHoleCards: holeUsed, winningBoardCards: boardUsed };
      }

      if (variant === 'pineapple' || variant === 'pineapple-classic') {
        // Must use exactly 1 or 2 hole cards — not 0 or 3
        const { hand, holeUsed, boardUsed } = solvePineapple(holeCards, board);
        return { hand, winningHoleCards: holeUsed, winningBoardCards: boardUsed };
      }

      // Texas Hold'em / Drawmaha: free choice of any hole+board cards
      const hand = Hand.solve([...holeCards, ...board]);
      return { hand };
    };

    const evaluations = new Map<string, ReturnType<typeof evaluateHand>>();
    for (const p of remaining) {
      const ev = evaluateHand(p);
      evaluations.set(p.sessionToken, ev);
      result.showdownCards.push({
        sessionToken: p.sessionToken,
        cards: p.holeCards || [],
        handName: ev.hand.name,
      });
    }

    for (let potIndex = 0; potIndex < allPots.length; potIndex++) {
      const pot = allPots[potIndex];
      const eligible = remaining.filter((p) => pot.eligiblePlayers.includes(p.sessionToken));
      if (eligible.length === 0) continue;

      const hands = eligible.map((p) => ({
        sessionToken: p.sessionToken,
        hand: evaluations.get(p.sessionToken)!.hand,
      }));

      const winners = Hand.winners(hands.map((h) => h.hand));
      const winningSessionTokens = hands
        .filter((h) => winners.includes(h.hand))
        .map((h) => h.sessionToken);

      if (potIndex === 0 && winners.length > 0 && result.winningCards.length === 0) {
        const firstWinnerToken = winningSessionTokens[0];
        const winnerEval = evaluations.get(firstWinnerToken);

        if (winnerEval?.winningHoleCards && winnerEval?.winningBoardCards) {
          result.winningCards = [
            ...winnerEval.winningHoleCards,
            ...winnerEval.winningBoardCards,
          ];
        } else {
          const firstWinnerHand = winners[0] as {
            cards?: Array<{ value: string; suit: string } | string>;
          };
          if (firstWinnerHand?.cards) {
            result.winningCards = firstWinnerHand.cards
              .map((c) => (typeof c === 'string' ? c : `${c.value}${c.suit}`))
              .filter((c): c is Card => typeof c === 'string' && c.length === 2);
          }
        }
      }

      const sharePerWinner = Math.floor(pot.amount / winningSessionTokens.length);
      const remainder = pot.amount - sharePerWinner * winningSessionTokens.length;

      for (let i = 0; i < winningSessionTokens.length; i++) {
        const winnerToken = winningSessionTokens[i];
        const player = room.players.find((p) => p.sessionToken === winnerToken)!;
        const share = sharePerWinner + (i === 0 ? remainder : 0);
        player.chips += share;

        const existing = result.winnings.find((w) => w.sessionToken === winnerToken);
        if (existing) {
          existing.amount += share;
        } else {
          const evaluated = evaluations.get(winnerToken)!.hand;
          result.winnings.push({
            sessionToken: winnerToken,
            amount: share,
            handDescription: evaluated.descr,
          });
        }
      }
    }
  }

  room.gameState.phase = 'showdown';
  room.gameState.currentPlayerSeat = null;
  room.gameState.actionDeadline = null;
  room.gameState.lastHandResult = result;
  room.gameState.pot = 0;
  room.gameState.sidePots = [];

  // Note: holeCards are intentionally NOT cleared here — see above.

  // Calculate netAmount for each winner
  for (const w of result.winnings) {
    const player = room.players.find(p => p.sessionToken === w.sessionToken);
    if (player) {
      w.netAmount = Math.max(0, w.amount - (player.totalBetInHand || 0));
    }
  }

  return result;
}

function collectBets(room: Room): void {
  if (!room.gameState) return;

  const contributions: { sessionToken: string; amount: number }[] = [];
  for (const player of room.players) {
    if (player.currentBet > 0) {
      contributions.push({
        sessionToken: player.sessionToken,
        amount: player.currentBet,
      });
    }
  }

  if (contributions.length === 0) return;

  const allInPlayers = room.players.filter(
    (p) => p.status === 'all-in' && p.currentBet > 0,
  );

  if (allInPlayers.length === 0) {
    // No all-ins — simple case: all contributors are eligible for this pot level.
    // Always push to sidePots with eligibility so finishHand can use it correctly.
    const total = contributions.reduce((s, c) => s + c.amount, 0);
    const eligible = contributions.map((c) => c.sessionToken);
    // Merge into the last side pot if it has the same eligible set (common street-by-street betting)
    const last = room.gameState.sidePots[room.gameState.sidePots.length - 1];
    if (
      last &&
      last.eligiblePlayers.length === eligible.length &&
      eligible.every((t) => last.eligiblePlayers.includes(t))
    ) {
      last.amount += total;
    } else {
      room.gameState.sidePots.push({ amount: total, eligiblePlayers: eligible });
    }
  } else {
    // At least one all-in: split into separate pots per contribution level
    const sortedContributions = [...contributions].sort((a, b) => a.amount - b.amount);
    let previousLevel = 0;
    const eligibleSoFar = new Set(contributions.map((c) => c.sessionToken));

    while (sortedContributions.length > 0) {
      const level = sortedContributions[0].amount;
      const levelAmount = level - previousLevel;
      let potAmount = 0;

      for (const c of contributions) {
        if (c.amount >= level) {
          potAmount += levelAmount;
        } else {
          potAmount += Math.max(0, c.amount - previousLevel);
        }
      }

      if (potAmount > 0) {
        // ALWAYS use sidePots — never pot directly. This ensures eligibility is always tracked.
        // The last side pot with same eligibility can be merged (e.g. multiple streets same players)
        const eligible = Array.from(eligibleSoFar);
        const last = room.gameState.sidePots[room.gameState.sidePots.length - 1];
        if (
          last &&
          last.eligiblePlayers.length === eligible.length &&
          eligible.every((t) => last.eligiblePlayers.includes(t))
        ) {
          last.amount += potAmount;
        } else {
          room.gameState.sidePots.push({ amount: potAmount, eligiblePlayers: eligible });
        }
      }

      const playersAtThisLevel = sortedContributions
        .filter((c) => c.amount === level)
        .map((c) => c.sessionToken);

      for (const token of playersAtThisLevel) {
        const player = room.players.find((p) => p.sessionToken === token);
        if (player?.status === 'all-in') {
          eligibleSoFar.delete(token);
        }
      }

      previousLevel = level;
      while (sortedContributions.length > 0 && sortedContributions[0].amount === level) {
        sortedContributions.shift();
      }
    }
  }

  for (const player of room.players) {
    player.currentBet = 0;
  }

  // Sync room.gameState.pot to sum of sidePots for UI display
  if (room.gameState) {
    room.gameState.pot = room.gameState.sidePots.reduce((s, p) => s + p.amount, 0);
  }
}

function getActivePlayers(room: Room): Player[] {
  return room.players.filter((p) => p.status === 'playing');
}

function getNextActiveSeat(room: Room, fromSeat: number, includeAllIn: boolean): number {
  const seats = room.players
    .filter((p) =>
      includeAllIn
        ? p.status === 'playing' || p.status === 'all-in' || p.status === 'no-chips'
        : p.status === 'playing',
    )
    .map((p) => p.seat)
    .sort((a, b) => a - b);

  if (seats.length === 0) return fromSeat;

  for (const seat of seats) {
    if (seat > fromSeat) return seat;
  }
  return seats[0];
}
