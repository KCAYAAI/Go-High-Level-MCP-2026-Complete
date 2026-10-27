// KC lane regression tests: one case per reviewer finding. Offline; fetch is stubbed.
// Run: node tests/kc-lane-regression.mjs   (from busybee-next)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const KC = 'AAAAAAAAAAAAAAAAAAA1', NEXT = 'AAAAAAAAAAAAAAAAAAA2', LD = 'AAAAAAAAAAAAAAAAAAA3';
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expSec) => `${b64({ alg: 'none' })}.${b64({ exp: expSec, user_id: 'u' })}.sig`;

const cacheDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'kc-lane-test-'));
process.env.KC_GHL_LANE = 'ghl_kcnext';
process.env.KC_GHL_PINNED_LOCATION = NEXT;
process.env.KC_GHL_TOKEN_CACHE_DIR = cacheDir;
process.env.KC_GHL_CREDENTIAL = 'scout:TEST_REFRESH';

// Stub fetch: count Firebase exchanges, record workflow URLs.
let firebaseCalls = 0, firebaseMode = 'ok', sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('securetoken')) {
    firebaseCalls++;
    if (firebaseMode === '429') return new Response(JSON.stringify({ error: { message: 'QUOTA' } }), { status: 429 });
    if (firebaseMode === 'malformed') return new Response(JSON.stringify({ id_token: 'not-a-jwt' }), { status: 200 });
    if (firebaseMode === 'rotate') return new Response(JSON.stringify({ id_token: jwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'ROTATED' }), { status: 200 });
    return new Response(JSON.stringify({ id_token: jwt(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
  }
  sent.push(u);
  return new Response(JSON.stringify({ rows: [], count: 0 }), { status: 200 });
};

const { WorkflowBuilderClient: C } = await import('../../dist/clients/workflow-builder-client.js');
const base = { apiKey: 'pit', firebaseApiKey: 'web-key', firebaseRefreshToken: 'TEST_REFRESH', userId: 'u' };
const client = new C({ ...base, locationId: NEXT });

// Finding 1 (High, both reviewers): traversal through workflowId.
await test('workflowId traversal "../<other>/list" is blocked before any request', async () => {
  sent = [];
  for (const bad of [`../${KC}/list`, `..%2f${KC}`, `%2e%2e/${KC}`, `x\\..\\${KC}`, `a/b`, `a?b`, `a#b`, '']) {
    await assert.rejects(() => client.getWorkflow(bad), /KC lane guard/, `getWorkflow(${JSON.stringify(bad)})`);
    await assert.rejects(() => client.deleteWorkflow(bad), /KC lane guard/, `deleteWorkflow(${JSON.stringify(bad)})`);
    await assert.rejects(() => client.updateWorkflow(bad, { name: 'x' }), /KC lane guard/, `updateWorkflow(${JSON.stringify(bad)})`);
  }
  assert.equal(sent.length, 0, 'no workflow request may be sent');
});
await test('request(): raw path into another account is blocked by canonical-URL check', async () => {
  for (const p of [`/${KC}/list`, `/${NEXT}/../${KC}/list`, `/${NEXT}x/list`, `/${KC}`]) {
    await assert.rejects(() => client.request('GET', p), /KC lane guard/, p);
  }
});
await test('request(): own account paths still work', async () => {
  sent = [];
  await client.listWorkflows({ limit: 1 });
  await client.getWorkflow('0b8f2c1e-1234-4abc-9def-001122334455');
  assert.ok(sent.every((u) => new URL(u).pathname.startsWith(`/workflow/${NEXT}`)), 'all sent URLs stay in the pinned account');
});

// Findings 3 + 2: stable cache identity, malformed tokens rejected, cache entries validated.
await test('cache key does not depend on the refresh token (rotation cannot split it)', async () => {
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const c2 = new C({ ...base, firebaseRefreshToken: 'DIFFERENT', locationId: NEXT });
  const before = firebaseCalls;
  await c2.listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before, 'second client reused the shared cache');
});
await test('malformed cache entry is ignored and replaced', async () => {
  const f = join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json')));
  writeFileSync(f, JSON.stringify({ idToken: 'garbage', expiresAt: Date.now() + 9e9 }));
  const before = firebaseCalls;
  await new C({ ...base, locationId: NEXT }).listWorkflows({ limit: 1 });
  assert.equal(firebaseCalls, before + 1, 'refreshed instead of trusting garbage');
  const c = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(c.idToken.split('.').length, 3);
});
await test('malformed ID token from Firebase is rejected, not cached', async () => {
  const f = join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json')));
  writeFileSync(f, '{}');
  firebaseMode = 'malformed';
  await assert.rejects(() => new C({ ...base, locationId: NEXT }).listWorkflows({ limit: 1 }), /malformed ID token/);
  assert.equal(readFileSync(f, 'utf8'), '{}', 'bad token not published to the cache');
  firebaseMode = 'ok';
});
await test('rotated refresh token is not persisted inside a lane', async () => {
  const f = join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json')));
  writeFileSync(f, '{}');
  firebaseMode = 'rotate';
  const c = new C({ ...base, locationId: NEXT });
  await c.listWorkflows({ limit: 1 });
  assert.equal(c.config.firebaseRefreshToken, 'TEST_REFRESH', 'vault value kept');
  firebaseMode = 'ok';
});

// Finding 3/2 (timeouts): 429 backoff respects the auth budget.
await test('429 backoff gives up inside the auth budget instead of overrunning', async () => {
  const f = join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json')));
  writeFileSync(f, '{}');
  firebaseMode = '429';
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  const realSet = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => { skew += ms; return realSet(fn, 0, ...a); };
  const t0 = Date.now();
  try {
    await assert.rejects(() => new C({ ...base, locationId: NEXT }).listWorkflows({ limit: 1 }), /429|budget/);
    assert.ok(Date.now() - t0 <= 90_000, `auth finished in ${Date.now() - t0} ms of simulated time`);
  } finally { Date.now = realNow; globalThis.setTimeout = realSet; firebaseMode = 'ok'; }
  assert.ok(!existsSync(join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json')).replace('.json', '.lock'))), 'lock released after failure');
});

// Finding 2 (Medium, both): abandoned-lock handling never deletes a live holder's lock.
await test('lock held by a live PID is not stolen; lock from a dead PID is reclaimed', async () => {
  const f = join(cacheDir, readdirSync(cacheDir).find((x) => x.endsWith('.json')));
  const lock = f.replace('.json', '.lock');
  writeFileSync(f, '{}');
  const sleeper = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = parseInt(sleeper.stdout.toString(), 10); // exited already
  writeFileSync(lock, String(process.ppid)); // live PID (our parent shell)
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  const realSet = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => { skew += ms; return realSet(fn, 0, ...a); };
  try {
    await assert.rejects(() => new C({ ...base, locationId: NEXT }).listWorkflows({ limit: 1 }), /timed out waiting/);
    assert.ok(existsSync(lock), 'live holder lock untouched');
  } finally { Date.now = realNow; globalThis.setTimeout = realSet; }
  writeFileSync(lock, String(deadPid));
  await new C({ ...base, locationId: NEXT }).listWorkflows({ limit: 1 });
  assert.ok(!existsSync(lock), 'dead holder lock reclaimed and our lock released');
  assert.equal(readdirSync(cacheDir).filter((x) => x.includes('.abandoned-')).length, 0, 'no leftover claim files');
});

// Unpinned (agency) mode: no account pin applied.
await test('agency lane (no pin) may target any sub-account; ID checks still apply', async () => {
  const saved = process.env.KC_GHL_PINNED_LOCATION; delete process.env.KC_GHL_PINNED_LOCATION;
  try {
    sent = [];
    await new C({ ...base, locationId: KC }).listWorkflows({ limit: 1 });
    assert.ok(new URL(sent[0]).pathname.startsWith(`/workflow/${KC}`));
    await assert.rejects(() => new C({ ...base, locationId: LD }).getWorkflow(`../${KC}/list`), /KC lane guard/);
  } finally { process.env.KC_GHL_PINNED_LOCATION = saved; }
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
