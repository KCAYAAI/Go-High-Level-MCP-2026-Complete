// KC lane tests. Offline: network is stubbed. Placeholder IDs only (public repo).
// Run after `npm run build:server`:  node tests/kc/kc-lane.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const A = 'AAAAAAAAAAAAAAAAAAA1', B = 'AAAAAAAAAAAAAAAAAAA2', C3 = 'AAAAAAAAAAAAAAAAAAA3';
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expSec) => `${b64({ alg: 'none' })}.${b64({ exp: expSec, user_id: 'u' })}.sig`;
const freshJwt = () => jwt(Math.floor(Date.now() / 1000) + 3600);

const cacheDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'kc-lane-test-'));
Object.assign(process.env, {
  KC_GHL_LANE: 'test_lane', KC_GHL_PINNED_LOCATION: B, KC_GHL_TOKEN_CACHE_DIR: cacheDir,
  KC_GHL_CREDENTIAL: 'owner:TEST_REFRESH', KC_GHL_AUDIT_LOG: join(cacheDir, 'audit.jsonl'), KC_GHL_CALLER: 'tester',
  GHL_LOCATION_ID: B, GHL_FIREBASE_API_KEY: 'web-key', GHL_FIREBASE_REFRESH_TOKEN: 'TEST_REFRESH', GHL_API_KEY: 'pit',
});

let firebaseCalls = 0, firebaseMode = 'ok', sent = [], workflowStatus = 200, workflowDelayMs = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('securetoken')) {
    firebaseCalls++;
    if (firebaseMode === '429') return new Response(JSON.stringify({ error: { message: 'QUOTA' } }), { status: 429 });
    if (firebaseMode === 'malformed') return new Response(JSON.stringify({ id_token: 'not-a-jwt' }), { status: 200 });
    if (firebaseMode === 'rotate') return new Response(JSON.stringify({ id_token: freshJwt(), refresh_token: 'ROTATED' }), { status: 200 });
    return new Response(JSON.stringify({ id_token: freshJwt() }), { status: 200 });
  }
  if (workflowDelayMs) await new Promise((r, j) => { const t = setTimeout(r, workflowDelayMs); opts.signal?.addEventListener('abort', () => { clearTimeout(t); j(opts.signal.reason); }); });
  sent.push({ url: u, method: opts.method });
  return new Response(JSON.stringify({ rows: [], count: 0, _id: 'w1', name: 'w', workflowData: { templates: [] } }), { status: workflowStatus });
};

const lane = await import('../../dist/kc/lane.js');
const { WorkflowBuilderClient: C } = await import('../../dist/clients/workflow-builder-client.js');
const { WorkflowBuilderTools } = await import('../../dist/tools/workflow-builder-tools.js');
const base = { apiKey: 'pit', firebaseApiKey: 'web-key', firebaseRefreshToken: 'TEST_REFRESH', userId: 'u' };
const client = () => new C({ ...base, locationId: B });
const cacheFile = () => join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json') && !x.startsWith('audit')));
const fakeClock = async (fn) => {
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  const realSet = globalThis.setTimeout; globalThis.setTimeout = (f, ms, ...a) => { skew += ms; return realSet(f, 0, ...a); };
  try { return await fn(); } finally { Date.now = realNow; globalThis.setTimeout = realSet; }
};

// ── Workflow API: account pin and path safety
await test('workflow ID traversal and delimiters are refused before any request', async () => {
  sent = [];
  for (const bad of [`../${A}/list`, `..%2f${A}`, `%2e%2e/${A}`, `x\\..\\${A}`, 'a/b', 'a?b', 'a#b', '']) {
    await assert.rejects(() => client().getWorkflow(bad), /KC lane guard/);
    await assert.rejects(() => client().deleteWorkflow(bad), /KC lane guard/);
    await assert.rejects(() => client().updateWorkflow(bad, { name: 'x' }), /KC lane guard/);
  }
  assert.equal(sent.length, 0);
});
await test('raw request paths into another account are refused (canonical URL check)', async () => {
  for (const p of [`/${A}/list`, `/${B}/../${A}/list`, `/${B}x/list`, `/${A}`]) await assert.rejects(() => client().request('GET', p), /KC lane guard/, p);
});
await test('percent-encoded query values are allowed on workflow requests', async () => {
  sent = [];
  await client().request('GET', `/${B}/list?search=my%20flow%23&limit=1`);
  assert.equal(sent.length, 1);
});
await test('lane mode refuses to run without a credential name (no shared "unnamed" cache)', async () => {
  const saved = process.env.KC_GHL_CREDENTIAL; delete process.env.KC_GHL_CREDENTIAL;
  writeFileSync(cacheFile(), '{}');
  try { await assert.rejects(() => client().listWorkflows({ limit: 1 }), /KC_GHL_CREDENTIAL/); } finally { process.env.KC_GHL_CREDENTIAL = saved; }
});
await test('auth that would cross the call deadline stops instead of sleeping past it', async () => {
  writeFileSync(cacheFile(), '{}'); firebaseMode = '429';
  try {
    await fakeClock(async () => {
      await lane.kcRunToolCall('t', undefined, async () => {
        await new Promise((r) => setTimeout(r, lane.KC_CALL_BUDGET_MS - 12_000)); // 12 s left: one 5 s backoff fits, 10 s does not
        const t0 = Date.now();
        await assert.rejects(() => client().listWorkflows({ limit: 1 }), /429|budget/);
        assert.ok(Date.now() - t0 < 12_000, `stopped after ${Date.now() - t0} ms`);
      });
    });
  } finally { firebaseMode = 'ok'; }
});
await test('release never deletes a lock now owned by someone else (same inode, other PID)', async () => {
  const lock = cacheFile().replace('.json', '.lock');
  writeFileSync(lock, String(process.ppid));
  const { statSync } = await import('node:fs');
  lane.kcHeldLocks.set(lock, statSync(lock).ino);
  lane.kcReleaseLock(lock);
  assert.ok(existsSync(lock));
  (await import('node:fs')).unlinkSync(lock);
});
await test('own-account workflow calls work and stay in the pinned account', async () => {
  sent = [];
  await client().listWorkflows({ limit: 1 });
  await client().getWorkflow('0b8f2c1e-1234-4abc-9def-001122334455');
  assert.ok(sent.length === 2 && sent.every((s) => new URL(s.url).pathname.startsWith(`/workflow/${B}`)));
});

// ── Shared token cache
await test('cache identity does not depend on the refresh token', async () => {
  const before = firebaseCalls;
  await new C({ ...base, firebaseRefreshToken: 'DIFFERENT', locationId: B }).listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before);
});
await test('malformed cache entry is ignored and replaced with a valid token', async () => {
  writeFileSync(cacheFile(), JSON.stringify({ idToken: 'garbage', expiresAt: Date.now() + 9e9 }));
  const before = firebaseCalls;
  await client().listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before + 1);
  assert.equal(JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken.split('.').length, 3);
});
await test('malformed ID token from Firebase is rejected, not cached', async () => {
  writeFileSync(cacheFile(), '{}'); firebaseMode = 'malformed';
  try { await assert.rejects(() => client().listWorkflows({ limit: 1 }), /malformed ID token/); } finally { firebaseMode = 'ok'; }
  assert.equal(readFileSync(cacheFile(), 'utf8'), '{}');
});
await test('rotated refresh token is handed to the keeper (0600 pending file), never adopted or written to the vault', async () => {
  writeFileSync(cacheFile(), '{}'); firebaseMode = 'rotate';
  const c = client();
  try { await c.listWorkflows({ limit: 1 }); } finally { firebaseMode = 'ok'; }
  assert.equal(c.config.firebaseRefreshToken, 'TEST_REFRESH');
  const pending = cacheFile().replace('.json', '.refresh-pending');
  assert.equal(readFileSync(pending, 'utf8'), 'ROTATED');
  const { statSync, unlinkSync } = await import('node:fs');
  assert.equal(statSync(pending).mode & 0o777, 0o600);
  unlinkSync(pending);
});
await test('a token GHL rejects (401) is cleared from memory and the shared cache', async () => {
  await client().listWorkflows({ limit: 1 });
  const cached = JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken;
  workflowStatus = 401;
  try { await assert.rejects(() => client().listWorkflows({ limit: 1 }), /401/); } finally { workflowStatus = 200; }
  assert.equal(readFileSync(cacheFile(), 'utf8'), '{}', 'rejected token removed');
  const before = firebaseCalls;
  await client().listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before + 1, 'next call refreshes');
  assert.notEqual(JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken, undefined);
  assert.ok(cached);
});
await test('429 backoff stops inside the auth budget and releases the lock', async () => {
  writeFileSync(cacheFile(), '{}'); firebaseMode = '429';
  try {
    await fakeClock(async () => {
      const t0 = Date.now();
      await assert.rejects(() => client().listWorkflows({ limit: 1 }), /429|budget/);
      assert.ok(Date.now() - t0 <= lane.KC_AUTH_BUDGET_MS, `${Date.now() - t0} ms`);
    });
  } finally { firebaseMode = 'ok'; }
  assert.ok(!existsSync(cacheFile().replace('.json', '.lock')));
});

// ── Locks
await test('lock held by a live PID is never taken, even after a long wait', async () => {
  const lock = cacheFile().replace('.json', '.lock');
  writeFileSync(cacheFile(), '{}');
  writeFileSync(lock, String(process.ppid));
  await fakeClock(async () => { await assert.rejects(() => client().listWorkflows({ limit: 1 }), /timed out waiting/); });
  assert.ok(existsSync(lock), 'live holder lock untouched');
});
await test('an empty (initializing) lock is respected during the grace period, reclaimed after', async () => {
  const lock = cacheFile().replace('.json', '.lock');
  writeFileSync(lock, '');
  lane.kcClaimAbandonedLock(lock);
  assert.ok(existsSync(lock), 'fresh empty lock kept');
  const old = (Date.now() - 31_000) / 1000; utimesSync(lock, old, old);
  lane.kcClaimAbandonedLock(lock);
  assert.ok(!existsSync(lock), 'empty lock older than grace reclaimed');
});
await test('lock from a dead PID is reclaimed; no claim files left behind', async () => {
  const lock = cacheFile().replace('.json', '.lock');
  const dead = parseInt(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString(), 10);
  writeFileSync(lock, String(dead));
  writeFileSync(cacheFile(), '{}');
  await client().listWorkflows({ limit: 1 });
  assert.ok(!existsSync(lock));
  assert.equal(readdirSync(cacheDir).filter((x) => x.includes('.abandoned-')).length, 0);
});

// ── Per-call deadline and cancellation (whole tool call, not one request)
await test('a write is not sent when too little call time remains; nothing changes', async () => {
  sent = [];
  await fakeClock(async () => {
    await lane.kcRunToolCall('t', undefined, async () => {
      await client().listWorkflows({ limit: 1 }); // read is fine
      await new Promise((r) => setTimeout(r, lane.KC_CALL_BUDGET_MS - lane.KC_MIN_WRITE_WINDOW_MS + 1_000));
      await assert.rejects(() => client().deleteWorkflow('w1'), /not sent/);
    });
  });
  assert.ok(sent.every((s) => s.method !== 'DELETE'), 'DELETE never dispatched');
});
await test('compound update stops before its write once the call budget is spent', async () => {
  sent = [];
  await fakeClock(async () => {
    await lane.kcRunToolCall('t', undefined, async () => {
      await new Promise((r) => setTimeout(r, lane.KC_CALL_BUDGET_MS - 20_000));
      await assert.rejects(() => client().updateWorkflow('w1', { name: 'x' }), /not sent/);
    });
  });
  assert.ok(sent.every((s) => s.method !== 'PUT'), 'PUT never dispatched');
});
await test('caller cancellation stops the call before a write', async () => {
  sent = [];
  const ac = new AbortController(); ac.abort();
  await lane.kcRunToolCall('t', ac.signal, async () => {
    await assert.rejects(() => client().deleteWorkflow('w1'), /cancel/);
  });
  assert.equal(sent.length, 0);
});
await test('a request in flight is aborted when the caller cancels', async () => {
  const ac = new AbortController(); workflowDelayMs = 5_000;
  try {
    await lane.kcRunToolCall('t', ac.signal, async () => {
      const p = client().listWorkflows({ limit: 1 });
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(() => p);
    });
  } finally { workflowDelayMs = 0; }
});
await test('every tool call is audited with caller and lane, never arguments', async () => {
  const lines = readFileSync(process.env.KC_GHL_AUDIT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 4);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['caller', 'lane', 'ms', 'ok', 'tool', 'ts']);
  assert.ok(lines.every((l) => l.caller === 'tester' && l.lane === 'test_lane'));
});

// ── Per-call account selection through the workflow tools
await test('pinned lane: tool locationId for another account is refused; own account works', async () => {
  const tools = new WorkflowBuilderTools(); sent = [];
  const other = await tools.executeWorkflowBuilderTool('ghl_list_workflows_full', { limit: 1, locationId: A });
  assert.match(JSON.stringify(other), /KC lane guard/);
  await tools.executeWorkflowBuilderTool('ghl_list_workflows_full', { limit: 1, locationId: B });
  assert.equal(sent.length, 1);
  assert.ok(new URL(sent[0].url).pathname.startsWith(`/workflow/${B}`));
});
await test('agency lane (unpinned): one server reaches two accounts by locationId', async () => {
  const saved = process.env.KC_GHL_PINNED_LOCATION; delete process.env.KC_GHL_PINNED_LOCATION;
  process.env.GHL_LOCATION_ID = C3;
  try {
    const tools = new WorkflowBuilderTools(); sent = [];
    await tools.executeWorkflowBuilderTool('ghl_list_workflows_full', { limit: 1, locationId: A });
    await tools.executeWorkflowBuilderTool('ghl_list_workflows_full', { limit: 1, locationId: B });
    await tools.executeWorkflowBuilderTool('ghl_list_workflows_full', { limit: 1 });
    assert.deepEqual(sent.map((s) => new URL(s.url).pathname.split('/')[2]), [A, B, C3]);
    const bad = await tools.executeWorkflowBuilderTool('ghl_list_workflows_full', { limit: 1, locationId: '../x' });
    assert.match(JSON.stringify(bad), /KC lane guard/);
  } finally { process.env.KC_GHL_PINNED_LOCATION = saved; }
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
