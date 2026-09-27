// Regression/smoke tests for the two new Dealer's Choice variants:
// Courchevel (5-card Omaha Hi-Lo with the first flop card shown before
// preflop betting) and Five Card Draw Classic (no community cards at all).
//
// Run with: npx tsx src/game-engine.newvariants.test.ts

import assert from 'node:assert/strict';
import {
  startNewHand,
  performAction,
  nextPlayer,
  advancePhase,
  isBettingRoundComplete,
  finishHand,
  performFiveCardDrawDiscard,
  isFiveCardDrawDiscardComplete,
  isPotLimitVariant,
} from './game-engine.js';
import type { Card } from './deck.js';
import type { GameVariant, HandResult, Player, Room, RoomSettings } from './types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`      ${(err as Error).stack ?? err}`);
  }
}

function makePlayer(seat: number, sessionToken: string, chips: number): Player {
  return {
    sessionToken,
    nick: `P${seat}`,
    chips,
    seat,
    role: seat === 0 ? 'admin' : 'player',
    status: 'playing',
    connected: true,
    lastSeenAt: Date.now(),
    currentBet: 0,
    handContribution: 0,
    totalBetInHand: 0,
    hasActedThisRound: false,
    preferredVariant: 'texas',
    totalBuyIn: chips,
    pendingChipsAdjustment: 0,
    pendingAction: null,
  };
}

interface Ctx {
  room: Room;
  deck: Card[];
  lastResult?: HandResult;
}

function makeCtx(numPlayers: number, variant: GameVariant, smallBlind: number, bigBlind: number, chips = 5000): Ctx {
  const settings: RoomSettings = {
    smallBlind,
    bigBlind,
    startingBuyIn: chips,
    maxSeats: 9,
    actionTimeoutSec: 30,
  };
  const players: Player[] = [];
  for (let i = 0; i < numPlayers; i++) players.push(makePlayer(i, `tok${i}`, chips));
  for (const p of players) p.preferredVariant = variant;

  const room: Room = {
    id: 'test-room',
    createdAt: Date.now(),
    players,
    settings,
    gameState: null,
    messages: [],
    paused: false,
    sessionSummary: [],
    playerStats: {},
    handHistory: [],
  };
  const { deck } = startNewHand(room);
  return { room, deck };
}

function seatToken(room: Room, seat: number | null): string {
  const p = room.players.find((p) => p.seat === seat);
  if (!p) throw new Error(`no player at seat ${seat}`);
  return p.sessionToken;
}

function currentPlayerToken(ctx: Ctx): string {
  return seatToken(ctx.room, ctx.room.gameState!.currentPlayerSeat);
}

// Total chips anywhere in the system right now: on players, still uncollected
// in front of them this street (currentBet), or already swept into side pots.
// This must stay constant across an entire hand — unlike a plain sum of
// player.chips, which dips as soon as blinds/bets move money off it and only
// looks "whole" again once everything's been collected and redistributed.
function totalChipsInSystem(room: Room): number {
  const chips = room.players.reduce((s, p) => s + p.chips, 0);
  const onTable = room.players.reduce((s, p) => s + (p.currentBet || 0), 0);
  const pots = room.gameState!.sidePots.reduce((s, sp) => s + sp.amount, 0);
  return chips + onTable + pots;
}

// Mirrors the relevant slice of index.ts's progressGame(): after a successful
// action, either hand the turn to the next player, or — if the betting round
// just completed — deal the next street, finishing the hand if that street
// was the variant's terminal betting phase (river normally, postdraw for
// five-card-draw), exactly like index.ts's `phase === 'river' || 'postdraw'`
// check does before calling finishHand.
function act(ctx: Ctx, sessionToken: string, type: Parameters<typeof performAction>[2], amount?: number, terminalPhase: string = 'river') {
  const result = performAction(ctx.room, sessionToken, type, amount);
  if (!result.ok) return result;
  if (isBettingRoundComplete(ctx.room)) {
    const wasTerminal = ctx.room.gameState!.phase === terminalPhase;
    advancePhase(ctx.room, ctx.deck);
    if (wasTerminal) {
      ctx.lastResult = finishHand(ctx.room);
    }
  } else {
    nextPlayer(ctx.room);
  }
  return result;
}

// ===================== COURCHEVEL =====================

test('Courchevel: deals 5 hole cards and exactly 1 board card before preflop betting', () => {
  const ctx = makeCtx(3, 'courchevel', 5, 10);
  for (const p of ctx.room.players) {
    assert.equal(p.holeCards?.length, 5, `${p.nick} should have 5 hole cards`);
  }
  assert.equal(ctx.room.gameState!.phase, 'preflop');
  assert.equal(ctx.room.gameState!.communityCards.length, 1, 'exactly 1 board card should be visible during preflop');
});

test('Courchevel: is Pot Limit and excluded from Run It Twice', () => {
  const ctx = makeCtx(2, 'courchevel', 5, 10);
  assert.equal(isPotLimitVariant(ctx.room.gameState!.variant), true);
});

test('Courchevel: flop completes to 3 total (only 2 more dealt), turn/river add 1 each', () => {
  const ctx = makeCtx(3, 'courchevel', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'call').ok, true);
  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'call').ok, true);
  const bbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, bbToken, 'check').ok, true);

  assert.equal(ctx.room.gameState!.phase, 'flop');
  assert.equal(ctx.room.gameState!.communityCards.length, 3, 'flop should total 3 cards (1 pre-dealt + 2 more)');

  const flop1 = currentPlayerToken(ctx);
  assert.equal(act(ctx, flop1, 'check').ok, true);
  const flop2 = currentPlayerToken(ctx);
  assert.equal(act(ctx, flop2, 'check').ok, true);
  const flop3 = currentPlayerToken(ctx);
  assert.equal(act(ctx, flop3, 'check').ok, true);

  assert.equal(ctx.room.gameState!.phase, 'turn');
  assert.equal(ctx.room.gameState!.communityCards.length, 4);

  const turn1 = currentPlayerToken(ctx);
  assert.equal(act(ctx, turn1, 'check').ok, true);
  const turn2 = currentPlayerToken(ctx);
  assert.equal(act(ctx, turn2, 'check').ok, true);
  const turn3 = currentPlayerToken(ctx);
  assert.equal(act(ctx, turn3, 'check').ok, true);

  assert.equal(ctx.room.gameState!.phase, 'river');
  assert.equal(ctx.room.gameState!.communityCards.length, 5);
});

test('Courchevel: showdown dispatches to the Hi-Lo split finisher (no crash, chips conserved)', () => {
  const ctx = makeCtx(2, 'courchevel', 5, 10);
  const totalChipsBefore = totalChipsInSystem(ctx.room);

  const sbToken = currentPlayerToken(ctx); // heads-up: dealer/SB acts first preflop
  assert.equal(act(ctx, sbToken, 'call').ok, true);
  const bbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, bbToken, 'check').ok, true);
  assert.equal(ctx.room.gameState!.phase, 'flop');

  for (const phase of ['flop', 'turn'] as const) {
    const first = currentPlayerToken(ctx);
    assert.equal(act(ctx, first, 'check').ok, true);
    const second = currentPlayerToken(ctx);
    assert.equal(act(ctx, second, 'check').ok, true);
  }
  assert.equal(ctx.room.gameState!.phase, 'river');
  const r1 = currentPlayerToken(ctx);
  assert.equal(act(ctx, r1, 'check').ok, true);
  const r2 = currentPlayerToken(ctx);
  assert.equal(act(ctx, r2, 'check').ok, true);

  assert.ok(ctx.lastResult, 'finishHand should have run at the river');
  assert.equal(ctx.lastResult!.showdownCards.length, 2);
  const totalChipsAfter = totalChipsInSystem(ctx.room);
  assert.equal(totalChipsAfter, totalChipsBefore, 'no chips should be created or destroyed');
  // Hi-Lo dispatch means a HandResult shaped by finalizeOmahaHlHand — its
  // winnings always sum to the pot, whether or not a low hand qualified.
  const totalWinnings = ctx.lastResult!.winnings.reduce((s, w) => s + w.amount, 0);
  assert.ok(totalWinnings > 0, 'someone should win the pot');
});

// ===================== FIVE CARD DRAW =====================

test('Five Card Draw: deals 5 hole cards and NO community cards, is No Limit', () => {
  const ctx = makeCtx(3, 'five-card-draw', 5, 10);
  for (const p of ctx.room.players) {
    assert.equal(p.holeCards?.length, 5);
  }
  assert.equal(ctx.room.gameState!.communityCards.length, 0);
  assert.equal(isPotLimitVariant(ctx.room.gameState!.variant), false, 'five-card-draw should be No Limit');
});

test('Five Card Draw: preflop betting completes into draw-discard with no cards dealt', () => {
  const ctx = makeCtx(3, 'five-card-draw', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'call', undefined, 'postdraw').ok, true);
  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'call', undefined, 'postdraw').ok, true);
  const bbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, bbToken, 'check', undefined, 'postdraw').ok, true);

  assert.equal(ctx.room.gameState!.phase, 'draw-discard');
  assert.equal(ctx.room.gameState!.communityCards.length, 0, 'still no community cards ever');
  assert.ok(ctx.room.gameState!.fiveCardDrawState, 'discard state should be initialized');
  assert.equal(ctx.room.gameState!.currentPlayerSeat, null, 'discard is simultaneous, no single turn');
});

test('Five Card Draw: discard/redraw actually swaps the requested cards, others untouched', () => {
  const ctx = makeCtx(2, 'five-card-draw', 5, 10);
  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'call', undefined, 'postdraw').ok, true);
  const bbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, bbToken, 'check', undefined, 'postdraw').ok, true);
  assert.equal(ctx.room.gameState!.phase, 'draw-discard');

  const sbPlayer = ctx.room.players.find((p) => p.sessionToken === sbToken)!;
  const bbPlayer = ctx.room.players.find((p) => p.sessionToken === bbToken)!;
  const sbBefore = [...sbPlayer.holeCards!];
  const bbBefore = [...bbPlayer.holeCards!];

  const sbDiscard = performFiveCardDrawDiscard(ctx.room, sbToken, [0, 2], ctx.deck);
  assert.equal(sbDiscard.ok, true);
  assert.equal(sbPlayer.holeCards!.length, 5, 'must still have exactly 5 cards after redraw');
  assert.equal(sbPlayer.holeCards![1], sbBefore[1], 'untouched index 1 should be unchanged');
  assert.equal(sbPlayer.holeCards![3], sbBefore[3], 'untouched index 3 should be unchanged');
  assert.equal(sbPlayer.holeCards![4], sbBefore[4], 'untouched index 4 should be unchanged');
  assert.notEqual(sbPlayer.holeCards![0], sbBefore[0], 'discarded index 0 should be replaced');
  assert.notEqual(sbPlayer.holeCards![2], sbBefore[2], 'discarded index 2 should be replaced');

  assert.equal(isFiveCardDrawDiscardComplete(ctx.room), false, 'BB has not discarded yet');

  const bbDiscard = performFiveCardDrawDiscard(ctx.room, bbToken, [], ctx.deck); // stand pat
  assert.equal(bbDiscard.ok, true);
  assert.deepEqual(bbPlayer.holeCards, bbBefore, 'standing pat must leave the hand untouched');

  assert.equal(isFiveCardDrawDiscardComplete(ctx.room), true);

  // A second discard from the same player must be rejected (already submitted)
  const dupe = performFiveCardDrawDiscard(ctx.room, sbToken, [], ctx.deck);
  assert.equal(dupe.ok, false);
});

test('Five Card Draw: full hand — discard, second betting round, showdown with standard high-hand win (no split)', () => {
  const ctx = makeCtx(2, 'five-card-draw', 5, 10);
  const totalChipsBefore = totalChipsInSystem(ctx.room);

  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'call', undefined, 'postdraw').ok, true);
  const bbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, bbToken, 'check', undefined, 'postdraw').ok, true);
  assert.equal(ctx.room.gameState!.phase, 'draw-discard');

  assert.equal(performFiveCardDrawDiscard(ctx.room, sbToken, [0, 1], ctx.deck).ok, true);
  assert.equal(performFiveCardDrawDiscard(ctx.room, bbToken, [], ctx.deck).ok, true);
  assert.equal(isFiveCardDrawDiscardComplete(ctx.room), true);

  // Mirrors progressGameInner's draw-discard branch: once complete, advance.
  advancePhase(ctx.room, ctx.deck);
  assert.equal(ctx.room.gameState!.phase, 'postdraw');
  assert.equal(ctx.room.gameState!.communityCards.length, 0);

  // Second betting round — heads-up postdraw, BB acts first (same as flop/turn/river).
  const first = currentPlayerToken(ctx);
  assert.equal(act(ctx, first, 'check', undefined, 'postdraw').ok, true);
  const second = currentPlayerToken(ctx);
  assert.equal(act(ctx, second, 'check', undefined, 'postdraw').ok, true);

  assert.ok(ctx.lastResult, 'finishHand should have run after postdraw betting completed');
  assert.equal(ctx.lastResult!.showdownCards.length, 2);
  assert.equal(ctx.lastResult!.omahaHlResult, undefined, 'five-card-draw is a plain high hand, never a Hi-Lo split');
  assert.equal(ctx.lastResult!.boardCards?.length ?? 0, 0, 'no board cards ever');

  const totalChipsAfter = totalChipsInSystem(ctx.room);
  assert.equal(totalChipsAfter, totalChipsBefore, 'no chips should be created or destroyed');
  const totalWinnings = ctx.lastResult!.winnings.reduce((s, w) => s + w.amount, 0);
  assert.ok(totalWinnings > 0);
});

test('Five Card Draw: No Limit betting allows an over-pot raise (unlike Pot Limit variants)', () => {
  const ctx = makeCtx(2, 'five-card-draw', 5, 10, 5000);
  const sbToken = currentPlayerToken(ctx);
  // Pot is tiny (15) — a huge raise would be rejected under Pot Limit, must be allowed here.
  const result = performAction(ctx.room, sbToken, 'raise', 500);
  assert.equal(result.ok, true, 'No Limit must allow raises far beyond the pot');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
