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
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, renameSync, mkdirSync, fstatSync } from 'fs';
import { resolve, join } from 'path';
import {
  kcSleep, kcLaneMode, kcPinned, kcAssertId, kcAssertLocationAllowed, kcCheckCall, kcCheckWrite,
  kcRequestSignal, kcRemainingMs, kcClaimAbandonedLock, kcReleaseLock, kcHeldLocks, kcJwtExp,
  KC_AUTH_BUDGET_MS, kcCredentialName, kcStashRotatedRefreshToken, kcIsWrite, kcUnknownOutcome, kcJwtIat, KC_FRESH_TOKEN_MS,
  kcPlanRequests, KcPartialWriteError,
} from '../kc/lane.js';

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

  private kcCacheFile: string | null = null;
  /** ID token GHL rejected (401) in this process; never reused from the shared cache. */
  private kcRejectedToken: string | null = null;

  constructor(config: WorkflowBuilderConfig) {
    this.config = config;
    // KC lane guard: a pinned lane's client may only target its own account.
    const pin = kcPinned();
    if (pin && pin !== config.locationId) {
      throw new Error("KC lane guard: workflow client account does not match this lane's pinned account");
    }
  }

  /**
   * A client for another sub-account with the same login. In a pinned lane only the
   * pinned account is allowed; in an unpinned (agency) lane any valid location ID is.
   */
  forLocation(locationId: string): WorkflowBuilderClient {
    kcAssertLocationAllowed(locationId);
    if (locationId === this.config.locationId) return this;
    return new WorkflowBuilderClient({ ...this.config, locationId });
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

    const kcLane = kcLaneMode();
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
      if (kcLaneMode()) {
        // The vault is the source of truth for lanes. Google's securetoken endpoint does not
        // rotate Firebase refresh tokens in practice; if it ever does, make it loud.
        kcStashRotatedRefreshToken(this.kcCacheFile, data.refresh_token);
        process.stderr.write('[KC GHL] Firebase rotated the refresh token; handed to kc-ghl-token-keeper for the vault\n');
      } else {
        this.config.firebaseRefreshToken = data.refresh_token;
        this.persistToken('GHL_FIREBASE_REFRESH_TOKEN', data.refresh_token);
      }
    }
  }

  /**
   * KC shared token cache: one cached Firebase ID token per login, shared by every lane
   * process using that login. One refresh at a time (PID lock file); waiters reuse the
   * result. Retries Google quota (429) with backoff. Bounded by the tool call's deadline.
   */
  private async refreshFirebaseTokenShared(): Promise<void> {
    const deadline = Date.now() + Math.min(KC_AUTH_BUDGET_MS, kcRemainingMs() - 5_000);
    const dir = process.env.KC_GHL_TOKEN_CACHE_DIR;
    if (!kcLaneMode() || !dir) {
      // Outside a KC lane: exactly the upstream refresh (no shared cache, no backoff, upstream TTL).
      await this.refreshFirebaseToken();
      this.tokenExpiry = Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS;
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Stable identity: the launcher's login name plus the public Firebase web key.
    // Never derived from the refresh token, so a rotation cannot split the cache.
    const credential = kcCredentialName();
    const id = createHash('sha256').update(`${credential}:${this.config.firebaseApiKey}`).digest('hex').slice(0, 24);
    const cacheFile = join(dir, `${id}.json`);
    const lockFile = join(dir, `${id}.lock`);
    this.kcCacheFile = cacheFile;
    const margin = 120_000;
    const useCache = (): boolean => {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as { idToken?: unknown; expiresAt?: unknown };
        const exp = kcJwtExp(c.idToken);
        if (c.idToken === this.kcRejectedToken) return false; // GHL rejected it: refresh under the lock instead
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
      kcCheckCall('token refresh');
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
      kcCheckCall('token refresh');
      const remaining = deadline - Date.now();
      if (remaining <= 1_000) throw new Error('KC token cache: auth time budget exhausted');
      try {
        await this.refreshFirebaseToken(kcRequestSignal(Math.min(15_000, remaining)));
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

  /** After GHL rejects a token: forget it here and remove it from the shared cache if still current. */
  /**
   * GHL returned 401 for a request carrying this ID token. Stop using it in this process. The shared
   * cache is never written here (that raced newer tokens): the next call skips the rejected entry,
   * takes the refresh lock, re-reads the cache under it, and refreshes only if the cache still holds
   * the rejected token, so one refresh replaces it for every lane.
   * A token rejected within a minute of being minted points at another cause (usually the private
   * integration token), so it is kept and the error surfaces instead of turning into a refresh storm.
   */
  private kcInvalidateToken(rejected: string): void {
    const iat = kcJwtIat(rejected);
    if (iat !== null && Date.now() - iat < KC_FRESH_TOKEN_MS) {
      process.stderr.write('[KC GHL] 401 with a token minted under a minute ago; not refreshing (check the private integration token)\n');
      return;
    }
    this.kcRejectedToken = rejected;
    if (this.cachedIdToken === rejected) {
      this.cachedIdToken = null;
      this.tokenExpiry = 0;
    }
    process.stderr.write('[KC GHL] GHL rejected the ID token; the next call refreshes it under the shared lock\n');
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

  /** Upstream request(), unchanged: used outside KC lanes. */
  private async upstreamRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const headers = await this.getHeaders();
    const url = `${WorkflowBuilderClient.BASE_URL}${path}`;

    const opts: RequestInit = { method, headers };
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

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    if (!kcLaneMode()) return this.upstreamRequest<T>(method, path, body);
    // KC lane guard: reject path tricks, then check the URL fetch will actually send.
    if (/\.\.|\\|%|#/.test(path.split('?')[0])) {
      throw new Error('KC lane guard: blocked a workflow request with an unsafe path');
    }
    const url = new URL(`${WorkflowBuilderClient.BASE_URL}${path}`);
    const pin = kcPinned();
    if (pin) {
      const prefix = `/workflow/${pin}`;
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
        throw new Error("KC lane guard: blocked a workflow request outside this lane's account");
      }
    }
    const headers = await this.getHeaders();
    // Re-check after auth: auth can take time, and a write must not start too late.
    kcCheckCall(`${method} request`);
    kcCheckWrite(method);

    const opts: RequestInit = { method, headers, signal: kcRequestSignal() };
    if (body) opts.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      const name = (err as Error)?.name;
      if (kcIsWrite(method) && (name === 'AbortError' || name === 'TimeoutError')) {
        throw kcUnknownOutcome(method, 'workflow request');
      }
      throw err;
    }
    if (res.status === 401 && headers['token-id']) this.kcInvalidateToken(headers['token-id']);
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
    if (kcLaneMode()) kcAssertId('workflow ID', workflowId);
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
    if (kcLaneMode()) kcAssertId('workflow ID', workflowId);
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
    if (kcLaneMode()) kcAssertId('workflow ID', workflowId);
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
    if (kcLaneMode()) kcAssertId('workflow ID', workflowId);
    const source = await this.getWorkflow(workflowId);
    const name = newName || `${source.name} (copy)`;
    // Counted from the first write on: POST create, then GET + PUT actions.
    kcPlanRequests('clone', 3);

    // Create empty workflow
    const { id: newId } = await this.createWorkflow(name);
    if (!kcLaneMode()) return this.kcFinishClone(source, newId);
    try {
      return await this.kcFinishClone(source, newId);
    } catch (err) {
      throw new KcPartialWriteError(newId, `creating the empty copy "${name}"`, 'copying the actions', err);
    }
  }

  private async kcFinishClone(source: WorkflowFull, newId: string): Promise<WorkflowFull> {

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
