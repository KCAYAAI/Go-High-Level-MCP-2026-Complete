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
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createServer, type Server } from 'net';

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

interface KcCallState { deadline: number; signal?: AbortSignal; tool: string; location?: string }
const kcCall = new AsyncLocalStorage<KcCallState>();

/** Run one tool call with a deadline, the caller's cancellation signal, and an audit entry. */
export async function kcRunToolCall<T>(tool: string, signal: AbortSignal | undefined, fn: () => Promise<T>, location?: string): Promise<T> {
  const started = Date.now();
  let ok = false;
  try {
    const out = await kcCall.run({ deadline: started + KC_CALL_BUDGET_MS, signal, tool, location }, fn);
    const o = out as { success?: unknown; isError?: unknown } | undefined;
    ok = !(o && typeof o === 'object' && (o.success === false || o.isError === true));
    return out;
  } finally {
    kcAudit(tool, ok, Date.now() - started);
  }
}

/** Agency lane: the sub-account this tool call targets (undefined = the lane default). */
export function kcTargetLocation(): string | undefined {
  return kcCall.getStore()?.location;
}

export const KC_LOCATION_ARG = {
  type: 'string',
  description: "Sub-account (location) ID to run this tool in. Optional: defaults to this connection's account. "
    + 'Only the agency connection accepts other sub-accounts.',
};

/**
 * Agency lane: read and validate a per-call locationId. Returns the target and the args to pass on
 * (stripped of locationId when the tool does not declare it natively).
 */
export function kcSplitLocationArg(args: Record<string, unknown>, nativeLocationArg: boolean): { location?: string; args: Record<string, unknown> } {
  const raw = args.locationId;
  if (raw === undefined || raw === null || raw === '') return { args };
  if (typeof raw !== 'string' || !/^[A-Za-z0-9]{20}$/.test(raw)) throw new Error('KC lane guard: locationId must be a 20-character sub-account ID');
  kcAssertLocationAllowed(raw);
  if (kcLaneMode() && !kcPinned()) {
    const tokens = kcLocationTokens();
    if (tokens.size > 0 && raw !== process.env.GHL_LOCATION_ID && !tokens.has(raw)) {
      throw new Error(`KC agency lane: sub-account ${raw} is not registered in this lane (add it with kc-ghl --add-subaccount)`);
    }
  }
  if (nativeLocationArg) return { location: raw, args };
  const { locationId: _drop, ...rest } = args;
  return { location: raw, args: rest };
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

export const kcIsWrite = (method: string): boolean => /^(POST|PUT|PATCH|DELETE)$/i.test(method);

/** Refuse to start a write that could still be running when the caller times out. */
export function kcCheckWrite(method: string): void {
  if (!kcIsWrite(method)) return;
  kcCheckCall(`${method.toUpperCase()} request`);
  if (kcRemainingMs() < KC_MIN_WRITE_WINDOW_MS) {
    throw new Error(`KC lane: this ${method.toUpperCase()} request was not sent (too little time left in this tool call)`);
  }
}

/**
 * Right before the first write of a multi-step operation: refuse to start unless there is time for
 * every request from that write on (reads before the first write are not counted) (each bounded by KC_REQUEST_TIMEOUT_MS, the last write needing the full
 * write window). Prevents half-finished creates when auth already used most of the call.
 */
export function kcPlanRequests(operation: string, requests: number): void {
  const s = kcCall.getStore();
  if (!s) return;
  kcCheckCall(operation);
  const needed = (requests - 1) * KC_REQUEST_TIMEOUT_MS + KC_MIN_WRITE_WINDOW_MS;
  if (kcRemainingMs() < needed) {
    throw new Error(`KC lane: ${operation} not started; not enough time left in this tool call for its ${requests} requests. Nothing was sent; it is safe to retry.`);
  }
}

/** Error for a write that was dispatched but did not finish: GHL may or may not have applied it. */
export function kcUnknownOutcome(method: string, what: string): Error {
  return new Error(`KC lane: ${method.toUpperCase()} ${what} was sent but did not finish in time; GHL may or may not have applied it. Check the current state before retrying.`);
}

/** A multi-step operation that created something before a later step failed. */
export class KcPartialWriteError extends Error {
  constructor(public readonly createdId: string, public readonly completed: string, public readonly failedStep: string, cause: unknown) {
    super(`${failedStep} failed after ${completed} (id ${createdId}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'KcPartialWriteError';
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
const KC_LOC_KEYS = new Set(['locationid', 'location_id', 'locationids', 'share_location_id', 'sharelocationid']);
/** The catalog has 58 location-scoped templates today; far fewer means it failed to load properly. */
export const KC_MIN_CATALOG_TEMPLATES = 20;
let kcLocPathTemplates: RegExp[] | null = null;
let kcAgencyOnlyTemplates: RegExp[] = [];
let kcCatalogPath = join(__dirname, '..', 'tools', 'official-spec-endpoints.json');

/** Test hook: point the guard at a different catalog file and drop the cached templates. */
export function kcSetCatalogPathForTests(path: string): void {
  kcCatalogPath = path;
  kcLocPathTemplates = null;
  kcAgencyOnlyTemplates = [];
}

function kcTemplateRegex(path: string, captureLocation: boolean): RegExp {
  const parts = path.split('/').map((s) => {
    if (captureLocation && (s === '{locationId}' || s === '{location_id}')) return '([^/]+)';
    if (/^\{[^}]+\}$/.test(s)) return '[^/]+';
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}/?$`, 'i');
}

/**
 * Regexes for every official endpoint path that carries a {locationId} segment, case-insensitive
 * (GHL's router is). Fails closed: a pinned lane refuses public calls if the catalog is unreadable,
 * malformed, or suspiciously small, instead of silently checking only /locations/<id>.
 */
function kcLocationPathTemplates(): RegExp[] {
  if (kcLocPathTemplates) return kcLocPathTemplates;
  const out: RegExp[] = [/^\/locations\/([^/]+)(?:\/|$)/i];
  let spec: unknown;
  try {
    spec = JSON.parse(readFileSync(kcCatalogPath, 'utf8'));
  } catch (e) {
    throw new Error(`KC lane guard: endpoint catalog unreadable (${(e as Error).name}); public API calls are blocked in this lane`);
  }
  if (!Array.isArray(spec)) throw new Error('KC lane guard: endpoint catalog malformed; public API calls are blocked in this lane');
  const agencyOnly: RegExp[] = [];
  for (const e of spec as { path?: unknown; securitySchemes?: unknown }[]) {
    const p = e?.path;
    if (typeof p !== 'string') continue;
    const schemes = Array.isArray(e.securitySchemes) ? (e.securitySchemes as string[]) : [];
    const agency = schemes.some((s) => s.startsWith('Agency-Access'));
    const location = schemes.some((s) => s.startsWith('Location-Access'));
    if (agency && !location) agencyOnly.push(kcTemplateRegex(p, false));
    if (/\{(locationId|location_id)\}/.test(p)) out.push(kcTemplateRegex(p, true));
  }
  kcAgencyOnlyTemplates = agencyOnly;
  if (out.length - 1 < KC_MIN_CATALOG_TEMPLATES) {
    throw new Error(`KC lane guard: endpoint catalog has only ${out.length - 1} location templates; public API calls are blocked in this lane`);
  }
  process.stderr.write(`[KC GHL] public API guard loaded ${out.length - 1} location-scoped endpoint templates\n`);
  kcLocPathTemplates = out;
  return out;
}

/** True if a form/query key names a location: `locationId`, `locationIds[]`, `locationIds[0]`, `filter[locationId]`. */
function kcIsLocationKey(key: string): boolean {
  return key.toLowerCase().split(/[[\]]+/).some((part) => part !== '' && KC_LOC_KEYS.has(part));
}

function kcIsAltTypeKey(key: string): boolean {
  return key.toLowerCase().split(/[[\]]+/).some((part) => part === 'alttype');
}

function kcIsAltIdKey(key: string): boolean {
  return key.toLowerCase().split(/[[\]]+/).some((part) => part === 'altid');
}

/** Location values named in a flat key/value list (query string, form body, FormData). */
function kcCollectPairs(pairs: Iterable<[string, unknown]>, out: unknown[]): void {
  const list = [...pairs];
  for (const [k, v] of list) if (kcIsLocationKey(k)) out.push(v);
  if (list.some(([k, v]) => kcIsAltTypeKey(k) && String(v).toLowerCase() === 'location')) {
    for (const [k, v] of list) if (kcIsAltIdKey(k)) out.push(v);
  }
}

/**
 * A path segment captured where a location belongs is acceptable only if it is the pin or a
 * literal endpoint word (letters and hyphens, shorter than an ID, e.g. /locations/search).
 * Anything else (another ID, an ID with junk appended) is treated as another account.
 */
function kcSegmentIsOtherAccount(seg: string, pin: string): boolean {
  if (seg === pin) return false;
  return seg.length >= 20 || !/^[A-Za-z-]+$/.test(seg);
}

/** All primitive values under a location key (arrays, objects, nested). */
const KC_MAX_INSPECT_DEPTH = 12;
const kcTooDeep = (): never => { throw new Error('KC lane guard: request body is nested too deeply to inspect; refused'); };

function kcCollectLeaves(v: unknown, out: unknown[], depth: number): void {
  if (v === null || v === undefined) return;
  if (depth > KC_MAX_INSPECT_DEPTH) kcTooDeep();
  if (typeof v !== 'object') { out.push(v); return; }
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) kcCollectLeaves(x, out, depth + 1);
}

/** Collect every location value named anywhere in a request body (any depth, any form). */
function kcCollectBodyLocations(data: unknown, out: unknown[], depth = 0): void {
  if (data === undefined || data === null) return;
  if (depth > KC_MAX_INSPECT_DEPTH) kcTooDeep();
  if (typeof data === 'string') {
    const s = data.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      let parsed: unknown;
      let isJson = true;
      try { parsed = JSON.parse(s); } catch { isJson = false; }
      if (isJson) kcCollectBodyLocations(parsed, out, depth + 1); // outside the catch: inspection errors propagate
    } else if (s.includes('=')) {
      kcCollectBodyLocations(new URLSearchParams(s), out, depth + 1);
    }
    return;
  }
  if (typeof data !== 'object') return;
  const d = data as { entries?: () => Iterable<[string, unknown]>; get?: unknown };
  if (typeof d.entries === 'function' && typeof d.get === 'function') { // URLSearchParams, FormData
    kcCollectPairs(d.entries(), out);
    return;
  }
  if (Array.isArray(data)) { for (const x of data) kcCollectBodyLocations(x, out, depth + 1); return; }
  const r = data as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) {
    if (kcIsLocationKey(k)) {
      kcCollectLeaves(v, out, depth + 1); // every value under a location key counts, at any depth
    } else if (v && typeof v === 'object') {
      kcCollectBodyLocations(v, out, depth + 1);
    }
  }
  const altType = Object.entries(r).find(([k]) => kcIsAltTypeKey(k))?.[1];
  if (typeof altType === 'string' && altType.toLowerCase() === 'location') {
    for (const [k, v] of Object.entries(r)) if (kcIsAltIdKey(k)) out.push(v);
  }
}

/** Parse the final URL after refusing traversal, encoding, backslashes, dot/empty segments, control characters. */
function kcSafeUrl(rawUrl: string, fullUrl: string, baseUrl?: string): URL {
  const unsafe = () => { throw new Error('KC lane guard: blocked a public API request with an unsafe path'); };
  if (baseUrl) {
    // Tokens only ever go to the configured API host; an absolute URL to anywhere else is refused.
    const origin = new URL(baseUrl).origin;
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) && !rawUrl.toLowerCase().startsWith(origin.toLowerCase() + '/')) {
      throw new Error('KC lane guard: blocked a public API request to a host other than the GHL API');
    }
    if (new URL(fullUrl).origin !== origin) throw new Error('KC lane guard: blocked a public API request to a host other than the GHL API');
  }
  const rawPath = rawUrl.split('?')[0].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  if (/\.\.|%|\\|[\x00-\x1f\x7f]/.test(rawPath) || /(^|\/)\.(\/|$)/.test(rawPath) || rawPath.includes('//')) unsafe();
  const u = new URL(fullUrl);
  // Final path: no empty segments (an edge server that merges slashes would see a different route).
  if (u.pathname.includes('//')) unsafe();
  return u;
}

// ─── Agency lane: per-sub-account token routing ─────────────
// GHL agency private integrations only carry agency-level scopes; sub-account data needs that
// sub-account's own private integration. The launcher passes them as KC_GHL_LOCATION_TOKENS
// (JSON {locationId: token}); each public request is sent with the token of the one sub-account
// it names. Agency-only endpoints keep the agency token (GHL_API_KEY).
let kcLocTokenMap: Map<string, string> | null = null;

/**
 * Agency-level paths not described in the endpoint catalog. Variables, not code: extend per lane with
 * KC_GHL_AGENCY_PATHS (comma-separated path prefixes) in the lane registry's "env".
 */
export const KC_DEFAULT_AGENCY_PATHS = [
  '/locations/search', '/companies/', '/users/search', '/snapshots', '/saas', '/saas-api', '/oauth',
  '/custom-menus', '/marketplace', '/phone-system/number-pools',
];

function kcIsAgencyPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  if (p === '/locations' || p === '/locations/') return true; // create/list sub-accounts
  const extra = (process.env.KC_GHL_AGENCY_PATHS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...KC_DEFAULT_AGENCY_PATHS, ...extra].some((prefix) => p.startsWith(prefix.toLowerCase()))
    || kcAgencyOnlyTemplates.some((re) => re.test(pathname));
}

function kcLocationTokens(): Map<string, string> {
  if (kcLocTokenMap) return kcLocTokenMap;
  const m = new Map<string, string>();
  const raw = process.env.KC_GHL_LOCATION_TOKENS;
  if (raw) {
    let o: unknown;
    try { o = JSON.parse(raw); } catch { throw new Error('KC agency lane: KC_GHL_LOCATION_TOKENS is not valid JSON'); }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/^[A-Za-z0-9]{20}$/.test(k) && typeof v === 'string' && v) m.set(k, v);
    }
  }
  kcLocTokenMap = m;
  return m;
}

/** Test hook. */
export function kcResetLocationTokensForTests(): void {
  kcLocTokenMap = null;
}

/**
 * Unpinned (agency) lane only: the bearer token this public request must carry, or undefined to
 * keep the agency token. Agency-only endpoints keep the agency token; a request naming one
 * sub-account uses that sub-account's token; naming several is refused; naming none uses the lane's
 * default sub-account (GHL_LOCATION_ID) token. Agency endpoints (catalog Agency-Access-only, plus
 * KC_DEFAULT_AGENCY_PATHS and KC_GHL_AGENCY_PATHS) always keep the agency token.
 */
export function kcAgencyTokenFor(rawUrl: string, fullUrl: string, data: unknown, baseUrl?: string): string | undefined {
  if (!kcLaneMode() || kcPinned()) return undefined;
  const tokens = kcLocationTokens();
  if (tokens.size === 0) return undefined;
  const u = kcSafeUrl(rawUrl, fullUrl, baseUrl);
  const templates = kcLocationPathTemplates(); // also loads the agency-only list
  if (kcIsAgencyPath(u.pathname)) return undefined;
  const named: unknown[] = [];
  for (const re of templates) {
    const m = u.pathname.match(re);
    if (m && /^[A-Za-z0-9]{20}$/.test(m[1])) named.push(m[1]);
  }
  kcCollectPairs(u.searchParams.entries(), named);
  kcCollectBodyLocations(data, named);
  const locs = new Set(named.filter((v) => v !== undefined && v !== null && v !== '').map(String));
  if (locs.size > 1) throw new Error('KC agency lane: this request names more than one sub-account; send one request per sub-account');
  const target = kcTargetLocation();
  if (target && locs.size === 1 && !locs.has(target)) {
    throw new Error('KC agency lane: this request names a different sub-account than the one the tool call selected; refused');
  }
  const loc = locs.size === 1 ? [...locs][0] : (target ?? process.env.GHL_LOCATION_ID);
  if (!loc) return undefined;
  const tok = tokens.get(loc);
  if (!tok) {
    if (locs.size === 0) return undefined;
    throw new Error(`KC agency lane: no sub-account token for location ${loc}; add one to the lane registry (see kc/README.md)`);
  }
  return tok;
}

/**
 * Inside a pinned lane, every location named anywhere in a public API request must be
 * the lane's location. Checks the final serialized URL (after path normalization and
 * query merging) and the JSON body. Omitted values still default to the pin upstream;
 * an explicit different location is refused, not redirected.
 * `fullUrl` must be the URL axios will actually send (axios.getUri(config)).
 */
export function kcAssertPublicRequest(rawUrl: string, fullUrl: string, data: unknown, baseUrl?: string): void {
  const pin = kcPinned();
  if (!pin) return;
  const block = () => { throw new Error("KC lane guard: blocked a public API request for a location outside this lane's account"); };
  const u = kcSafeUrl(rawUrl, fullUrl, baseUrl);
  const named: unknown[] = [];
  for (const re of kcLocationPathTemplates()) {
    const m = u.pathname.match(re);
    if (m && kcSegmentIsOtherAccount(m[1], pin)) block();
  }
  kcCollectPairs(u.searchParams.entries(), named);
  kcCollectBodyLocations(data, named);
  for (const v of named) {
    if (v === undefined || v === null || v === '') continue;
    if (String(v) !== pin) block();
  }
}

// ─── Shared token cache: refresh lock ───────────────────────
/**
 * One refresh per login at a time, across every lane process and the token keeper. The lock is a
 * Linux abstract Unix socket name: binding it is atomic and exclusive, and the kernel frees it the
 * instant the holder exits or crashes, so there are no lock files, stale PIDs, or take-over races.
 * The keeper (Python) binds the same name. Abstract names are per network namespace and not
 * permission-checked; on this single-user host the worst a squatter could do is delay refreshes.
 */
export function kcLockName(cacheId: string): string {
  return `\0kc-ghl-refresh-${cacheId}`;
}

/** Try once to take the lock. Resolves the held server, or null if another process holds it. */
export function kcTryLock(name: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const s = createServer((sock) => sock.destroy());
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    s.listen({ path: name }, () => { s.unref(); resolve(s); });
  });
}

export function kcUnlock(s: Server | null): void {
  try { s?.close(); } catch { /* already closed */ }
}

/** Cache identity for a lane's login. Required in lane mode so two logins can never share a cache. */
export function kcCredentialName(): string {
  const c = process.env.KC_GHL_CREDENTIAL;
  if (kcLaneMode() && !c) throw new Error('KC token cache: KC_GHL_CREDENTIAL is not set for this lane');
  return c || 'unnamed';
}



/**
 * A lane never writes the vault. If Firebase hands back a new refresh token, the lane leaves it
 * here (0600, in the 0700 cache dir) for kc-ghl-token-keeper, the single writer, to verify and
 * promote into the vault. Without this, a provider that revokes the old token on rotation would
 * strand the login.
 */
export function kcStashRotatedRefreshToken(cacheFile: string | null, token: string): void {
  if (!cacheFile) return;
  const pending = cacheFile.replace(/\.json$/, '.refresh-pending');
  const tmp = `${pending}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, pending);
  } catch {
    // best effort; the keeper still refreshes from the vault
  }
}

/** `iat` (ms) of a 3-part JWT, or null if malformed. */
export function kcJwtIat(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((x) => !x)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { iat?: unknown };
    return typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? claims.iat * 1000 : null;
  } catch {
    return null;
  }
}

/** A token GHL rejected less than this long after it was minted points at another cause (e.g. the private integration). */
export const KC_FRESH_TOKEN_MS = 60_000;

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
