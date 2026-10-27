"""KC lane patch v2 (reviewer fixes from Fable 5.1 + Astra). Applies on top of v1 in a staging copy.
Exact-anchor replacements; aborts if any anchor is missing or ambiguous."""
import pathlib, sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/aya/.local/share/kc-ghl/busybee-next/src')

def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'ABORT {label}: anchor found {n} times')
    return text.replace(old, new)

def between(text, start, end, new, label):
    a = text.count(start); b = text.count(end)
    if a != 1 or b != 1:
        sys.exit(f'ABORT {label}: start {a} end {b}')
    i = text.index(start); j = text.index(end)
    if j <= i:
        sys.exit(f'ABORT {label}: end before start')
    return text[:i] + new + text[j:]

# ── workflow-builder-client.ts ──────────────────────────────
p = ROOT / 'clients/workflow-builder-client.ts'
t = p.read_text()

t = sub(t, "import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync, mkdirSync } from 'fs';",
        "import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync, mkdirSync, fstatSync, linkSync } from 'fs';", 'imports')

t = sub(t, "const kcSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));\n", r"""const kcSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── KC lane helpers ────────────────────────────────────────
// Auth (lock wait + refresh + backoff) is bounded so it always ends before the
// MCP per-call timeout (120 s): 90 s auth + 25 s request = 115 s worst case.
const KC_AUTH_BUDGET_MS = 90_000;
const KC_REQUEST_TIMEOUT_MS = 25_000;
const KC_LOCK_ABANDONED_MS = 600_000; // lock older than this is abandoned even if its PID looks alive (PID reuse)
const KC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const kcHeldLocks = new Map<string, number>(); // lock path -> inode we created

function kcAssertId(kind: string, value: string): void {
  if (typeof value !== 'string' || !KC_ID_RE.test(value)) {
    throw new Error(`KC lane guard: invalid ${kind}; expected a plain identifier`);
  }
}

function kcPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Remove a lock only if its holder is gone. Never removes a live holder's lock. */
function kcClaimAbandonedLock(lockFile: string): void {
  let st;
  let holder = NaN;
  try {
    st = statSync(lockFile);
    holder = parseInt(readFileSync(lockFile, 'utf8'), 10);
  } catch {
    return; // vanished or unreadable mid-write: just wait and retry
  }
  const abandoned = !kcPidAlive(holder) || Date.now() - st.mtimeMs > KC_LOCK_ABANDONED_MS;
  if (!abandoned) return;
  const claimed = `${lockFile}.abandoned-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockFile, claimed); // only one waiter can move a given inode
  } catch {
    return; // another waiter already moved it
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

function kcReleaseLock(lockFile: string): void {
  const ino = kcHeldLocks.get(lockFile);
  kcHeldLocks.delete(lockFile);
  if (ino === undefined) return;
  try {
    if (statSync(lockFile).ino === ino) unlinkSync(lockFile); // never delete another holder's lock
  } catch { /* already gone */ }
}

process.once('exit', () => { for (const f of [...kcHeldLocks.keys()]) kcReleaseLock(f); });

function kcJwtExp(token: unknown): number | null {
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
""", 'helpers')

# fromEnv: lanes take credentials only from the launcher
t = sub(t, "    // Load skill env file\n    if (existsSync(skillEnvPath)) {",
        "    const kcLane = !!process.env.KC_GHL_LANE;\n    // Load skill env file (never inside a KC lane: lanes take credentials only from the launcher)\n    if (!kcLane && existsSync(skillEnvPath)) {", 'fromEnv-file')
t = sub(t, "      refreshToken: get('GHL_REFRESH_TOKEN') || get('GHL_AUTH_REFRESH_TOKEN'),",
        "      refreshToken: kcLane ? '' : (get('GHL_REFRESH_TOKEN') || get('GHL_AUTH_REFRESH_TOKEN')),", 'fromEnv-jwt')
t = sub(t, "      envFilePath: skillEnvPath,\n", "      envFilePath: kcLane ? undefined : skillEnvPath,\n", 'fromEnv-persist')

# Firebase fetch: abortable
t = sub(t, "  private async refreshFirebaseToken(): Promise<void> {", "  private async refreshFirebaseToken(signal?: AbortSignal): Promise<void> {", 'fb-sig')
t = sub(t, "    const res = await fetch(url, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },",
        "    const res = await fetch(url, {\n      method: 'POST',\n      signal,\n      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },", 'fb-fetch')
t = sub(t, """    // Persist rotated refresh token
    if (data.refresh_token && data.refresh_token !== this.config.firebaseRefreshToken) {
      this.config.firebaseRefreshToken = data.refresh_token;
      this.persistToken('GHL_FIREBASE_REFRESH_TOKEN', data.refresh_token);
    }
""", """    // Persist rotated refresh token
    if (data.refresh_token && data.refresh_token !== this.config.firebaseRefreshToken) {
      if (process.env.KC_GHL_LANE) {
        // The vault is the source of truth for lanes; keep using it and make the rotation visible.
        process.stderr.write('[KC GHL] WARNING: Firebase returned a rotated refresh token; the vault still holds the previous value\\n');
      } else {
        this.config.firebaseRefreshToken = data.refresh_token;
        this.persistToken('GHL_FIREBASE_REFRESH_TOKEN', data.refresh_token);
      }
    }
""", 'fb-rotate')

# Replace the whole v1 cache block
t = between(t, "  /**\n   * KC shared token cache", "  /**\n   * Write a token back to the .env file", r"""  /**
   * KC shared token cache: one cached Firebase ID token per credential, shared by
   * every lane process using that credential. One refresh at a time (PID lock file);
   * waiters reuse the result. Retries Google quota (429) with backoff. The whole step
   * is bounded by KC_AUTH_BUDGET_MS.
   */
  private async refreshFirebaseTokenShared(): Promise<void> {
    const deadline = Date.now() + KC_AUTH_BUDGET_MS;
    const dir = process.env.KC_GHL_TOKEN_CACHE_DIR;
    if (!dir) {
      // Outside a KC lane: original upstream behavior (no shared cache, legacy TTL fallback).
      await this.refreshFirebaseTokenWithBackoff(deadline);
      this.tokenExpiry = (kcJwtExp(this.cachedIdToken) ?? Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS) - 120_000;
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Stable identity: the launcher's credential name plus the public Firebase web key.
    // Never derived from the refresh token, so a rotation cannot split the cache.
    const credential = process.env.KC_GHL_CREDENTIAL || 'unnamed';
    const id = createHash('sha256').update(`${credential}:${this.config.firebaseApiKey}`).digest('hex').slice(0, 24);
    const cacheFile = join(dir, `${id}.json`);
    const lockFile = join(dir, `${id}.lock`);
    const margin = 120_000;
    const useCache = (): boolean => {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as { idToken?: unknown; expiresAt?: unknown };
        const exp = kcJwtExp(c.idToken);
        if (exp !== null && c.expiresAt === exp && exp - Date.now() > margin) {
          this.cachedIdToken = c.idToken as string;
          this.tokenExpiry = exp - margin;
          return true;
        }
      } catch {
        // missing or unreadable cache
      }
      return false;
    };
    if (useCache()) return;

    let fd: number | null = null;
    while (fd === null) {
      if (Date.now() > deadline) throw new Error('KC token cache: timed out waiting for another lane to refresh');
      try {
        fd = openSync(lockFile, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        kcClaimAbandonedLock(lockFile);
        await kcSleep(500);
        if (useCache()) return;
      }
    }
    kcHeldLocks.set(lockFile, fstatSync(fd).ino);
    try {
      writeFileSync(fd, String(process.pid));
      if (useCache()) return;
      await this.refreshFirebaseTokenWithBackoff(deadline);
      const expiresAt = this.idTokenExpiry();
      this.tokenExpiry = expiresAt - margin;
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ idToken: this.cachedIdToken, expiresAt }), { mode: 0o600 });
      renameSync(tmp, cacheFile);
      process.stderr.write('[KC GHL] Firebase token refreshed and shared\n');
    } finally {
      closeSync(fd);
      kcReleaseLock(lockFile);
    }
  }

  private async refreshFirebaseTokenWithBackoff(deadline: number): Promise<void> {
    const waits = [5_000, 10_000, 20_000];
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 1_000) throw new Error('KC token cache: auth time budget exhausted');
      try {
        await this.refreshFirebaseToken(AbortSignal.timeout(Math.min(15_000, remaining)));
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const wait = waits[attempt];
        if (!msg.includes('(429)') || wait === undefined || Date.now() + wait + 1_000 > deadline) throw err;
        process.stderr.write(`[KC GHL] Firebase token quota hit; retrying in ${wait / 1000}s\n`);
        await kcSleep(wait);
      }
    }
  }

  /** Expiry of the current ID token. Throws on a malformed token; no fallback lifetime. */
  private idTokenExpiry(): number {
    const exp = kcJwtExp(this.cachedIdToken);
    if (exp === null) {
      this.cachedIdToken = null;
      throw new Error('KC token cache: Firebase returned a malformed ID token');
    }
    return exp;
  }

""", 'cache-block')

# request(): canonical-URL guard, path hygiene, timeout
t = sub(t, """    // KC lane guard: every workflow request must target this lane's pinned account.
    const pinned = process.env.KC_GHL_PINNED_LOCATION;
    if (pinned && path.split(/[/?]/)[1] !== pinned) {
      throw new Error("KC lane guard: blocked a workflow request outside this lane's account");
    }
    const headers = await this.getHeaders();
    const url = `${WorkflowBuilderClient.BASE_URL}${path}`;

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);""", """    // KC lane guard: reject path tricks, then check the URL fetch will actually send.
    if (/\\.\\.|\\\\|%|#/.test(path)) {
      throw new Error('KC lane guard: blocked a workflow request with an unsafe path');
    }
    const url = new URL(`${WorkflowBuilderClient.BASE_URL}${path}`);
    const pinned = process.env.KC_GHL_PINNED_LOCATION;
    if (pinned) {
      const prefix = `/workflow/${pinned}`;
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
        throw new Error("KC lane guard: blocked a workflow request outside this lane's account");
      }
    }
    const headers = await this.getHeaders();

    const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(KC_REQUEST_TIMEOUT_MS) };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);""", 'request')

# ID validation on every workflow-ID entry point
t = sub(t, "  async getWorkflow(workflowId: string): Promise<WorkflowFull> {\n",
        "  async getWorkflow(workflowId: string): Promise<WorkflowFull> {\n    kcAssertId('workflow ID', workflowId);\n", 'id-get')
t = sub(t, "  async deleteWorkflow(workflowId: string): Promise<void> {\n",
        "  async deleteWorkflow(workflowId: string): Promise<void> {\n    kcAssertId('workflow ID', workflowId);\n", 'id-del')
t = sub(t, "    // Get current state for version\n    const current = await this.getWorkflow(workflowId);",
        "    kcAssertId('workflow ID', workflowId);\n    // Get current state for version\n    const current = await this.getWorkflow(workflowId);", 'id-upd')
p.write_text(t)

# ── server.ts: no ambient .env inside a lane ────────────────
p = ROOT / 'server.ts'
t = p.read_text()
t = sub(t, "\ndotenv.config();\n", "\n// KC lanes get credentials only from the kc-ghl launcher; never from a stray .env.\nif (!process.env.KC_GHL_LANE) dotenv.config();\n", 'dotenv')
p.write_text(t)

# ── ghl-api-client.ts: public-API location pin ──────────────
p = ROOT / 'clients/ghl-api-client.ts'
t = p.read_text()
t = sub(t, "import { resolveRequestVersion } from './endpoint-version-resolver.js';\n", r"""import { resolveRequestVersion } from './endpoint-version-resolver.js';

/**
 * KC lane guard for the public API: inside a pinned lane, any location named in the
 * URL path, query, or JSON body must be the lane's location. Omitted values default
 * to the pinned location as before; an explicit different location is refused, not redirected.
 */
function kcAssertPublicLocation(config: AxiosRequestConfig): void {
  const pinned = process.env.KC_GHL_PINNED_LOCATION;
  if (!pinned) return;
  const found: unknown[] = [];
  const scan = (o: unknown) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    const r = o as Record<string, unknown>;
    found.push(r.locationId, r.location_id);
    if (typeof r.altType === 'string' && r.altType.toLowerCase() === 'location') found.push(r.altId);
  };
  scan(config.params);
  let data: unknown = config.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = undefined; } }
  scan(data);
  const url = String(config.url || '');
  const pathMatch = url.match(/\/locations\/([A-Za-z0-9]{20})(?=[/?#]|$)/);
  if (pathMatch) found.push(pathMatch[1]);
  const q = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : null;
  if (q) {
    found.push(q.get('locationId'), q.get('location_id'));
    if ((q.get('altType') || '').toLowerCase() === 'location') found.push(q.get('altId'));
  }
  for (const v of found) {
    if (v === undefined || v === null || v === '') continue;
    if (String(v) !== pinned) {
      throw new Error("KC lane guard: blocked a public API request for a location outside this lane's account");
    }
  }
}
""", 'pub-helper')
t = sub(t, "    this.axiosInstance.interceptors.request.use(\n      (config) => {\n",
        "    this.axiosInstance.interceptors.request.use(\n      (config) => {\n        kcAssertPublicLocation(config);\n", 'pub-intercept')
p.write_text(t)
print('v2 patches applied to', ROOT)
