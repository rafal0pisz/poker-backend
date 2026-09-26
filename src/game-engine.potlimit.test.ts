// Regression tests for the Pot Limit max-raise cap in performAction().
//
// Bug (reported by players): before the flop, SB and BB — the only players
// who already have chips committed this round BEFORE their first action —
// were capped too low when raising, because the formula dropped their own
// already-committed currentBet. Also affects any re-raise war where a
// player raises again after already having chips in this round (rarer
// post-flop, but the same formula).
//
// Run with: npx tsx src/game-engine.potlimit.test.ts

import assert from 'node:assert/strict';
import {
  startNewHand,
  performAction,
  nextPlayer,
  advancePhase,
  isBettingRoundComplete,
} from './game-engine.js';
import type { Card } from './deck.js';
import type { GameVariant, Player, Room, RoomSettings } from './types.js';

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
    console.log(`      ${(err as Error).message}`);
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
    preferredVariant: 'omaha',
    totalBuyIn: chips,
    pendingChipsAdjustment: 0,
    pendingAction: null,
  };
}

interface Ctx {
  room: Room;
  deck: Card[];
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
  for (let i = 0; i < numPlayers; i++) {
    players.push(makePlayer(i, `tok${i}`, chips));
  }
  // Dealer's Choice reads the dealer's preferredVariant — force it on everyone
  // so startNewHand always deals the variant under test.
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

function betsOnTable(room: Room): number {
  return room.players.reduce((s, p) => s + (p.currentBet || 0), 0);
}

// The known-correct formula, derived independently from first principles
// (see conversation notes): maxBet = myCurrentBet + effectivePot + 2×toCall,
// where effectivePot = collected pot + all bets currently on the table
// (including my own), and toCall = currentBet - myCurrentBet.
function correctMaxRaise(room: Room, sessionToken: string): number {
  const player = room.players.find((p) => p.sessionToken === sessionToken)!;
  const gs = room.gameState!;
  const toCall = gs.currentBet - player.currentBet;
  const effectivePot = gs.pot + betsOnTable(room);
  const minRequired = gs.currentBet + gs.minRaise;
  return Math.max(player.currentBet + effectivePot + 2 * toCall, minRequired);
}

// Mirrors the relevant slice of index.ts's progressGame(): after a successful
// action, either hand the turn to the next player or, if the betting round
// just completed, deal the next street. Good enough to drive these
// preflop/flop scenarios without pulling in the whole server.
function act(ctx: Ctx, sessionToken: string, type: Parameters<typeof performAction>[2], amount?: number) {
  const result = performAction(ctx.room, sessionToken, type, amount);
  if (!result.ok) return result;
  if (isBettingRoundComplete(ctx.room)) {
    advancePhase(ctx.room, ctx.deck);
  } else {
    nextPlayer(ctx.room);
  }
  return result;
}

// ===== Preflop: 3-handed, UTG opens (currentBet=0 before acting) =====
// This is the case the OLD (buggy) formula already handled correctly —
// included as a baseline sanity check that the fix didn't break it.
test('3-handed PLO: UTG opening raise cap matches the pot-after-call formula', () => {
  const ctx = makeCtx(3, 'omaha', 5, 10);
  const utgToken = currentPlayerToken(ctx); // preflop 3-handed: first to act after BB
  const expected = correctMaxRaise(ctx.room, utgToken);
  // known-good hand value for 5/10 blinds, first-in raise: pot(15) + 2*toCall(10) = 35
  assert.equal(expected, 35);

  const tooHigh = performAction(ctx.room, utgToken, 'raise', expected + 10);
  assert.equal(tooHigh.ok, false);

  const exact = act(ctx, utgToken, 'raise', expected);
  assert.equal(exact.ok, true);
});

// ===== Preflop: 3-handed, BB re-raises after a raise (currentBet=BB already in) =====
// This is the scenario players reported as broken: BB already has the big
// blind committed before acting, and the old formula ignored that.
test('3-handed PLO: BB re-raise cap accounts for the posted big blind', () => {
  const ctx = makeCtx(3, 'omaha', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  // UTG opens to the max pot raise (35), action passes to SB then BB
  assert.equal(act(ctx, utgToken, 'raise', 35).ok, true);

  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'fold').ok, true);

  const bbToken = currentPlayerToken(ctx);
  const bbPlayer = ctx.room.players.find((p) => p.sessionToken === bbToken)!;
  assert.equal(bbPlayer.currentBet, 10, 'BB should still show its posted blind before acting');

  const expected = correctMaxRaise(ctx.room, bbToken);
  // Manually verified: pot on table = SB(5, folded but still counted) + UTG(35) + BB(10) = 50
  // correct max = BB.currentBet(10) + 50 + 2*toCall(25) = 110
  assert.equal(expected, 110);

  const buggyOldValue = 100; // effectivePot(50) + 2*toCall(25) — the old formula, missing +10
  const wronglyRejected = performAction(ctx.room, bbToken, 'raise', buggyOldValue + 10);
  assert.equal(wronglyRejected.ok, true, 'a raise the old formula would have rejected must now be allowed');
});

test('3-handed PLO: BB re-raise — one over the true cap is still rejected (fresh room)', () => {
  const ctx = makeCtx(3, 'omaha', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'raise', 35).ok, true);
  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'fold').ok, true);
  const bbToken = currentPlayerToken(ctx);
  const expected = correctMaxRaise(ctx.room, bbToken);
  assert.equal(expected, 110);

  const overCap = performAction(ctx.room, bbToken, 'raise', expected + 1);
  assert.equal(overCap.ok, false);
  assert.match((overCap as { error: string }).error, /max raise to 110/);
});

// ===== Preflop: BB's option — everyone limps, currentBet already = BB (toCall=0) =====
test('3-handed PLO: BB option raise (toCall=0) cap accounts for the posted big blind', () => {
  const ctx = makeCtx(3, 'omaha', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'call').ok, true); // limps to 10

  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'call').ok, true); // completes to 10

  const bbToken = currentPlayerToken(ctx);
  const bbPlayer = ctx.room.players.find((p) => p.sessionToken === bbToken)!;
  assert.equal(ctx.room.gameState!.currentBet, bbPlayer.currentBet, 'BB should face no additional call');

  const expected = correctMaxRaise(ctx.room, bbToken);
  // pot on table = 10+10+10 = 30; toCall = 0
  // correct max = BB.currentBet(10) + 30 + 0 = 40
  assert.equal(expected, 40);

  const buggyOldValue = 30; // effectivePot(30) + 2*0 — the old formula, missing +10
  const wronglyRejectedBefore = performAction(ctx.room, bbToken, 'raise', buggyOldValue + 5);
  assert.equal(wronglyRejectedBefore.ok, true, 'old formula would have capped this below the real max');
});

// ===== Heads-up: dealer/SB acts first preflop, already has SB committed =====
test('Heads-up PLO: SB opening raise cap accounts for the posted small blind', () => {
  const ctx = makeCtx(2, 'omaha', 5, 10);
  const sbToken = currentPlayerToken(ctx); // heads-up: dealer/SB acts first preflop
  const sbPlayer = ctx.room.players.find((p) => p.sessionToken === sbToken)!;
  assert.equal(sbPlayer.currentBet, 5);

  const expected = correctMaxRaise(ctx.room, sbToken);
  // pot on table = SB(5) + BB(10) = 15; toCall = 10-5 = 5
  // correct max = SB.currentBet(5) + 15 + 2*5 = 30
  assert.equal(expected, 30);

  const buggyOldValue = 25; // effectivePot(15) + 2*5 — the old formula, missing +5
  const wronglyRejectedBefore = performAction(ctx.room, sbToken, 'raise', buggyOldValue + 3);
  assert.equal(wronglyRejectedBefore.ok, true, 'old formula would have capped the HU SB raise below the real max');
});

test('Heads-up PLO: SB opening raise — exact cap accepted, one over rejected (fresh room)', () => {
  const ctx = makeCtx(2, 'omaha', 5, 10);
  const sbToken = currentPlayerToken(ctx);
  const expected = correctMaxRaise(ctx.room, sbToken);
  assert.equal(expected, 30);

  const overCap = performAction(ctx.room, sbToken, 'raise', expected + 1);
  assert.equal(overCap.ok, false);
  assert.match((overCap as { error: string }).error, /max raise to 30/);

  const exact = act(ctx, sbToken, 'raise', expected);
  assert.equal(exact.ok, true);
});

// ===== Preflop re-raise war: UTG opens, BB 3-bets, UTG 4-bets (currentBet=UTG's raise, nonzero) =====
test("3-handed PLO: 4-bet cap accounts for the opener's own prior raise", () => {
  const ctx = makeCtx(3, 'omaha', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'raise', 35).ok, true); // UTG opens to pot (35)

  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'fold').ok, true);

  const bbToken = currentPlayerToken(ctx);
  const bbMax = correctMaxRaise(ctx.room, bbToken);
  assert.equal(act(ctx, bbToken, 'raise', bbMax).ok, true); // BB 3-bets to its pot max (110)

  const utgAgainToken = currentPlayerToken(ctx);
  assert.equal(utgAgainToken, utgToken, 'action should return to UTG for the 4-bet');
  const utgPlayer = ctx.room.players.find((p) => p.sessionToken === utgToken)!;
  assert.equal(utgPlayer.currentBet, 35, 'UTG should still show its prior raise before 4-betting');

  const expected = correctMaxRaise(ctx.room, utgToken);
  const buggyOld = expected - 35; // old formula drops +player.currentBet entirely
  const wronglyRejectedBefore = performAction(ctx.room, utgToken, 'raise', buggyOld + 10);
  assert.equal(wronglyRejectedBefore.ok, true, "old formula would under-cap a 4-bet by the raiser's own prior currentBet");
});

// ===== Post-flop sanity: first bet of the street (currentBet=0) still uses the plain formula =====
test('Post-flop PLO: first bet of the street (currentBet=0) is unaffected by the fix', () => {
  const ctx = makeCtx(3, 'omaha', 5, 10);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'call').ok, true); // call BB
  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'call').ok, true);
  const bbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, bbToken, 'check').ok, true); // ends preflop, pot=30, deals flop

  assert.equal(ctx.room.gameState!.phase, 'flop');
  for (const p of ctx.room.players) assert.equal(p.currentBet, 0, 'currentBet must reset for the new street');

  const firstToActToken = currentPlayerToken(ctx);
  const expected = correctMaxRaise(ctx.room, firstToActToken);
  // pot=30, toCall=0, myCurrentBet=0 -> max = 0 + 30 + 0 = 30 (bet the pot)
  assert.equal(expected, 30);
  const overCap = performAction(ctx.room, firstToActToken, 'bet', expected + 1);
  assert.equal(overCap.ok, false);
  const exact = performAction(ctx.room, firstToActToken, 'bet', expected);
  assert.equal(exact.ok, true);
});

// ===== all-in branch: same fix must apply there too =====
// BB's option (toCall=0): old (buggy) cap = effectivePot(20) + 2*0 = 20.
// Correct cap = BB.currentBet(10) + effectivePot(20) + 0 = 30. Give BB a
// stack that lands strictly between those two (25) — the old formula would
// wrongly reject this shove, the fix must allow it.
test('Heads-up PLO: all-in branch respects the same corrected cap (BB short-stacked)', () => {
  const ctx = makeCtx(2, 'omaha', 5, 10, 5000);
  const sbToken = currentPlayerToken(ctx);
  const bbToken = ctx.room.players.find((p) => p.sessionToken !== sbToken)!.sessionToken;
  const bbPlayer = ctx.room.players.find((p) => p.sessionToken === bbToken)!;
  bbPlayer.chips = 15; // + currentBet(10) already posted = 25 total if all-in

  // SB calls to 10 (no raise), action passes to BB with currentBet=10 (BB's own blind)
  assert.equal(act(ctx, sbToken, 'call').ok, true);
  assert.equal(currentPlayerToken(ctx), bbToken);

  const expectedAllIn = bbPlayer.currentBet + bbPlayer.chips; // 10 + 15 = 25
  assert.equal(expectedAllIn, 25);
  const result = performAction(ctx.room, bbToken, 'all-in');
  assert.equal(result.ok, true, 'a shove the old (buggy) 20-cap would have rejected must now be allowed (real cap is 30)');
  assert.equal(bbPlayer.currentBet, expectedAllIn);
});

// ===== all-in branch: BB re-raising all-in over the cap must still be rejected =====
test('3-handed PLO: BB all-in over the true cap is rejected, exactly at cap is allowed', () => {
  const ctx = makeCtx(3, 'omaha', 5, 10, 10000);
  const utgToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, utgToken, 'raise', 35).ok, true);
  const sbToken = currentPlayerToken(ctx);
  assert.equal(act(ctx, sbToken, 'fold').ok, true);
  const bbToken = currentPlayerToken(ctx);
  const bbPlayer = ctx.room.players.find((p) => p.sessionToken === bbToken)!;

  const expected = correctMaxRaise(ctx.room, bbToken); // 110
  assert.equal(expected, 110);

  // Give BB exactly enough chips to go all-in for expected+50 (clearly over cap)
  bbPlayer.chips = (expected + 50) - bbPlayer.currentBet;
  const overCap = performAction(ctx.room, bbToken, 'all-in');
  assert.equal(overCap.ok, false, 'shoving well above the pot-limit cap must be rejected');

  // Now size the stack to exactly the cap and confirm it's allowed
  bbPlayer.chips = expected - bbPlayer.currentBet;
  const atCap = performAction(ctx.room, bbToken, 'all-in');
  assert.equal(atCap.ok, true, 'shoving exactly the pot-limit cap must be allowed');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
