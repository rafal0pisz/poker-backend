// Texas Hold'em game engine
// Central object managing hand progression

import { shuffledDeck, type Card } from './deck.js';
import type {
  ActionType,
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
 * Used for Omaha hand evaluation.
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
 * This is the defining rule of Omaha — different from Texas Hold'em where you can use any 5.
 *
 * Tries all C(4,2) × C(5,3) = 6 × 10 = 60 combinations and picks the best.
 *
 * Returns the winning Hand object (from pokersolver) plus the specific 2 hole + 3 board
 * cards that formed the winning combination — for UI highlighting.
 */
export function solveOmaha(
  holeCards: Card[],
  boardCards: Card[],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): { hand: any; holeUsed: Card[]; boardUsed: Card[] } {
  if (holeCards.length !== 4) {
    throw new Error(`Omaha requires exactly 4 hole cards, got ${holeCards.length}`);
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
 * Starts a new hand.
 * Shuffles deck, deals cards, posts blinds, sets first to act.
 */
export function startNewHand(room: Room): { deck: Card[] } {
  for (const player of room.players) {
    player.currentBet = 0;
    player.totalBetInHand = 0;
    player.hasActedThisRound = false;
    player.holeCards = undefined;

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
  let variant: GameVariant = dealerPlayer?.preferredVariant || 'texas';

  // Drawmaha is not yet implemented (Milestone 3). Fall back to Texas.
  if (variant === 'drawmaha') {
    variant = 'texas';
  }

  // Number of hole cards based on variant (drawmaha was already handled above)
  const cardsPerPlayer = variant === 'omaha' ? 4 : 2;

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

  collectBets(room);

  for (const player of room.players) {
    player.currentBet = 0;
    if (player.status === 'playing') {
      player.hasActedThisRound = false;
    }
  }
  room.gameState.currentBet = 0;
  room.gameState.minRaise = room.settings.bigBlind;

  const phaseOrder: HandPhase[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const currentIdx = phaseOrder.indexOf(room.gameState.phase);
  const nextPhase = phaseOrder[currentIdx + 1];
  if (!nextPhase) return;
  room.gameState.phase = nextPhase;

  if (nextPhase === 'flop') {
    deck.pop();
    room.gameState.communityCards.push(deck.pop()!, deck.pop()!, deck.pop()!);
  } else if (nextPhase === 'turn' || nextPhase === 'river') {
    deck.pop();
    room.gameState.communityCards.push(deck.pop()!);
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

  collectBets(room);

  const remaining = room.players.filter(
    (p) => p.status === 'playing' || p.status === 'all-in',
  );

  const result: HandResult = {
    winnings: [],
    showdownCards: [],
    winningCards: [],
  };

  if (remaining.length === 1) {
    const winner = remaining[0];
    const totalPot = room.gameState.pot + room.gameState.sidePots.reduce((s, p) => s + p.amount, 0);
    winner.chips += totalPot;
    result.winnings.push({ sessionToken: winner.sessionToken, amount: totalPot });
    // No showdown — no winning cards to highlight
  } else {
    const variant = room.gameState.variant;

    // Helper: evaluate a player's hand based on the current variant
    // Returns the pokersolver Hand object, plus (for Omaha) the specific
    // 2 hole + 3 board cards that formed the winning combination.
    const evaluateHand = (
      player: Player,
    ): {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hand: any;
      // For Omaha: the 5 cards (2 hole + 3 board) that won
      // For Texas: undefined (any 5 of 7 cards may win)
      winningHoleCards?: Card[];
      winningBoardCards?: Card[];
    } => {
      const holeCards = player.holeCards || [];
      const board = room.gameState!.communityCards;

      if (variant === 'omaha') {
        const { hand, holeUsed, boardUsed } = solveOmaha(holeCards, board);
        return { hand, winningHoleCards: holeUsed, winningBoardCards: boardUsed };
      }

      // Texas Hold'em: use all 7 cards, pokersolver picks the best 5
      const hand = Hand.solve([...holeCards, ...board]);
      return { hand };
    };

    const allPots: SidePot[] = [];
    if (room.gameState.pot > 0) {
      allPots.push({
        amount: room.gameState.pot,
        eligiblePlayers: remaining.map((p) => p.sessionToken),
      });
    }
    allPots.push(...room.gameState.sidePots);

    // Pre-evaluate everyone (once) for showdownCards list
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

      // Capture winning 5-card combination from MAIN pot (potIndex === 0)
      // for UI highlighting.
      if (potIndex === 0 && winners.length > 0 && result.winningCards.length === 0) {
        const firstWinnerToken = winningSessionTokens[0];
        const winnerEval = evaluations.get(firstWinnerToken);

        if (winnerEval?.winningHoleCards && winnerEval?.winningBoardCards) {
          // Omaha: we know exactly which 2 hole + 3 board cards won
          result.winningCards = [
            ...winnerEval.winningHoleCards,
            ...winnerEval.winningBoardCards,
          ];
        } else {
          // Texas: pokersolver tells us the 5 winning cards
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

  for (const p of room.players) {
    p.holeCards = undefined;
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
    const total = contributions.reduce((s, c) => s + c.amount, 0);
    room.gameState.pot += total;
  } else {
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
        if (room.gameState.sidePots.length === 0 && room.gameState.pot === 0) {
          room.gameState.pot += potAmount;
        } else {
          room.gameState.sidePots.push({
            amount: potAmount,
            eligiblePlayers: Array.from(eligibleSoFar),
          });
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
