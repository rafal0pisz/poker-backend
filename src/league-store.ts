// "Pasjonaci" — a single, persistent results ledger shared by every table
// created via the /pasjonaci page. Independent of the in-memory Room/Player
// model everything else in this codebase uses: this needs to survive server
// restarts and deploys, so it's the one thing backed by a file on disk
// instead of a plain in-memory Map.
//
// Deliberately NOT a general multi-league system — there is exactly one
// shared ledger, matching the single fixed /pasjonaci/results page. Storage:
// a single JSON file, read into memory on first access and written back
// synchronously after every mutation. Fine for this scale (one table's worth
// of regulars, a session per poker night) — no real concurrency to worry
// about since Node runs this on one thread and writes are small/infrequent.
import fs from 'fs';
import path from 'path';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Railway sets this automatically once a volume is attached to the service.
// Falls back to a local ./data folder for development.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'pasjonaci.json');

export interface LeagueSessionResult {
  nick: string;
  totalBuyIn: number;
  finalChips: number;
  netResult: number;
}

// One entry per poker table (keyed by roomId) — updated in place after every
// hand rather than appended, so a single poker night is always exactly one
// session no matter how many hands it takes, and a mid-session server
// restart loses at most the last hand's update, not the whole night.
export interface LeagueSession {
  id: string; // == roomId
  playedAt: number; // last updated
  results: LeagueSessionResult[];
}

export interface LeaguePeriod {
  startedAt: number;
  endedAt: number | null; // null = currently open ("this week")
}

interface PasjonaciData {
  sessions: LeagueSession[];
  periods: LeaguePeriod[];
}

function loadStore(): PasjonaciData {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return { sessions: data.sessions ?? [], periods: data.periods ?? [] };
  } catch {
    return { sessions: [], periods: [] };
  }
}

function saveStore(store: PasjonaciData): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

let cache: PasjonaciData | null = null;
function getStore(): PasjonaciData {
  if (!cache) cache = loadStore();
  if (cache.periods.length === 0) cache.periods.push({ startedAt: Date.now(), endedAt: null });
  return cache;
}
function persist(): void {
  if (cache) saveStore(cache);
}

// Auto-advances the open period past any full 7-day windows that have
// elapsed since it started — computed lazily on read, no background timer
// needed.
function rollPeriodsForward(store: PasjonaciData): boolean {
  let changed = false;
  let open = store.periods[store.periods.length - 1];
  while (open.endedAt === null && Date.now() - open.startedAt >= ONE_WEEK_MS) {
    const endedAt = open.startedAt + ONE_WEEK_MS;
    open.endedAt = endedAt;
    open = { startedAt: endedAt, endedAt: null };
    store.periods.push(open);
    changed = true;
  }
  return changed;
}

// Called silently after every hand on a Pasjonaci-tagged table — upserts
// that table's current standings. No player-visible action required.
export function upsertSession(roomId: string, results: LeagueSessionResult[]): void {
  if (results.length === 0) return;
  const store = getStore();
  rollPeriodsForward(store);

  const existing = store.sessions.find((s) => s.id === roomId);
  if (existing) {
    existing.results = results;
    existing.playedAt = Date.now();
  } else {
    store.sessions.push({ id: roomId, playedAt: Date.now(), results });
  }
  persist();
}

// Anyone on the results page can close the week early — same trust model as
// everything else in this app (no accounts; whoever has the link is
// trusted), and the action only resets a running tally, it never deletes data.
export function closePeriodNow(): void {
  const store = getStore();
  rollPeriodsForward(store);
  const open = store.periods[store.periods.length - 1];
  const now = Date.now();
  open.endedAt = now;
  store.periods.push({ startedAt: now, endedAt: null });
  persist();
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

export interface PasjonaciView {
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

export function getPasjonaciView(): PasjonaciView {
  const store = getStore();
  if (rollPeriodsForward(store)) persist();

  const open = store.periods[store.periods.length - 1];
  const past = store.periods.slice(0, -1);

  return {
    currentPeriod: periodView(store.sessions, open.startedAt, null),
    pastPeriods: past.map((p) => periodView(store.sessions, p.startedAt, p.endedAt)).reverse(),
    allTime: periodView(store.sessions, 0, null),
    sessions: [...store.sessions].sort((a, b) => b.playedAt - a.playedAt),
  };
}
