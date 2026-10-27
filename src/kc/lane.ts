/**
 * KC lane support for the BusyBee GHL MCP server.
 *
 * A "lane" is one MCP server process started by the kc-ghl launcher for one GHL
 * account and one calling agent. Everything here is inert unless the launcher sets
 * KC_GHL_LANE, so upstream behavior is unchanged outside KC.
 *
 * Environment set by the launcher:
 *   KC_GHL_LANE              lane name (enables lane mode)
 *   KC_GHL_CALLER            calling agent, for the audit log (attribution, not auth)
 *   KC_GHL_PINNED_LOCATION   if set, every request must target this location
 *   KC_GHL_TOKEN_CACHE_DIR   shared Firebase ID-token cache directory
 *   KC_GHL_CREDENTIAL        stable name of the login (cache identity)
 *   KC_GHL_AUDIT_LOG         JSONL audit log path
 */
import { AsyncLocalStorage } from 'async_hooks';
import {
  appendFileSync, mkdirSync, readFileSync, statSync, renameSync, linkSync, unlinkSync,
} from 'fs';
import { dirname, join } from 'path';

export const kcSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const kcLaneMode = (): boolean => !!process.env.KC_GHL_LANE;
export const kcPinned = (): string | undefined => process.env.KC_GHL_PINNED_LOCATION || undefined;

// ─── Per-call deadline and cancellation ─────────────────────
// Hermes gives each MCP tool call 120 s. Every call (auth + all requests in a
// compound operation) must finish or refuse before then, so nothing lands after
// the caller has given up.
export const KC_CALL_BUDGET_MS = 100_000;
export const KC_AUTH_BUDGET_MS = 60_000;
export const KC_REQUEST_TIMEOUT_MS = 25_000;
/** A write is only sent if at least this much call time remains. */
export const KC_MIN_WRITE_WINDOW_MS = KC_REQUEST_TIMEOUT_MS + 2_000;

interface KcCallState { deadline: number; signal?: AbortSignal; tool: string }
const kcCall = new AsyncLocalStorage<KcCallState>();

/** Run one tool call with a deadline, the caller's cancellation signal, and an audit entry. */
export async function kcRunToolCall<T>(tool: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let ok = false;
  try {
    const out = await kcCall.run({ deadline: started + KC_CALL_BUDGET_MS, signal, tool }, fn);
    ok = !(out && typeof out === 'object' && (out as { success?: unknown }).success === false);
    return out;
  } finally {
    kcAudit(tool, ok, Date.now() - started);
  }
}

/** Milliseconds left in the current tool call (Infinity outside a call). */
export function kcRemainingMs(): number {
  const s = kcCall.getStore();
  return s ? s.deadline - Date.now() : Infinity;
}

/** Throw if the caller cancelled or the call budget is spent. */
export function kcCheckCall(what: string): void {
  const s = kcCall.getStore();
  if (!s) return;
  if (s.signal?.aborted) throw new Error(`KC lane: ${what} not sent, the caller cancelled this tool call`);
  if (Date.now() >= s.deadline) throw new Error(`KC lane: ${what} not sent, tool call time budget exhausted`);
}

/** Refuse to start a write that could still be running when the caller times out. */
export function kcCheckWrite(method: string): void {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(method)) return;
  kcCheckCall(`${method.toUpperCase()} request`);
  if (kcRemainingMs() < KC_MIN_WRITE_WINDOW_MS) {
    throw new Error(`KC lane: ${method.toUpperCase()} request not sent, too little time left in this tool call; nothing was changed`);
  }
}

/** Abort signal for one HTTP request: caller cancellation plus a timeout bounded by the call deadline. */
export function kcRequestSignal(maxMs: number = KC_REQUEST_TIMEOUT_MS): AbortSignal {
  const s = kcCall.getStore();
  const ms = Math.max(1, Math.min(maxMs, kcRemainingMs()));
  const t = AbortSignal.timeout(ms);
  return s?.signal ? AbortSignal.any([t, s.signal]) : t;
}

// ─── Audit log ──────────────────────────────────────────────
/** One JSONL line per tool call: who, which lane, which tool, result. Never arguments or results. */
export function kcAudit(tool: string, ok: boolean, ms: number): void {
  const file = process.env.KC_GHL_AUDIT_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      caller: process.env.KC_GHL_CALLER || 'unknown',
      lane: process.env.KC_GHL_LANE || 'unknown',
      tool,
      ok,
      ms,
    }) + '\n', { mode: 0o600 });
  } catch {
    // auditing must never break a tool call
  }
}

// ─── Identifiers ────────────────────────────────────────────
const KC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function kcAssertId(kind: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !KC_ID_RE.test(value)) {
    throw new Error(`KC lane guard: invalid ${kind}; expected a plain identifier`);
  }
}

/** Throw if a requested location differs from the lane's pinned location. */
export function kcAssertLocationAllowed(locationId: string): void {
  kcAssertId('location ID', locationId);
  const pin = kcPinned();
  if (pin && pin !== locationId) {
    throw new Error("KC lane guard: this lane is pinned to a different account");
  }
}

// ─── Public API guard ───────────────────────────────────────
const KC_LOC_KEYS = new Set(['locationId', 'location_id', 'locationIds', 'share_location_id', 'shareLocationId']);
let kcLocPathTemplates: RegExp[] | null = null;

/** Regexes for every official endpoint path that carries a {locationId} segment. */
function kcLocationPathTemplates(): RegExp[] {
  if (kcLocPathTemplates) return kcLocPathTemplates;
  const out: RegExp[] = [/^\/locations\/([^/]+)(?:\/|$)/];
  try {
    const spec = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'official-spec-endpoints.json'), 'utf8')) as { path?: string }[];
    for (const e of spec) {
      const p = e?.path;
      if (!p || !/\{(locationId|location_id)\}/.test(p)) continue;
      const parts = p.split('/').map((s) => {
        if (s === '{locationId}' || s === '{location_id}') return '([^/]+)';
        if (/^\{[^}]+\}$/.test(s)) return '[^/]+';
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      });
      out.push(new RegExp(`^${parts.join('/')}/?$`));
    }
  } catch {
    // catalog missing: the generic /locations/<id> rule still applies
  }
  kcLocPathTemplates = out;
  return out;
}

/** Collect every location value named anywhere in a request body (any depth, any form). */
function kcCollectBodyLocations(data: unknown, out: unknown[], depth = 0): void {
  if (data === undefined || data === null || depth > 8) return;
  if (typeof data === 'string') {
    const s = data.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { kcCollectBodyLocations(JSON.parse(s), out, depth + 1); } catch { /* not JSON */ }
    } else if (s.includes('=')) {
      kcCollectBodyLocations(new URLSearchParams(s), out, depth + 1);
    }
    return;
  }
  if (typeof data !== 'object') return;
  const d = data as { entries?: () => Iterable<[string, unknown]>; get?: unknown };
  if (typeof d.entries === 'function' && typeof d.get === 'function') { // URLSearchParams, FormData
    const rec: Record<string, unknown[]> = {};
    for (const [k, v] of d.entries()) (rec[k] ||= []).push(v);
    for (const [k, vs] of Object.entries(rec)) if (KC_LOC_KEYS.has(k)) out.push(...vs);
    if ((rec.altType || []).some((t) => String(t).toLowerCase() === 'location')) out.push(...(rec.altId || []));
    return;
  }
  if (Array.isArray(data)) { for (const x of data) kcCollectBodyLocations(x, out, depth + 1); return; }
  const r = data as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) {
    if (KC_LOC_KEYS.has(k)) {
      if (Array.isArray(v)) out.push(...v); else out.push(v);
    } else if (v && typeof v === 'object') {
      kcCollectBodyLocations(v, out, depth + 1);
    }
  }
  if (typeof r.altType === 'string' && r.altType.toLowerCase() === 'location') out.push(r.altId);
}

/**
 * Inside a pinned lane, every location named anywhere in a public API request must be
 * the lane's location. Checks the final serialized URL (after path normalization and
 * query merging) and the JSON body. Omitted values still default to the pin upstream;
 * an explicit different location is refused, not redirected.
 * `fullUrl` must be the URL axios will actually send (axios.getUri(config)).
 */
export function kcAssertPublicRequest(rawUrl: string, fullUrl: string, data: unknown): void {
  const pin = kcPinned();
  if (!pin) return;
  const block = () => { throw new Error("KC lane guard: blocked a public API request for a location outside this lane's account"); };
  const rawPath = rawUrl.split('?')[0];
  if (/\.\.|%|\\/i.test(rawPath)) {
    throw new Error('KC lane guard: blocked a public API request with an unsafe path');
  }
  const u = new URL(fullUrl);
  const named: unknown[] = [];
  for (const re of kcLocationPathTemplates()) {
    const m = u.pathname.match(re);
    // GHL location IDs are 20 alphanumerics; literal segments like /locations/search are endpoints, not accounts.
    if (m && /^[A-Za-z0-9]{20}$/.test(m[1])) named.push(m[1]);
  }
  const q = u.searchParams;
  for (const k of KC_LOC_KEYS) named.push(...q.getAll(k));
  if (q.getAll('altType').some((t) => t.toLowerCase() === 'location')) named.push(...q.getAll('altId'));
  kcCollectBodyLocations(data, named);
  for (const v of named) {
    if (v === undefined || v === null || v === '') continue;
    if (String(v) !== pin) block();
  }
}

// ─── Shared token cache: lock helpers ───────────────────────
export const KC_LOCK_ABANDONED_MS = 600_000; // treat as abandoned past this age even if the PID looks alive (PID reuse)
const KC_LOCK_INIT_GRACE_MS = 30_000; // an empty lock is a holder still writing its PID
export const kcHeldLocks = new Map<string, number>(); // lock path -> inode we created

function kcPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Remove a lock only if its holder is gone. Never removes a live holder's lock.
 * Residual risk (documented): under a three-way race around an abandoned lock, two
 * processes can briefly both refresh. The cost is one extra token exchange, never a
 * wrong account or a corrupt cache (writes are atomic renames of valid tokens).
 */
export function kcClaimAbandonedLock(lockFile: string): void {
  let st;
  let text = '';
  try {
    st = statSync(lockFile);
    text = readFileSync(lockFile, 'utf8').trim();
  } catch {
    return; // vanished or unreadable: wait and retry
  }
  const age = Date.now() - st.mtimeMs;
  let abandoned: boolean;
  if (text === '') abandoned = age > KC_LOCK_INIT_GRACE_MS; // holder may be between open and PID write
  else abandoned = !kcPidAlive(parseInt(text, 10)) || age > KC_LOCK_ABANDONED_MS;
  if (!abandoned) return;
  const claimed = `${lockFile}.abandoned-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockFile, claimed); // only one waiter can move a given inode
  } catch {
    return;
  }
  try {
    if (statSync(claimed).ino !== st.ino) {
      // We moved a fresh lock created in between. Put it back without overwriting anything.
      try { linkSync(claimed, lockFile); } catch { /* a newer lock exists; leave it */ }
    }
  } finally {
    try { unlinkSync(claimed); } catch { /* gone */ }
  }
}

export function kcReleaseLock(lockFile: string): void {
  const ino = kcHeldLocks.get(lockFile);
  kcHeldLocks.delete(lockFile);
  if (ino === undefined) return;
  try {
    // Never delete another holder's lock: inode and content (our PID) must both match.
    if (statSync(lockFile).ino === ino && readFileSync(lockFile, 'utf8').trim() === String(process.pid)) unlinkSync(lockFile);
  } catch { /* already gone */ }
}

/** Cache identity for a lane's login. Required in lane mode so two logins can never share a cache. */
export function kcCredentialName(): string {
  const c = process.env.KC_GHL_CREDENTIAL;
  if (kcLaneMode() && !c) throw new Error('KC token cache: KC_GHL_CREDENTIAL is not set for this lane');
  return c || 'unnamed';
}

process.once('exit', () => { for (const f of [...kcHeldLocks.keys()]) kcReleaseLock(f); });

/** `exp` (ms) of a 3-part JWT, or null if malformed. */
export function kcJwtExp(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((x) => !x)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
