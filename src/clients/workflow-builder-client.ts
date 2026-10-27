/**
 * GHL Workflow Builder Client
 * 
 * Uses the hidden internal GHL workflow API at backend.leadconnectorhq.com/workflow.
 * Auth via Firebase token refresh (browser-free).
 * 
 * The public GHL API only lists workflows — this client can CREATE, UPDATE, DELETE,
 * PUBLISH, and CLONE workflows with full action/trigger support.
 */

import { randomUUID, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync, mkdirSync, fstatSync, linkSync } from 'fs';
import { resolve, join } from 'path';

const kcSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// ─── Types ──────────────────────────────────────────────────

export interface WorkflowAction {
  id?: string;
  order?: number;
  name: string;
  type: string;
  attributes?: Record<string, unknown>;
  /**
   * Linear steps store a single next id (string). Only branch points
   * (if/else, multi-path) store an array of branch ids.
   */
  next?: string | string[];
  parentKey?: string;
  parent?: string;
  cat?: string;
  nodeType?: string;
  sibling?: string[];
}

export interface WorkflowTrigger {
  id?: string;
  type: string;
  name?: string;
  workflowId?: string;
  data?: Record<string, unknown>;
}

export interface WorkflowListItem {
  _id: string;
  name: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowFull {
  _id: string;
  name: string;
  status: string;
  version: number;
  dataVersion?: number;
  timezone?: string;
  workflowData?: {
    templates: WorkflowAction[];
  };
  triggers?: WorkflowTrigger[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface WorkflowBuilderConfig {
  apiKey: string;
  firebaseApiKey: string;
  firebaseRefreshToken: string;
  /** v2 JWT refresh token (30-day, preferred over Firebase) */
  refreshToken?: string;
  locationId: string;
  userId: string;
  companyId?: string;
  envFilePath?: string;
}

// ─── Client ─────────────────────────────────────────────────

export class WorkflowBuilderClient {
  private config: WorkflowBuilderConfig;
  private cachedIdToken: string | null = null;
  private cachedJwt: string | null = null;
  private tokenExpiry: number = 0;

  private static readonly BASE_URL = 'https://backend.leadconnectorhq.com/workflow';
  private static readonly FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
  private static readonly JWT_REFRESH_URL = 'https://services.leadconnectorhq.com/auth/refresh';
  private static readonly TOKEN_TTL_MS = 55 * 60 * 1000; // 55 minutes (tokens last 60)

  constructor(config: WorkflowBuilderConfig) {
    this.config = config;
    // KC lane guard: the client must use the lane's pinned account.
    const pinned = process.env.KC_GHL_PINNED_LOCATION;
    if (pinned && pinned !== config.locationId) {
      throw new Error("KC lane guard: workflow client account does not match this lane's pinned account");
    }
  }

  /**
   * Create from environment variables. Reads from the workflow builder .env file
   * and falls back to process.env.
   */
  static fromEnv(): WorkflowBuilderClient {
    // Try loading from the skill's .env file
    const skillEnvPath = resolve(
      process.env.HOME || '/Users/jakeshore',
      '.clawdbot/workspace/skills/ghl-workflow-builder/.env'
    );

    const envVars: Record<string, string> = {};

    const kcLane = !!process.env.KC_GHL_LANE;
    // Load skill env file (never inside a KC lane: lanes take credentials only from the launcher)
    if (!kcLane && existsSync(skillEnvPath)) {
      for (const line of readFileSync(skillEnvPath, 'utf8').split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const key = line.slice(0, eqIdx).trim();
          const val = line.slice(eqIdx + 1).trim();
          if (key && val) envVars[key] = val;
        }
      }
    }

    // Process.env overrides
    const get = (key: string): string => process.env[key] || envVars[key] || '';

    const config: WorkflowBuilderConfig = {
      apiKey: get('GHL_API_KEY'),
      firebaseApiKey: get('GHL_FIREBASE_API_KEY'),
      firebaseRefreshToken: get('GHL_FIREBASE_REFRESH_TOKEN'),
      refreshToken: kcLane ? '' : (get('GHL_REFRESH_TOKEN') || get('GHL_AUTH_REFRESH_TOKEN')),
      locationId: get('GHL_LOCATION_ID') || 'DZEpRd43MxUJKdtrev9t',
      userId: get('GHL_USER_ID') || '8Uy3ls0B517vLO2tSNva',
      companyId: get('GHL_COMPANY_ID'),
      envFilePath: kcLane ? undefined : skillEnvPath,
    };

    // v2 JWT refresh is preferred; fall back to Firebase
    if (!config.refreshToken && (!config.firebaseApiKey || !config.firebaseRefreshToken)) {
      throw new Error(
        'Workflow builder requires GHL_REFRESH_TOKEN (v2 JWT) or GHL_FIREBASE_API_KEY + GHL_FIREBASE_REFRESH_TOKEN. ' +
        `Checked: ${skillEnvPath} and process.env`
      );
    }

    return new WorkflowBuilderClient(config);
  }

  // ─── Auth ───────────────────────────────────────────────

  /**
   * Get authenticated headers. Uses v2 JWT if available, falls back to Firebase.
   */
  private async getHeaders(): Promise<Record<string, string>> {
    // Prefer v2 JWT refresh flow
    if (this.config.refreshToken) {
      if (!this.cachedJwt || Date.now() >= this.tokenExpiry) {
        await this.refreshJWT();
      }
      return {
        'Authorization': `Bearer ${this.cachedJwt}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
        'channel': 'APP',
        'source': 'WEB_USER',
      };
    }

    // Legacy Firebase flow
    if (!this.cachedIdToken || Date.now() >= this.tokenExpiry) {
      await this.refreshFirebaseTokenShared();
    }
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'token-id': this.cachedIdToken!,
      'channel': 'APP',
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
    };
  }

  /**
   * Refresh v2 JWT via services.leadconnectorhq.com/auth/refresh.
   * Returns a 1-hour JWT and rotates the 30-day refresh token.
   */
  private async refreshJWT(): Promise<void> {
    const res = await fetch(WorkflowBuilderClient.JWT_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.config.refreshToken }),
    });

    const data = await res.json() as {
      jwt?: string;
      refreshJwt?: string;
      traceId?: string;
    };

    if ((res.status !== 200 && res.status !== 201) || !data.jwt) {
      throw new Error(
        `JWT refresh failed (${res.status}): ${JSON.stringify(data)}`
      );
    }

    this.cachedJwt = data.jwt;
    this.tokenExpiry = Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS;

    // Persist rotated refresh token
    if (data.refreshJwt && data.refreshJwt !== this.config.refreshToken) {
      this.config.refreshToken = data.refreshJwt;
      this.persistToken('GHL_REFRESH_TOKEN', data.refreshJwt);
      // Also update the cached JWT in .env for other tools
      this.persistToken('GHL_AUTH_TOKEN', data.jwt);
    }
  }

  /**
   * Refresh Firebase token and persist the rotated refresh token (legacy).
   */
  private async refreshFirebaseToken(signal?: AbortSignal): Promise<void> {
    const url = `${WorkflowBuilderClient.FIREBASE_TOKEN_URL}?key=${this.config.firebaseApiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.config.firebaseRefreshToken)}`,
    });

    const data = await res.json() as {
      id_token?: string;
      refresh_token?: string;
      error?: { message: string };
    };

    if (!res.ok || !data.id_token) {
      throw new Error(
        `Firebase token refresh failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`
      );
    }

    this.cachedIdToken = data.id_token;
    this.tokenExpiry = Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS;

    // Persist rotated refresh token
    if (data.refresh_token && data.refresh_token !== this.config.firebaseRefreshToken) {
      if (process.env.KC_GHL_LANE) {
        // The vault is the source of truth for lanes; keep using it and make the rotation visible.
        process.stderr.write('[KC GHL] WARNING: Firebase returned a rotated refresh token; the vault still holds the previous value\n');
      } else {
        this.config.firebaseRefreshToken = data.refresh_token;
        this.persistToken('GHL_FIREBASE_REFRESH_TOKEN', data.refresh_token);
      }
    }
  }

  /**
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

  /**
   * Write a token back to the .env file (preserves other lines).
   */
  private persistToken(key: string, value: string): void {
    const envPath = this.config.envFilePath;
    if (!envPath || !existsSync(envPath)) return;

    try {
      const contents = readFileSync(envPath, 'utf8');
      const regex = new RegExp(`^${key}=.*`, 'm');
      let updated: string;
      if (regex.test(contents)) {
        updated = contents.replace(regex, `${key}=${value}`);
      } else {
        updated = contents.trimEnd() + `\n${key}=${value}\n`;
      }
      writeFileSync(envPath, updated);
    } catch (err) {
      // Non-fatal — token still works for this session
      process.stderr.write(`[WorkflowBuilder] Warning: Could not persist ${key}: ${err}\n`);
    }
  }

  // ─── HTTP Helper ────────────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    // KC lane guard: reject path tricks, then check the URL fetch will actually send.
    if (/\.\.|\\|%|#/.test(path)) {
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

    const res = await fetch(url, opts);
    const text = await res.text();

    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      data = text as unknown as T;
    }

    if (!res.ok) {
      throw new Error(
        `GHL Workflow API error ${res.status} ${method} ${path}: ${typeof data === 'string' ? data : JSON.stringify(data)}`
      );
    }

    return { status: res.status, data };
  }

  // ─── API Methods ────────────────────────────────────────

  /**
   * Create an empty workflow.
   */
  async createWorkflow(name: string): Promise<{ id: string }> {
    const { data } = await this.request<{ id: string }>(
      'POST',
      `/${this.config.locationId}`,
      { name }
    );
    return data;
  }

  /**
   * Get a workflow with full workflowData (actions, triggers, etc.)
   */
  async getWorkflow(workflowId: string): Promise<WorkflowFull> {
    kcAssertId('workflow ID', workflowId);
    const { data } = await this.request<WorkflowFull>(
      'GET',
      `/${this.config.locationId}/${workflowId}`
    );
    return data;
  }

  /**
   * List workflows with full data.
   */
  async listWorkflows(opts?: {
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ rows: WorkflowListItem[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const sortBy = opts?.sortBy ?? 'name';
    const sortOrder = opts?.sortOrder ?? 'asc';

    const query = `type=workflow&limit=${limit}&offset=${offset}&sortBy=${sortBy}&sortOrder=${sortOrder}&includeCustomObjects=true&includeObjectiveBuilder=true`;

    const { data } = await this.request<{ rows: WorkflowListItem[]; total: number }>(
      'GET',
      `/${this.config.locationId}/list?${query}`
    );
    return data;
  }

  /**
   * Update a workflow — adds/replaces actions, triggers, status, etc.
   * Always GETs the current version first to avoid version conflicts.
   */
  async updateWorkflow(
    workflowId: string,
    update: {
      name?: string;
      status?: 'draft' | 'published';
      actions?: WorkflowAction[];
      triggers?: WorkflowTrigger[];
      deletedSteps?: string[];
    }
  ): Promise<WorkflowFull> {
    kcAssertId('workflow ID', workflowId);
    // Get current state for version
    const current = await this.getWorkflow(workflowId);

    // Build action chain with next/parentKey if raw actions provided
    const actions = update.actions
      ? this.buildActionChain(update.actions)
      : current.workflowData?.templates || [];

    // Build triggers
    const newTriggers = update.triggers
      ? update.triggers.map(t => ({
          id: t.id || randomUUID(),
          type: t.type,
          name: t.name || t.type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          workflowId,
          data: {
            type: t.type,
            targetActionId: actions[0]?.id,
            ...(t.data || {}),
          },
        }))
      : undefined;

    const createdSteps = update.actions
      ? actions.map(a => a.id).filter((id): id is string => !!id)
      : [];

    const body = {
      name: update.name || current.name,
      isRestoreRequest: true,
      status: update.status || current.status || 'draft',
      version: current.version,
      dataVersion: current.dataVersion,
      timezone: current.timezone || 'account',
      stopOnResponse: current.stopOnResponse ?? false,
      allowMultiple: current.allowMultiple ?? false,
      allowMultipleOpportunity: current.allowMultipleOpportunity ?? false,
      autoMarkAsRead: current.autoMarkAsRead ?? false,
      removeContactFromLastStep: current.removeContactFromLastStep ?? true,
      workflowData: { templates: actions },
      updatedBy: this.config.userId,
      oldTriggers: [],
      newTriggers: newTriggers || [],
      triggersChanged: !!newTriggers,
      modifiedSteps: [],
      deletedSteps: update.deletedSteps || [],
      createdSteps,
      meta: {},
    };

    await this.request('PUT', `/${this.config.locationId}/${workflowId}`, body);

    // Return fresh state
    return this.getWorkflow(workflowId);
  }

  /**
   * Delete a workflow.
   */
  async deleteWorkflow(workflowId: string): Promise<void> {
    kcAssertId('workflow ID', workflowId);
    await this.request('DELETE', `/${this.config.locationId}/${workflowId}`);
  }

  /**
   * Publish a workflow (set status to published).
   */
  async publishWorkflow(workflowId: string): Promise<WorkflowFull> {
    return this.updateWorkflow(workflowId, { status: 'published' });
  }

  /**
   * Clone a workflow: GET → create new → PUT with same actions/triggers.
   */
  async cloneWorkflow(workflowId: string, newName?: string): Promise<WorkflowFull> {
    const source = await this.getWorkflow(workflowId);
    const name = newName || `${source.name} (copy)`;

    // Create empty workflow
    const { id: newId } = await this.createWorkflow(name);

    // Remap action IDs to new UUIDs
    const idMap = new Map<string, string>();
    const sourceTemplates = source.workflowData?.templates || [];
    for (const action of sourceTemplates) {
      if (action.id) {
        idMap.set(action.id, randomUUID());
      }
    }

    // Clone actions with remapped IDs
    const clonedActions: WorkflowAction[] = sourceTemplates.map(a => {
      const remapId = (id: string) => idMap.get(id) || id;

      let next: string | string[] | undefined;
      if (Array.isArray(a.next)) {
        next = a.next.map(remapId);
      } else if (typeof a.next === 'string' && a.next) {
        next = remapId(a.next);
      } else {
        next = undefined;
      }

      return {
        ...a,
        id: a.id ? idMap.get(a.id) || randomUUID() : randomUUID(),
        next,
        parentKey: a.parentKey ? remapId(a.parentKey) : undefined,
        parent: a.parent ? remapId(a.parent) : undefined,
        sibling: Array.isArray(a.sibling)
          ? a.sibling.map(remapId)
          : undefined,
      };
    });

    // Clone triggers with remapped targetActionId
    const clonedTriggers: WorkflowTrigger[] = (source.triggers || []).map(t => ({
      id: randomUUID(),
      type: t.type,
      name: t.name,
      data: {
        ...t.data,
        targetActionId: t.data?.targetActionId
          ? idMap.get(t.data.targetActionId as string) || t.data.targetActionId
          : undefined,
      },
    }));

    // Update with cloned data
    return this.updateWorkflow(newId, {
      actions: clonedActions,
      triggers: clonedTriggers.length > 0 ? clonedTriggers : undefined,
    });
  }

  // ─── Helpers ────────────────────────────────────────────

  /**
   * Chain raw actions with next/parentKey linkages.
   * If actions already have next/parentKey set, preserves them (for branching).
   */
  /** True when a step is a branch point whose `next` lists branch ids. */
  private static isBranchPoint(a: WorkflowAction): boolean {
    return a.type === 'if_else' || a.cat === 'conditions' || a.cat === 'multi-path';
  }

  /**
   * Collapse a non-branch `next` to the single string id GHL expects.
   * A single-element array becomes its element; an empty array becomes undefined.
   * A multi-element array on a non-branch step is left as provided (caller error).
   */
  private static normalizeLinearNext(next: string | string[] | undefined): string | string[] | undefined {
    if (!Array.isArray(next)) return next || undefined;
    if (next.length === 0) return undefined;
    if (next.length === 1) return next[0];
    return next;
  }

  private buildActionChain(rawActions: WorkflowAction[]): WorkflowAction[] {
    // First pass: assign IDs and basic structure
    const withIds = rawActions.map((a, i) => ({
      ...a,
      id: a.id || randomUUID(),
      order: a.order ?? i,
      attributes: a.attributes || {},
    }));

    // Second pass: wire up next/parentKey for actions that don't have explicit linkage
    return withIds.map((a, i, arr) => {
      const original = rawActions[i];
      const hasExplicitNext = original.next !== undefined;
      const hasExplicitParent = original.parentKey !== undefined;

      // GHL's builder accepts an array `next` only on branch points; linear
      // steps must carry a single string id or the canvas reports
      // "Node has \"next\" as an array but its targets are not if/else branches".
      let next: string | string[] | undefined;
      if (hasExplicitNext) {
        next = WorkflowBuilderClient.isBranchPoint(original)
          ? original.next
          : WorkflowBuilderClient.normalizeLinearNext(original.next);
      } else if (i < arr.length - 1) {
        next = arr[i + 1].id!;
      }

      return {
        ...a,
        next,
        parentKey: hasExplicitParent
          ? a.parentKey
          : (i > 0 ? arr[i - 1].id : undefined),
      };
    }).map(a => a as WorkflowAction);
  }

  /**
   * Get location ID being used.
   */
  getLocationId(): string {
    return this.config.locationId;
  }

  /**
   * Get user ID being used.
   */
  getUserId(): string {
    return this.config.userId;
  }
}
