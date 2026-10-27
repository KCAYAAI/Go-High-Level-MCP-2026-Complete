// Outside a KC lane (no KC_GHL_LANE) the server must behave exactly like upstream.
// Run after `npm run build:server`:  node tests/kc/kc-upstream-mode.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (k.startsWith('KC_GHL_')) delete process.env[k];
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'kc-upstream-'));
process.env.KC_GHL_AUDIT_LOG = join(dir, 'audit.jsonl'); // set, but no lane: must stay unused
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
let firebase = 0, mode = 'ok', sent = [], failPut = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('securetoken')) {
    firebase++;
    return mode === '429' ? new Response('{"error":{"message":"QUOTA"}}', { status: 429 }) : new Response(JSON.stringify({ id_token: jwt() }), { status: 200 });
  }
  sent.push({ url: u, method: opts.method, signal: opts.signal });
  if (failPut && opts.method === 'PUT') return new Response('{"message":"boom"}', { status: 500 });
  return new Response(JSON.stringify({ rows: [], id: 'w1', _id: 'w1', name: 'w', workflowData: { templates: [] } }), { status: 200 });
};
const { WorkflowBuilderClient: C } = await import('../../dist/clients/workflow-builder-client.js');
const lane = await import('../../dist/kc/lane.js');
const cfg = { apiKey: 'p', firebaseApiKey: 'k', firebaseRefreshToken: 'r', userId: 'u', locationId: 'LOC' };
const results = [];
const t = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

await t('lane mode is off', () => assert.equal(lane.kcLaneMode(), false));
await t('workflow IDs are not KC-validated (upstream passes them through)', async () => {
  sent = []; await new C(cfg).getWorkflow('weird id');
  assert.equal(sent.length, 1);
});
await t('requests carry no KC abort signal', async () => {
  sent = []; await new C(cfg).listWorkflows({ limit: 1 });
  assert.equal(sent[0].signal, undefined);
});
await t('Firebase 429 fails at once (no KC backoff)', async () => {
  mode = '429'; const before = firebase;
  try { await assert.rejects(() => new C(cfg).listWorkflows({ limit: 1 })); } finally { mode = 'ok'; }
  assert.equal(firebase - before, 1);
});
await t('clone failure surfaces the original error, not a KC partial-write wrapper', async () => {
  failPut = true;
  try { await assert.rejects(() => new C(cfg).cloneWorkflow('src'), (e) => e.name !== 'KcPartialWriteError' && !/KC lane/.test(e.message)); } finally { failPut = false; }
});
await t('workflow tool schemas carry no KC locationId outside a lane', async () => {
  const { WorkflowBuilderTools } = await import('../../dist/tools/workflow-builder-tools.js');
  const tools = new WorkflowBuilderTools().getTools();
  assert.equal(tools.length, 7);
  assert.ok(tools.every((x) => !('locationId' in (x.inputSchema.properties || {}))));
});
await t('no KC audit file is written', () => assert.equal(existsSync(process.env.KC_GHL_AUDIT_LOG), false));

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
