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
import { randomUUID } from 'crypto';

// Railway sets this automatically once a volume is attached to the service.
// Falls back to a local ./data folder for development. Logged loudly at
// startup — if RAILWAY_VOLUME_MOUNT_PATH is ever unset in production, this
// silently falls back to the container's ephemeral local disk, which wipes
// the whole ledger on every redeploy. Check this log line first if data
// ever appears to have vanished.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'pasjonaci.json');
console.log(
  `[Pasjonaci] Data file: ${DATA_FILE} (RAILWAY_VOLUME_MOUNT_PATH=${process.env.RAILWAY_VOLUME_MOUNT_PATH ?? '<unset — using ephemeral local disk!>'})`,
);

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
//
// Settlement is entirely self-contained per session — there is no
// aggregation across sessions (no weekly/all-time running balance). Each
// night's debts are its own thing: computed straight from that session's
// results, and "paid" is recorded against that session only.
export interface LeagueSession {
  id: string; // == roomId
  playedAt: number; // last updated
  results: LeagueSessionResult[];
  payments?: Payment[];
}

// A real, recorded payment between two players for ONE session — not a UI
// flag. Once recorded it permanently offsets that session's settlement, so
// a debt that's been paid off stays paid off even if the session is edited
// later (an edit only rebalances that session's own numbers).
export interface Payment {
  id: string;
  from: string;
  to: string;
  amount: number;
  paidAt: number;
}

// A finished tournament's final standings — completely separate from the
// cash-game sessions/periods/balances above. Tournament chips aren't real
// money and don't feed the weekly ranking or settlement; this is purely a
// historical record shown in its own "Turnieje" tab.
export interface TournamentRecordEntry {
  nick: string;
  place: number; // 1 = winner
  amount: number; // prize won (0 if this place wasn't paid)
  // Whether THIS player used their one allowed rebuy — needed (together with
  // TournamentRecord.startingStack) to compute their net profit/loss
  // (amount - buy-in). Absent on records saved before this field existed.
  rebuy?: boolean;
}

export interface TournamentRecord {
  id: string;
  number: number; // 1, 2, 3... — used for the "Turniej N" label
  finishedAt: number;
  totalPlayers: number;
  poolTotal: number;
  // Total number of rebuys used across the whole tournament — the pool
  // already reflects each rebuy's extra buy-in; this is just the visible
  // summary count requested alongside it.
  rebuyCount: number;
  // Per-player buy-in — each entry's total invested is startingStack ×
  // (1 + (rebuy ? 1 : 0)). Absent on records saved before this field
  // existed, in which case net profit/loss can't be computed.
  startingStack?: number;
  results: TournamentRecordEntry[]; // ALL registered players, sorted by place ascending — not just the paid places
}

interface PasjonaciData {
  sessions: LeagueSession[];
  tournaments?: TournamentRecord[];
}

function loadStore(): PasjonaciData {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`[Pasjonaci] Loaded ${data.sessions?.length ?? 0} session(s) from ${DATA_FILE}`);
    return {
      sessions: data.sessions ?? [],
      tournaments: data.tournaments ?? [],
    };
  } catch (err) {
    // Logged loudly on purpose: this path means either a fresh ledger (fine,
    // expected on first run) or a lost/misconfigured volume (NOT fine —
    // any write from here on overwrites whatever was on disk, which is
    // exactly how a mount misconfiguration turns into permanent data loss).
    console.warn(
      `[Pasjonaci] Could not read ${DATA_FILE} — starting with an EMPTY ledger. If this isn't the first run, the data volume is likely missing or misconfigured. Reason:`,
      err instanceof Error ? err.message : err,
    );
    return { sessions: [], tournaments: [] };
  }
}

function saveStore(store: PasjonaciData): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

let cache: PasjonaciData | null = null;
function getStore(): PasjonaciData {
  if (!cache) cache = loadStore();
  return cache;
}
function persist(): void {
  if (cache) saveStore(cache);
}

// Admin-only — wipes the entire cash-game ledger (every session, its
// results, and its payment history). Tournaments are a separate record
// (see recordTournament) and are untouched by this.
export function resetLedger(): void {
  const store = getStore();
  store.sessions = [];
  persist();
  console.log('[Pasjonaci] Ledger reset — all sessions cleared');
}

// Called silently after every hand on a Pasjonaci-tagged table — upserts
// that table's current standings. No player-visible action required.
export function upsertSession(roomId: string, results: LeagueSessionResult[]): void {
  if (results.length === 0) return;
  const store = getStore();

  const existing = store.sessions.find((s) => s.id === roomId);
  if (existing) {
    existing.results = results;
    existing.playedAt = Date.now();
  } else {
    store.sessions.push({ id: roomId, playedAt: Date.now(), results });
  }
  persist();
}

// Called once, right when a Pasjonaci-tagged tournament table finishes —
// completely separate from upsertSession/the weekly cash-game ledger above.
// Tournament chips aren't real money and are never mixed into the Ranking.
export function recordTournament(
  results: TournamentRecordEntry[],
  totalPlayers: number,
  poolTotal: number,
  rebuyCount: number,
  startingStack: number,
): TournamentRecord {
  const store = getStore();
  if (!store.tournaments) store.tournaments = [];
  const record: TournamentRecord = {
    id: randomUUID(),
    number: store.tournaments.length + 1,
    finishedAt: Date.now(),
    totalPlayers,
    poolTotal,
    rebuyCount,
    startingStack,
    results: [...results].sort((a, b) => a.place - b.place),
  };
  store.tournaments.push(record);
  persist();
  console.log(`[Pasjonaci] Recorded "Turniej ${record.number}" — ${totalPlayers} players, ${rebuyCount} rebuy(s), pool ${poolTotal}, ${results.length} placements`);
  return record;
}

export function getTournaments(): TournamentRecord[] {
  const store = getStore();
  return [...(store.tournaments ?? [])].sort((a, b) => b.number - a.number);
}

// Admin-only — removes a manually-added or mistaken tournament record.
export function deleteTournament(id: string): boolean {
  const store = getStore();
  const before = (store.tournaments ?? []).length;
  store.tournaments = (store.tournaments ?? []).filter((t) => t.id !== id);
  if (store.tournaments.length === before) return false;
  persist();
  return true;
}

// ── Admin operations (password-gated in index.ts) ──────────────────────────

export function deleteSession(id: string): boolean {
  const store = getStore();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== id);
  if (store.sessions.length === before) return false;
  persist();
  return true;
}

export function editSession(id: string, results: LeagueSessionResult[]): boolean {
  const store = getStore();
  const session = store.sessions.find((s) => s.id === id);
  if (!session) return false;
  session.results = results;
  persist();
  return true;
}

// Strips a nick (case-insensitive) out of every session's results — used to
// pull a player out of the history entirely. Any payment in that session
// involving the removed nick goes with them (it no longer refers to a real
// participant). Sessions left with no participants are dropped.
export function removePlayer(nick: string): void {
  const store = getStore();
  const key = nickKey(nick);
  store.sessions = store.sessions
    .map((s) => ({
      ...s,
      results: s.results.filter((r) => nickKey(r.nick) !== key),
      payments: (s.payments ?? []).filter((p) => nickKey(p.from) !== key && nickKey(p.to) !== key),
    }))
    .filter((s) => s.results.length > 0);
  persist();
}

// ── Per-session settlement ──────────────────────────────────────────────
// No aggregation across sessions — each poker night settles on its own.
// "Balance" here just means that session's own net results (nick + how
// much they're up/down for that one night); settlement is the minimum set
// of transfers that clears those numbers, adjusted for whatever's already
// been paid within that same session.

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

function findSession(store: PasjonaciData, sessionId: string): LeagueSession | undefined {
  return store.sessions.find((s) => s.id === sessionId);
}

// Anyone can record their own payment — no password, matches "each person
// settles their own debt". This permanently offsets that session's
// settlement (see applyPayments) — it does NOT touch the underlying
// results, which stay pure poker performance regardless of who's paid whom.
export function recordPayment(sessionId: string, from: string, to: string, amount: number): boolean {
  const store = getStore();
  const session = findSession(store, sessionId);
  if (!session) return false;
  if (!session.payments) session.payments = [];
  session.payments.push({ id: randomUUID(), from, to, amount, paidAt: Date.now() });
  persist();
  return true;
}

// Undo a mistaken payment record — removes it entirely, so that session's
// settlement reverts to including that debt again.
export function undoPayment(sessionId: string, paymentId: string): boolean {
  const store = getStore();
  const session = findSession(store, sessionId);
  if (!session?.payments) return false;
  const idx = session.payments.findIndex((p) => p.id === paymentId);
  if (idx === -1) return false;
  session.payments.splice(idx, 1);
  persist();
  return true;
}

interface NetBalance {
  nick: string;
  net: number;
}

// Applies recorded payments on top of a session's raw net results — paying
// down a debt moves the payer's balance toward zero and the payee's
// balance toward zero by the same amount, so it always keeps the total
// exactly conserved.
function applyPayments(balances: NetBalance[], payments: Payment[]): NetBalance[] {
  if (!payments || payments.length === 0) return balances;
  const adjusted = balances.map((b) => ({ ...b }));
  const byKey = new Map(adjusted.map((b) => [nickKey(b.nick), b]));
  for (const p of payments) {
    const fromB = byKey.get(nickKey(p.from));
    const toB = byKey.get(nickKey(p.to));
    if (fromB) fromB.net += p.amount;
    if (toB) toB.net -= p.amount;
  }
  return adjusted;
}

// Canonical key for matching nicks case-insensitively, keeping the first-seen
// casing for display.
function nickKey(nick: string): string {
  return nick.trim().toLowerCase();
}

export interface RawSettlement {
  from: string;
  to: string;
  amount: number;
}

// Classic greedy minimum-transaction debt settlement (same approach
// Splitwise uses): largest debtor pays largest creditor, repeat.
export function simplifyDebts(balances: NetBalance[]): RawSettlement[] {
  const creditors = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ nick: b.nick, remaining: b.net }))
    .sort((a, b) => b.remaining - a.remaining);
  const debtors = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ nick: b.nick, remaining: -b.net }))
    .sort((a, b) => b.remaining - a.remaining);

  const settlements: RawSettlement[] = [];
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

export interface SessionView {
  id: string;
  playedAt: number;
  results: LeagueSessionResult[];
  settlements: Settlement[]; // still-outstanding debt for THIS session, after recorded payments
  payments: Payment[]; // history for THIS session, newest first — for the undo UI
}

export interface PasjonaciView {
  sessions: SessionView[]; // newest first
}

function sessionView(session: LeagueSession): SessionView {
  const balances: NetBalance[] = session.results.map((r) => ({ nick: r.nick, net: r.netResult }));
  const payments = session.payments ?? [];
  const settlements = simplifyDebts(applyPayments(balances, payments));
  return {
    id: session.id,
    playedAt: session.playedAt,
    results: session.results,
    settlements,
    payments: [...payments].sort((a, b) => b.paidAt - a.paidAt),
  };
}

export function getPasjonaciView(): PasjonaciView {
  const store = getStore();
  const sessions = [...store.sessions].sort((a, b) => b.playedAt - a.playedAt).map(sessionView);
  return { sessions };
}
