// Agency lane token routing: each public request carries the token of the sub-account it names.
// Offline: axios adapter stubbed, placeholder IDs and tokens. Run after `npm run build:server`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const A = 'AAAAAAAAAAAAAAAAAAA1', B = 'AAAAAAAAAAAAAAAAAAA2', C = 'AAAAAAAAAAAAAAAAAAA3';
Object.assign(process.env, {
  KC_GHL_LANE: 'agency_test', GHL_LOCATION_ID: B,
  KC_GHL_LOCATION_TOKENS: JSON.stringify({ [A]: 'tok-A', [B]: 'tok-B' }),
});
delete process.env.KC_GHL_PINNED_LOCATION;
const { GHLApiClient } = await import('../../dist/clients/ghl-api-client.js');
const lane = await import('../../dist/kc/lane.js');
const client = new GHLApiClient({ accessToken: 'tok-AGENCY', baseUrl: 'https://services.leadconnectorhq.com', version: '2021-07-28', locationId: B, apiGeneration: 'v3' });
const ax = client.axiosInstance;
let sent = [];
ax.defaults.adapter = async (config) => { sent.push(config); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
const auth = () => { const h = sent.at(-1).headers; return (typeof h.get === 'function' ? h.get('Authorization') : h.Authorization); };
const results = [];
const t = async (name, fn) => { try { sent = []; await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

// an agency-only endpoint from the real catalog (no Location-Access scheme)
const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../dist/tools/official-spec-endpoints.json', import.meta.url)), 'utf8'));
const agencyEp = spec.find((e) => e.method === 'GET' && (e.securitySchemes || []).some((s) => s.startsWith('Agency-Access')) && !(e.securitySchemes || []).some((s) => s.startsWith('Location-Access')) && !e.path.includes('{'));

await t('query locationId=A uses sub-account A token', async () => { await ax.get('/contacts/', { params: { locationId: A } }); assert.equal(auth(), 'Bearer tok-A'); });
await t('body locationId=B uses sub-account B token', async () => { await ax.post('/contacts/', { locationId: B, firstName: 'x' }); assert.equal(auth(), 'Bearer tok-B'); });
await t('path /locations/A uses sub-account A token', async () => { await ax.get(`/locations/${A}`); assert.equal(auth(), 'Bearer tok-A'); });
await t('catalog path /social-media-posting/A/categories uses A token', async () => { await ax.get(`/social-media-posting/${A}/categories`); assert.equal(auth(), 'Bearer tok-A'); });
await t(`agency-only endpoint keeps the agency token (${agencyEp?.path})`, async () => { assert.ok(agencyEp, 'catalog has an agency-only GET'); await ax.get(agencyEp.path); assert.equal(auth(), 'Bearer tok-AGENCY'); });
await t('no sub-account named (e.g. contact by ID): default sub-account token', async () => { await ax.get('/contacts/abc123'); assert.equal(auth(), 'Bearer tok-B'); });
for (const path of ['/locations/search', '/users/search', '/companies/X1', '/snapshots/']) {
  await t(`agency path ${path}: agency token`, async () => { await ax.get(path); assert.equal(auth(), 'Bearer tok-AGENCY'); });
}
await t('sub-account with no registered token is refused, nothing sent', async () => {
  await assert.rejects(ax.get('/contacts/', { params: { locationId: C } }), /no sub-account token for location/); assert.equal(sent.length, 0);
});
await t('two sub-accounts in one request are refused, nothing sent', async () => {
  await assert.rejects(ax.get(`/locations/${A}/customFields`, { params: { locationId: B } }), /more than one sub-account/); assert.equal(sent.length, 0);
});
await t('unsafe path refused in the agency lane too', async () => {
  await assert.rejects(ax.get(`/locations//${A}`), /unsafe path/); assert.equal(sent.length, 0);
});
await t('pinned lane: no routing, configured token kept', async () => {
  process.env.KC_GHL_PINNED_LOCATION = B;
  try { await ax.get('/contacts/', { params: { locationId: B } }); assert.equal(auth(), 'Bearer tok-AGENCY'); } finally { delete process.env.KC_GHL_PINNED_LOCATION; }
});
await t('no token map: agency token kept (lanes without sub-account tokens behave as before)', async () => {
  const saved = process.env.KC_GHL_LOCATION_TOKENS; delete process.env.KC_GHL_LOCATION_TOKENS; lane.kcResetLocationTokensForTests();
  try { await ax.get('/contacts/', { params: { locationId: A } }); assert.equal(auth(), 'Bearer tok-AGENCY'); }
  finally { process.env.KC_GHL_LOCATION_TOKENS = saved; lane.kcResetLocationTokensForTests(); }
});
await t('adding a sub-account is data only: a new map entry routes with no code change', async () => {
  process.env.KC_GHL_LOCATION_TOKENS = JSON.stringify({ [A]: 'tok-A', [B]: 'tok-B', [C]: 'tok-C' }); lane.kcResetLocationTokensForTests();
  await ax.get('/contacts/', { params: { locationId: C } }); assert.equal(auth(), 'Bearer tok-C');
});
await t('extra agency paths are a variable (KC_GHL_AGENCY_PATHS)', async () => {
  await ax.get('/brand-boards/x'); assert.equal(auth(), 'Bearer tok-B');
  process.env.KC_GHL_AGENCY_PATHS = '/brand-boards';
  try { await ax.get('/brand-boards/x'); assert.equal(auth(), 'Bearer tok-AGENCY'); } finally { delete process.env.KC_GHL_AGENCY_PATHS; }
});
await t('per-call locationId drives upstream config.locationId and the token (tools without a native locationId arg)', async () => {
  await lane.kcRunToolCall('search_contacts', undefined, async () => {
    assert.equal(client.getConfig().locationId, A);
    await ax.get('/contacts/', { params: { locationId: client.getConfig().locationId } });
  }, A);
  assert.equal(auth(), 'Bearer tok-A');
  assert.equal(new URL(ax.getUri(sent.at(-1))).searchParams.get('locationId'), A);
  assert.equal(client.getConfig().locationId, B, 'outside the call the lane default is back');
});
await t('kcSplitLocationArg: strips the arg for tools that do not declare it, keeps it for tools that do, rejects junk', async () => {
  assert.deepEqual(lane.kcSplitLocationArg({ q: 1, locationId: A }, false), { location: A, args: { q: 1 } });
  assert.deepEqual(lane.kcSplitLocationArg({ q: 1, locationId: A }, true), { location: A, args: { q: 1, locationId: A } });
  assert.deepEqual(lane.kcSplitLocationArg({ q: 1 }, false), { args: { q: 1 } });
  assert.throws(() => lane.kcSplitLocationArg({ locationId: '../x' }, false), /20-character/);
});
await t('pinned lane: per-call locationId for another account is refused', async () => {
  process.env.KC_GHL_PINNED_LOCATION = B;
  try { assert.throws(() => lane.kcSplitLocationArg({ locationId: A }, false), /KC lane guard/); assert.equal(lane.kcSplitLocationArg({ locationId: B }, false).location, B); }
  finally { delete process.env.KC_GHL_PINNED_LOCATION; }
});
await t('F1: a locationless request follows the sub-account the call selected, not the lane default', async () => {
  await lane.kcRunToolCall('get_contact', undefined, () => ax.get('/contacts/abc123'), A);
  assert.equal(auth(), 'Bearer tok-A');
});
await t('F1: a request naming a different sub-account than the call selected is refused, nothing sent', async () => {
  await assert.rejects(lane.kcRunToolCall('t', undefined, () => ax.get('/contacts/', { params: { locationId: B } }), A), /different sub-account/);
  assert.equal(sent.length, 0);
});
await t('F5: bodies nested deeper than the guard inspects are refused (agency lane)', async () => {
  let deep = { locationId: A }; for (let i = 0; i < 20; i++) deep = { x: deep };
  await assert.rejects(ax.post('/contacts/', deep), /nested too deeply/); assert.equal(sent.length, 0);
});
await t('F10: tool results with isError are audited as failures', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'kc-audit-')), 'a.jsonl'); process.env.KC_GHL_AUDIT_LOG = f;
  try {
    await lane.kcRunToolCall('x', undefined, async () => ({ isError: true, content: [] }));
    await lane.kcRunToolCall('y', undefined, async () => ({ content: [] }));
    const rows = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.tool, r.ok]), [['x', false], ['y', true]]);
  } finally { delete process.env.KC_GHL_AUDIT_LOG; }
});
await t('F1b: per-call locationId must be the default or a registered sub-account', async () => {
  assert.throws(() => lane.kcSplitLocationArg({ locationId: 'Z'.repeat(20) }, false), /not registered in this lane/);
  assert.equal(lane.kcSplitLocationArg({ locationId: A }, false).location, A);
});
await t('F2 (agency): absolute URL to another host is refused', async () => {
  await assert.rejects(ax.get('https://attacker.example/contacts/', { params: { locationId: A } }), /host other than the GHL API/);
  assert.equal(sent.length, 0);
});
await t('R5: unpinned lane with an EMPTY token map still pins the API host and refuses unregistered targets', async () => {
  const saved = process.env.KC_GHL_LOCATION_TOKENS; process.env.KC_GHL_LOCATION_TOKENS = '{}'; lane.kcResetLocationTokensForTests?.();
  try {
    await assert.rejects(ax.get('https://attacker.example/contacts/'), /host other than the GHL API/);
    assert.equal(sent.length, 0);
    assert.throws(() => lane.kcSplitLocationArg({ locationId: A }, false), /not registered in this lane/);
    assert.equal(lane.kcSplitLocationArg({ locationId: B }, false).location, B, 'lane default is always allowed');
  } finally { process.env.KC_GHL_LOCATION_TOKENS = saved; lane.kcResetLocationTokensForTests?.(); }
});
await t('R5: lane mode without a base URL refuses instead of failing open', () => {
  assert.throws(() => lane.kcAssertApiHost('https://x.example/a', 'https://x.example/a', undefined), /base URL unknown/);
  assert.throws(() => lane.kcAssertApiHost('/contacts/', 'https://x.example/contacts/', ''), /base URL unknown/);
});
await t('R6: read-only lane refuses writes before sending; reads and read-POSTs pass', async () => {
  process.env.KC_GHL_READ_ONLY = '1';
  try {
    await assert.rejects(ax.put('/contacts/abc', {}, { params: { locationId: A } }), /read-only lane: PUT refused/);
    await assert.rejects(ax.delete('/contacts/abc', { params: { locationId: A } }), /read-only lane: DELETE refused/);
    await assert.rejects(ax.post('/contacts/', { locationId: A }), /read-only lane: POST refused/);
    await assert.rejects(ax.post(`/contacts/abc/tags`, { tags: ['x'] }, { params: { locationId: A } }), /read-only lane: POST refused/);
    assert.equal(sent.length, 0, 'no write left the process');
    await ax.post('/contacts/search', { locationId: A, pageLimit: 1 });
    await ax.post('/opportunities/search', { location_id: A });
    await ax.get('/contacts/', { params: { locationId: A } });
    assert.equal(sent.length, 3);
  } finally { delete process.env.KC_GHL_READ_ONLY; }
});
await t('R6: read-only and agency refusals are reported as KC refusals, not GHL 500s', async () => {
  process.env.KC_GHL_READ_ONLY = '1';
  let msg = ''; try { await ax.put('/contacts/abc', {}, { params: { locationId: A } }); } catch (e) { msg = e.message; } finally { delete process.env.KC_GHL_READ_ONLY; }
  assert.match(msg, /^KC read-only lane/);
  msg = ''; try { await ax.get('/contacts/', { params: { locationIds: [A, B] } }); } catch (e) { msg = e.message; }
  assert.match(msg, /^KC agency lane/);
});
await t('R6: without the read-only flag, writes are not refused by the lane', async () => {
  await ax.put('/contacts/abc', {}, { params: { locationId: A } }); assert.equal(sent.length, 1);
});
await t('outside a KC lane nothing is routed', async () => {
  delete process.env.KC_GHL_LANE;
  try { await ax.get('/contacts/', { params: { locationId: A } }); assert.equal(auth(), 'Bearer tok-AGENCY'); } finally { process.env.KC_GHL_LANE = 'agency_test'; }
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
