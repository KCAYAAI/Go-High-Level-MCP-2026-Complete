// KC lane tests. Offline: network is stubbed. Placeholder IDs only (public repo).
// Run after `npm run build:server`:  node tests/kc/kc-lane.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

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

let firebaseCalls = 0, firebaseMode = 'ok', sent = [], workflowStatus = 200, workflowDelayMs = 0, failMethod = null, firebaseDelayMs = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('securetoken')) {
    firebaseCalls++;
    if (firebaseDelayMs) await new Promise((r) => setTimeout(r, firebaseDelayMs));
    if (firebaseMode === '429') return new Response(JSON.stringify({ error: { message: 'QUOTA' } }), { status: 429 });
    if (firebaseMode === 'malformed') return new Response(JSON.stringify({ id_token: 'not-a-jwt' }), { status: 200 });
    if (firebaseMode === 'rotate') return new Response(JSON.stringify({ id_token: freshJwt(), refresh_token: 'ROTATED' }), { status: 200 });
    return new Response(JSON.stringify({ id_token: freshJwt() }), { status: 200 });
  }
  if (workflowDelayMs) await new Promise((r, j) => { const t = setTimeout(r, workflowDelayMs); opts.signal?.addEventListener('abort', () => { clearTimeout(t); j(opts.signal.reason); }); });
  sent.push({ url: u, method: opts.method });
  if (failMethod && opts.method === failMethod) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
  return new Response(JSON.stringify({ rows: [], count: 0, id: 'w1', _id: 'w1', name: 'w', version: 1, workflowData: { templates: [] } }), { status: workflowStatus });
};

const lane = await import('../../dist/kc/lane.js');
const { WorkflowBuilderClient: C } = await import('../../dist/clients/workflow-builder-client.js');
const { WorkflowBuilderTools } = await import('../../dist/tools/workflow-builder-tools.js');
const base = { apiKey: 'pit', firebaseApiKey: 'web-key', firebaseRefreshToken: 'TEST_REFRESH', userId: 'u' };
const base0 = () => ({ ...base });
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
const jwtAt = (iatSec) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, iat: iatSec, user_id: 'u' })}.sig`;
const seedCache = (tok) => writeFileSync(cacheFile(), JSON.stringify({ idToken: tok, expiresAt: JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')).exp * 1000 }));
await test('401: the same client stops using the token and recovers with exactly one refresh; other lanes reuse it', async () => {
  const old = jwtAt(Math.floor(Date.now() / 1000) - 600); seedCache(old);
  const c = client();
  workflowStatus = 401;
  try { await assert.rejects(() => c.listWorkflows({ limit: 1 }), /401/); } finally { workflowStatus = 200; }
  assert.equal(JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken, old, 'cache not written outside the lock');
  const before = firebaseCalls;
  await c.listWorkflows({ limit: 1 });            // same client, same process
  assert.equal(firebaseCalls, before + 1, 'one refresh');
  const fresh = JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken;
  assert.notEqual(fresh, old, 'cache now holds the new token');
  await client().listWorkflows({ limit: 1 });     // another lane on the same login
  assert.equal(firebaseCalls, before + 1, 'no second refresh');
});
await test('401 never discards a newer token another lane already published', async () => {
  const old = jwtAt(Math.floor(Date.now() / 1000) - 600); seedCache(old);
  const c = client();
  workflowStatus = 401;
  try { await assert.rejects(() => c.listWorkflows({ limit: 1 }), /401/); } finally { workflowStatus = 200; }
  const newer = jwtAt(Math.floor(Date.now() / 1000) - 5); seedCache(newer);   // another lane refreshed meanwhile
  const before = firebaseCalls;
  await c.listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before, 'uses the newer token, no refresh');
  assert.equal(JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken, newer, 'newer token kept');
});
await test('401 with a token minted under a minute ago does not refresh (cause is elsewhere; no storm)', async () => {
  const brandNew = jwtAt(Math.floor(Date.now() / 1000) - 5); seedCache(brandNew);
  const c = client();
  const before = firebaseCalls;
  workflowStatus = 401;
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(() => c.listWorkflows({ limit: 1 }), /401/);
  } finally { workflowStatus = 200; }
  assert.equal(firebaseCalls, before, 'no refreshes');
  assert.equal(JSON.parse(readFileSync(cacheFile(), 'utf8')).idToken, brandNew);
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
  const free = await lane.kcTryLock(lane.kcLockName(cacheFile().split('/').pop().replace('.json', ''))); assert.ok(free, 'lock released after the failed refresh'); lane.kcUnlock(free);
});

// ── Locks
// ── Refresh lock: kernel-held abstract socket, shared by lanes and the keeper
const lockName = () => lane.kcLockName(cacheFile().split('/').pop().replace('.json', ''));
const holdInChild = (name) => new Promise((res) => {
  const ch = spawn(process.execPath, ['-e', `const s=require('net').createServer();s.listen({path:${JSON.stringify(name)}},()=>{process.stdout.write('held')});setInterval(()=>{},1e6)`]);
  ch.stderr.on('data', (d) => process.stderr.write(d));
  ch.stdout.once('data', () => res(ch));
});
await test('a lock held by another live process is never taken; the lane waits, then gives up cleanly', async () => {
  writeFileSync(cacheFile(), '{}');
  const ch = await holdInChild(lockName());
  try {
    const before = firebaseCalls;
    await fakeClock(async () => { await assert.rejects(() => client().listWorkflows({ limit: 1 }), /timed out waiting/); });
    assert.equal(firebaseCalls, before, 'no refresh while another process holds the lock');
  } finally { ch.kill('SIGKILL'); }
});
await test('holder killed with SIGKILL: the kernel frees the lock at once and the lane refreshes', async () => {
  writeFileSync(cacheFile(), '{}');
  const ch = await holdInChild(lockName());
  ch.kill('SIGKILL'); await new Promise((r) => ch.once('exit', r));
  const before = firebaseCalls;
  await client().listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before + 1);
});
await test('two lane processes starting together on one login refresh exactly once', async () => {
  writeFileSync(cacheFile(), '{}');
  const counter = join(cacheDir, 'refresh-count.txt'); writeFileSync(counter, '');
  const child = `
    import { appendFileSync } from 'node:fs';
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    globalThis.fetch = async (u) => {
      if (String(u).includes('securetoken')) { appendFileSync(${JSON.stringify(counter)}, 'x'); await new Promise((r) => setTimeout(r, 400));
        return new Response(JSON.stringify({ id_token: b64({alg:'none'}) + '.' + b64({ exp: Math.floor(Date.now()/1000)+3600 }) + '.s' }), { status: 200 }); }
      return new Response('{"rows":[]}', { status: 200 });
    };
    const { WorkflowBuilderClient: C } = await import(${JSON.stringify(new URL('../../dist/clients/workflow-builder-client.js', import.meta.url).href)});
    await new C({ apiKey: 'pit', firebaseApiKey: 'web-key', firebaseRefreshToken: 'TEST_REFRESH', userId: 'u', locationId: ${JSON.stringify(B)} }).listWorkflows({ limit: 1 });
    process.stdout.write('done');`;
  const run = () => new Promise((res) => { const c = spawn(process.execPath, ['--input-type=module', '-e', child], { env: process.env }); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('exit', (code) => res([code, out])); });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((r) => r[1]), ['done', 'done'], JSON.stringify(results));
  assert.equal(readFileSync(counter, 'utf8').length, 1, 'exactly one Firebase refresh across both processes');
});

await test('F3: a rejected token is skipped by every client in the process (agency per-location clients recover)', async () => {
  const old = jwtAt(Math.floor(Date.now() / 1000) - 600); seedCache(old);
  workflowStatus = 401;
  try { await assert.rejects(() => client().listWorkflows({ limit: 1 }), /401/); } finally { workflowStatus = 200; }
  const before = firebaseCalls;
  await client().listWorkflows({ limit: 1 });        // a different client instance (next tool call)
  assert.equal(firebaseCalls, before + 1, 'refreshed instead of repeating the 401');
});
await test('F3: forLocation reuses one client per sub-account', async () => {
  const saved = process.env.KC_GHL_PINNED_LOCATION; delete process.env.KC_GHL_PINNED_LOCATION;
  try {
    const base = new C({ ...base0(), locationId: B });
    assert.equal(base.forLocation(A), base.forLocation(A));
    assert.equal(base.forLocation(B), base);
  } finally { process.env.KC_GHL_PINNED_LOCATION = saved; }
});
await test('F4: a write whose response body stalls after the headers reports an unknown outcome', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('securetoken')) return realFetch(url, opts);
    if (opts.method === 'DELETE') {
      const body = new ReadableStream({ start(c) { setTimeout(() => c.error(new DOMException('aborted', 'AbortError')), 10); } });
      return new Response(body, { status: 200 });
    }
    return realFetch(url, opts);
  };
  try { await assert.rejects(() => client().deleteWorkflow('w1'), /was sent but did not finish.*may or may not have applied/s); }
  finally { globalThis.fetch = realFetch; }
});

await test('R5: a write whose body fails with a connection reset after headers reports an unknown outcome', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('securetoken')) return realFetch(url, opts);
    if (opts.method === 'DELETE') {
      const body = new ReadableStream({ start(c) { setTimeout(() => c.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } })), 10); } });
      return new Response(body, { status: 200 });
    }
    return realFetch(url, opts);
  };
  try { await assert.rejects(() => client().deleteWorkflow('w1'), /may or may not have applied/s); }
  finally { globalThis.fetch = realFetch; }
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
  } finally { process.env.KC_GHL_PINNED_LOCATION = saved; process.env.GHL_LOCATION_ID = B; }
});

// ── Multi-write tools report partial results truthfully
const parse = (res) => JSON.parse(res.content[0].text);
await test('create: if adding actions fails after the create, the result names the created workflow', async () => {
  const tools = new WorkflowBuilderTools(); sent = []; failMethod = 'PUT';
  try {
    const res = await lane.kcRunToolCall('ghl_create_workflow', undefined, () =>
      tools.executeWorkflowBuilderTool('ghl_create_workflow', { name: 'x', actions: [{ type: 'wait', name: 'w' }] }));
    assert.equal(res.isError, true);
    const body = parse(res);
    assert.equal(body.partial, true); assert.equal(body.createdWorkflowId, 'w1');
    assert.match(body.nextStep, /Do not create it again/);
  } finally { failMethod = null; }
  assert.equal(sent.filter((s) => s.method === 'POST').length, 1);
});
await test('create: not started when the call cannot fit all its writes; nothing sent', async () => {
  const tools = new WorkflowBuilderTools(); sent = [];
  await fakeClock(async () => {
    await lane.kcRunToolCall('ghl_create_workflow', undefined, async () => {
      await new Promise((r) => setTimeout(r, lane.KC_CALL_BUDGET_MS - 60_000)); // 60 s left < 77 s needed
      const res = await tools.executeWorkflowBuilderTool('ghl_create_workflow', { name: 'x', actions: [{ type: 'wait', name: 'w' }] });
      assert.match(res.content[0].text, /not started.*Nothing was sent/s);
    });
  });
  assert.equal(sent.filter((s) => s.method !== 'GET').length, 0);
});
await test('create: a slow login that eats the budget stops the create before any write', async () => {
  const tools = new WorkflowBuilderTools(); writeFileSync(cacheFile(), '{}'); sent = []; firebaseDelayMs = 45_000;
  try {
    await fakeClock(async () => {
      await lane.kcRunToolCall('ghl_create_workflow', undefined, async () => {
        const res = await tools.executeWorkflowBuilderTool('ghl_create_workflow', { name: 'x', actions: [{ type: 'wait', name: 'w' }] });
        assert.match(res.content[0].text, /not started.*Nothing was sent/s);
      });
    });
  } finally { firebaseDelayMs = 0; }
  assert.equal(sent.filter((x) => x.method !== 'GET').length, 0, 'no write sent');
});
await test('create without actions needs only one write and still runs with 60 s left', async () => {
  const tools = new WorkflowBuilderTools(); sent = [];
  await fakeClock(async () => {
    await lane.kcRunToolCall('ghl_create_workflow', undefined, async () => {
      await new Promise((r) => setTimeout(r, lane.KC_CALL_BUDGET_MS - 60_000));
      const res = await tools.executeWorkflowBuilderTool('ghl_create_workflow', { name: 'x' });
      assert.ok(!res.isError, res.content[0].text);
    });
  });
  assert.equal(sent.filter((s) => s.method === 'POST').length, 1);
});
await test('clone: if copying actions fails after the create, the result names the copy', async () => {
  const tools = new WorkflowBuilderTools(); failMethod = 'PUT';
  try {
    const res = await lane.kcRunToolCall('ghl_clone_workflow', undefined, () =>
      tools.executeWorkflowBuilderTool('ghl_clone_workflow', { workflowId: 'src1' }));
    if (!res.content[0].text.startsWith('{')) throw new Error(res.content[0].text);
    const body = parse(res);
    assert.equal(body.partial, true); assert.equal(body.createdWorkflowId, 'w1'); assert.match(body.failed, /copying the actions/);
  } finally { failMethod = null; }
});
await test('budget math: every multi-write tool can start at the beginning of a call', async () => {
  // clone/create plan 3 requests from the first write (77 s). A fresh call (cached token) plus a
  // 20 s source read must still fit; slower cases refuse cleanly before any write.
  const needed = 2 * 25_000 + lane.KC_MIN_WRITE_WINDOW_MS;
  assert.ok(lane.KC_CALL_BUDGET_MS >= needed + 20_000, `fresh call has ${lane.KC_CALL_BUDGET_MS} ms for ${needed} ms`);
});
await test('a write cut off in flight reports an unknown outcome, not "nothing changed"', async () => {
  const ac = new AbortController(); workflowDelayMs = 5_000;
  try {
    await lane.kcRunToolCall('t', ac.signal, async () => {
      const p = client().deleteWorkflow('w1');
      setTimeout(() => ac.abort(), 30);
      await assert.rejects(() => p, /was sent but did not finish.*may or may not have applied/s);
    });
  } finally { workflowDelayMs = 0; }
});
await test('write refusal says only that this request was not sent', async () => {
  await fakeClock(async () => {
    await lane.kcRunToolCall('t', undefined, async () => {
      await new Promise((r) => setTimeout(r, lane.KC_CALL_BUDGET_MS - 10_000));
      await assert.rejects(() => client().deleteWorkflow('w1'), (e) => /this DELETE request was not sent/.test(e.message) && !/nothing was changed/.test(e.message));
    });
  });
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
