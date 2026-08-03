// Tournament mode — single-table elimination tournaments.
// Layered on top of the existing cash-game room/hand engine: a tournament
// room is a normal Room with settings.mode === 'tournament' and a populated
// tournamentState. Nothing here touches Pasjonaci — tournament results are
// entirely separate (see the confirmed MVP scope).

import type { BlindLevel, Room, TournamentPlacement, TournamentSettings, TournamentState } from './types.js';

export const MIN_TOURNAMENT_PLAYERS = 3;

/** Standard blind-level presets offered at table creation. */
export const BLIND_LEVEL_PRESETS: Record<'turbo' | 'standard' | 'deep', { label: string; levels: BlindLevel[] }> = {
  turbo: {
    label: 'Turbo (8 min/level)',
    levels: buildLevels(480, [
      [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
      [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500], [1000, 2000],
    ]),
  },
  standard: {
    label: 'Standard (15 min/level)',
    levels: buildLevels(900, [
      [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
      [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500], [1000, 2000],
    ]),
  },
  deep: {
    label: 'Deep (25 min/level)',
    levels: buildLevels(1500, [
      [5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200],
      [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500],
    ]),
  },
};

function buildLevels(durationSec: number, blinds: [number, number][]): BlindLevel[] {
  return blinds.map(([sb, bb], i) => ({ level: i + 1, smallBlind: sb, bigBlind: bb, durationSec }));
}

export function createTournamentState(): TournamentState {
  return {
    status: 'registering',
    currentLevel: 1,
    levelStartedAt: null,
    registeredTokens: [],
    eliminationOrder: [],
    finalResults: null,
  };
}

/** True if a brand-new (non-reconnecting) player may still register. */
export function canRegisterForTournament(room: Room): { ok: true } | { ok: false; error: string } {
  const ts = room.tournamentState;
  const settings = room.settings.tournamentSettings;
  if (!ts || !settings) return { ok: true }; // not a tournament room — no gate
  if (ts.status === 'finished') return { ok: false, error: 'Tournament has finished' };
  if (ts.status === 'registering') return { ok: true };
  if (ts.currentLevel > settings.lateRegistrationUntilLevel) {
    return { ok: false, error: `Registration closed — tournament is past level ${settings.lateRegistrationUntilLevel}` };
  }
  return { ok: true };
}

/** Payout share of the pool for a given finishing place, given how many ever registered. */
function payoutShares(registeredCount: number): number[] {
  if (registeredCount >= 3) return [0.5, 0.3, 0.2];
  if (registeredCount === 2) return [0.625, 0.375];
  return [1];
}

function computeFinalResults(room: Room): TournamentPlacement[] {
  const ts = room.tournamentState!;
  const settings = room.settings.tournamentSettings!;
  const pool = settings.startingStack * ts.registeredTokens.length;
  const shares = payoutShares(ts.registeredTokens.length);

  return ts.eliminationOrder
    .filter((p) => p.place <= shares.length)
    .sort((a, b) => a.place - b.place)
    .map((p) => ({ ...p, amount: Math.round(pool * shares[p.place - 1]) }));
}

function finalizeTournamentIfDone(room: Room): void {
  const ts = room.tournamentState;
  if (!ts || ts.status !== 'running') return;

  const stillActive = ts.registeredTokens.filter(
    (token) => !ts.eliminationOrder.some((e) => e.sessionToken === token),
  );

  if (stillActive.length === 1) {
    const token = stillActive[0];
    const nick = room.players.find((p) => p.sessionToken === token)?.nick ?? token.slice(0, 6);
    ts.eliminationOrder.push({ sessionToken: token, nick, place: 1, eliminatedAt: Date.now() });
  } else if (stillActive.length > 1) {
    return; // tournament isn't over yet
  }

  ts.status = 'finished';
  ts.finalResults = computeFinalResults(room);
  ts.levelStartedAt = null;
}

/**
 * Marks the given sessionTokens as eliminated (busted out or left early),
 * assigns their finishing place, and finalizes the tournament if only one
 * registered player remains active. Safe to call with tokens already
 * eliminated (no-op) or with a room that isn't a running tournament (no-op).
 */
export function processTournamentEliminations(room: Room, sessionTokens: string[]): void {
  const ts = room.tournamentState;
  if (!ts || ts.status !== 'running' || sessionTokens.length === 0) return;

  for (const token of sessionTokens) {
    if (!ts.registeredTokens.includes(token)) continue;
    if (ts.eliminationOrder.some((e) => e.sessionToken === token)) continue;

    const activeCount = ts.registeredTokens.length - ts.eliminationOrder.length;
    const nick = room.players.find((p) => p.sessionToken === token)?.nick ?? token.slice(0, 6);
    ts.eliminationOrder.push({ sessionToken: token, nick, place: activeCount, eliminatedAt: Date.now() });

    const player = room.players.find((p) => p.sessionToken === token);
    if (player) player.status = 'eliminated';
  }

  finalizeTournamentIfDone(room);
}

/** Starts the tournament clock — call once when the admin starts the first hand. */
export function startTournamentClock(room: Room): void {
  const ts = room.tournamentState;
  const settings = room.settings.tournamentSettings;
  if (!ts || !settings) return;
  ts.status = 'running';
  ts.currentLevel = 1;
  ts.levelStartedAt = Date.now();
  const level = settings.blindLevels[0];
  if (level) {
    room.settings.smallBlind = level.smallBlind;
    room.settings.bigBlind = level.bigBlind;
  }
}

/**
 * Advances the blind level if the current level's duration has elapsed.
 * Called periodically (see the watchdog interval in index.ts). Once the last
 * configured level is reached, blinds stay there indefinitely.
 * Returns true if a level change happened (caller should broadcast state).
 */
export function advanceBlindLevelIfDue(room: Room): boolean {
  const ts = room.tournamentState;
  const settings = room.settings.tournamentSettings;
  if (!ts || !settings || ts.status !== 'running' || ts.levelStartedAt === null) return false;

  const currentLevelDef = settings.blindLevels[ts.currentLevel - 1];
  if (!currentLevelDef) return false;
  if (Date.now() - ts.levelStartedAt < currentLevelDef.durationSec * 1000) return false;

  const nextLevelDef = settings.blindLevels[ts.currentLevel];
  if (!nextLevelDef) return false; // already on the last level — hold here

  ts.currentLevel += 1;
  ts.levelStartedAt = Date.now();
  room.settings.smallBlind = nextLevelDef.smallBlind;
  room.settings.bigBlind = nextLevelDef.bigBlind;
  return true;
}

/** Admin manual skip — jumps straight to the next level regardless of the timer. */
export function forceAdvanceBlindLevel(room: Room): boolean {
  const ts = room.tournamentState;
  const settings = room.settings.tournamentSettings;
  if (!ts || !settings || ts.status !== 'running') return false;
  const nextLevelDef = settings.blindLevels[ts.currentLevel];
  if (!nextLevelDef) return false;
  ts.currentLevel += 1;
  ts.levelStartedAt = Date.now();
  room.settings.smallBlind = nextLevelDef.smallBlind;
  room.settings.bigBlind = nextLevelDef.bigBlind;
  return true;
}

export function validateTournamentSettings(settings: TournamentSettings | undefined): string | null {
  if (!settings) return 'Missing tournament settings';
  if (!settings.variant) return 'Tournament requires a single game variant';
  if (!settings.startingStack || settings.startingStack < 1) return 'Invalid starting stack';
  if (!Array.isArray(settings.blindLevels) || settings.blindLevels.length === 0) return 'Invalid blind schedule';
  for (const lvl of settings.blindLevels) {
    if (lvl.smallBlind < 1 || lvl.bigBlind < lvl.smallBlind * 2 || lvl.durationSec < 5) {
      return 'Invalid blind level';
    }
  }
  if (settings.lateRegistrationUntilLevel < 0 || settings.lateRegistrationUntilLevel > settings.blindLevels.length) {
    return 'Invalid late registration level';
  }
  return null;
}
