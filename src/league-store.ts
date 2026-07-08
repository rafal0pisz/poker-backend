// "Pasjonaci" leagues — persistent, cross-session results tracking for
// regular player groups, opt-in per room. Independent of the in-memory
// Room/Player model everything else in this codebase uses: leagues need to
// survive server restarts and deploys, so they're the one thing backed by a
// file on disk instead of a plain in-memory Map.
//
// Storage: a single JSON file, read into memory on first access and written
// back synchronously after every mutation. Fine for this scale (a handful of
// leagues, a few dozen sessions each) — no real concurrency to worry about
// since Node runs this on one thread and writes are small/infrequent.
import fs from 'fs';
import path from 'path';
import { customAlphabet } from 'nanoid';

const generateLeagueId = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 6);
const generateAdminToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);
const generateSessionId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Railway sets this automatically once a volume is attached to the service.
// Falls back to a local ./data folder for development.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'leagues.json');

export interface LeagueSessionResult {
  nick: string;
  totalBuyIn: number;
  finalChips: number;
  netResult: number;
}

export interface LeagueSession {
  id: string;
  playedAt: number;
  results: LeagueSessionResult[];
}

export interface LeaguePeriod {
  startedAt: number;
  endedAt: number | null; // null = currently open ("this week")
}

export interface League {
  id: string;
  name: string;
  adminToken: string;
  createdAt: number;
  sessions: LeagueSession[];
  periods: LeaguePeriod[];
}

interface LeagueStoreData {
  leagues: Record<string, League>;
}

function loadStore(): LeagueStoreData {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { leagues: {} };
  }
}

function saveStore(store: LeagueStoreData): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// Cached in memory, reloaded lazily — avoids re-reading the file on every
// single request while staying trivially simple (no separate DB process).
let cache: LeagueStoreData | null = null;
function getStore(): LeagueStoreData {
  if (!cache) cache = loadStore();
  return cache;
}
function persist(): void {
  if (cache) saveStore(cache);
}

export function createLeague(name: string): { id: string; name: string; adminToken: string } {
  const store = getStore();
  let id = generateLeagueId();
  while (store.leagues[id]) id = generateLeagueId();

  const now = Date.now();
  const league: League = {
    id,
    name: name.trim().slice(0, 40),
    adminToken: generateAdminToken(),
    createdAt: now,
    sessions: [],
    periods: [{ startedAt: now, endedAt: null }],
  };
  store.leagues[id] = league;
  persist();
  return { id: league.id, name: league.name, adminToken: league.adminToken };
}

export function leagueExists(id: string): boolean {
  return !!getStore().leagues[id.toUpperCase()];
}

// Auto-advances the open period past any full 7-day windows that have
// elapsed since it started — computed lazily on read, no background timer
// needed. Persists if it actually rolled anything over.
function rollPeriodsForward(league: League): void {
  let changed = false;
  let open = league.periods[league.periods.length - 1];
  while (open.endedAt === null && Date.now() - open.startedAt >= ONE_WEEK_MS) {
    const endedAt = open.startedAt + ONE_WEEK_MS;
    open.endedAt = endedAt;
    open = { startedAt: endedAt, endedAt: null };
    league.periods.push(open);
    changed = true;
  }
  if (changed) persist();
}

export function addSession(
  leagueId: string,
  results: LeagueSessionResult[],
): { ok: true; session: LeagueSession } | { ok: false; error: string } {
  const league = getStore().leagues[leagueId.toUpperCase()];
  if (!league) return { ok: false, error: 'League not found' };
  if (!results.length) return { ok: false, error: 'No results provided' };
  for (const r of results) {
    if (!r.nick || typeof r.nick !== 'string') return { ok: false, error: 'Every result needs a nick' };
    if (!Number.isFinite(r.totalBuyIn) || !Number.isFinite(r.finalChips) || !Number.isFinite(r.netResult)) {
      return { ok: false, error: 'totalBuyIn, finalChips, and netResult must be numbers' };
    }
  }

  rollPeriodsForward(league);

  const session: LeagueSession = {
    id: generateSessionId(),
    playedAt: Date.now(),
    results: results.map((r) => ({
      nick: r.nick.trim().slice(0, 16),
      totalBuyIn: r.totalBuyIn,
      finalChips: r.finalChips,
      netResult: r.netResult,
    })),
  };
  league.sessions.push(session);
  persist();
  return { ok: true, session };
}

export function closePeriodNow(
  leagueId: string,
  adminToken: string,
): { ok: true } | { ok: false, error: string } {
  const league = getStore().leagues[leagueId.toUpperCase()];
  if (!league) return { ok: false, error: 'League not found' };
  if (league.adminToken !== adminToken) return { ok: false, error: 'Invalid admin token' };

  rollPeriodsForward(league);
  const open = league.periods[league.periods.length - 1];
  const now = Date.now();
  open.endedAt = now;
  league.periods.push({ startedAt: now, endedAt: null });
  persist();
  return { ok: true };
}

// ── Balances & settlement ───────────────────────────────────────────────

export interface PlayerBalance {
  nick: string;
  net: number;
  sessionsPlayed: number;
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

// Canonical key for matching nicks case-insensitively, keeping the first-seen
// casing for display.
function nickKey(nick: string): string {
  return nick.trim().toLowerCase();
}

export function computeBalances(sessions: LeagueSession[]): PlayerBalance[] {
  const byKey = new Map<string, PlayerBalance>();
  for (const session of sessions) {
    for (const r of session.results) {
      const key = nickKey(r.nick);
      const existing = byKey.get(key);
      if (existing) {
        existing.net += r.netResult;
        existing.sessionsPlayed += 1;
      } else {
        byKey.set(key, { nick: r.nick.trim(), net: r.netResult, sessionsPlayed: 1 });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.net - a.net);
}

// Classic greedy minimum-transaction debt settlement (same approach
// Splitwise uses): largest debtor pays largest creditor, repeat.
export function simplifyDebts(balances: PlayerBalance[]): Settlement[] {
  const creditors = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ nick: b.nick, remaining: b.net }))
    .sort((a, b) => b.remaining - a.remaining);
  const debtors = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ nick: b.nick, remaining: -b.net }))
    .sort((a, b) => b.remaining - a.remaining);

  const settlements: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].remaining, creditors[j].remaining);
    if (amount > 0) {
      settlements.push({ from: debtors[i].nick, to: creditors[j].nick, amount });
      debtors[i].remaining -= amount;
      creditors[j].remaining -= amount;
    }
    if (debtors[i].remaining === 0) i++;
    if (creditors[j].remaining === 0) j++;
  }
  return settlements;
}

export interface LeaguePeriodView {
  startedAt: number;
  endedAt: number | null;
  balances: PlayerBalance[];
  settlements: Settlement[];
}

export interface LeagueView {
  id: string;
  name: string;
  createdAt: number;
  currentPeriod: LeaguePeriodView;
  pastPeriods: LeaguePeriodView[];
  allTime: LeaguePeriodView;
  sessions: LeagueSession[];
}

function periodView(sessions: LeagueSession[], startedAt: number, endedAt: number | null): LeaguePeriodView {
  const inRange = sessions.filter((s) => s.playedAt >= startedAt && (endedAt === null || s.playedAt < endedAt));
  const balances = computeBalances(inRange);
  return { startedAt, endedAt, balances, settlements: simplifyDebts(balances) };
}

export function getLeagueView(leagueId: string): LeagueView | null {
  const league = getStore().leagues[leagueId.toUpperCase()];
  if (!league) return null;
  rollPeriodsForward(league);

  const open = league.periods[league.periods.length - 1];
  const past = league.periods.slice(0, -1);

  return {
    id: league.id,
    name: league.name,
    createdAt: league.createdAt,
    currentPeriod: periodView(league.sessions, open.startedAt, null),
    pastPeriods: past.map((p) => periodView(league.sessions, p.startedAt, p.endedAt)).reverse(),
    allTime: periodView(league.sessions, 0, null),
    sessions: [...league.sessions].reverse(),
  };
}

export function verifyAdminToken(leagueId: string, adminToken: string): boolean {
  const league = getStore().leagues[leagueId.toUpperCase()];
  return !!league && league.adminToken === adminToken;
}
