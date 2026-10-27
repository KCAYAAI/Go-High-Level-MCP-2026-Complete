// KC public-API account pin tests. Offline: axios adapter stubbed. Placeholder IDs only.
// Run after `npm run build:server`:  node tests/kc/kc-public-pin.test.mjs
import assert from 'node:assert/strict';
const A = 'AAAAAAAAAAAAAAAAAAA1', B = 'AAAAAAAAAAAAAAAAAAA2';
Object.assign(process.env, { KC_GHL_LANE: 'test_lane', KC_GHL_PINNED_LOCATION: B });
const { GHLApiClient } = await import('../../dist/clients/ghl-api-client.js');
const lane = await import('../../dist/kc/lane.js');
const client = new GHLApiClient({ accessToken: 'pit', baseUrl: 'https://services.leadconnectorhq.com', version: '2021-07-28', locationId: B, apiGeneration: 'v3' });
const ax = client.axiosInstance;
let sent = [];
ax.defaults.adapter = async (config) => { sent.push(config); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
const results = [];
const t = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
const blocked = async (p) => { sent = []; await assert.rejects(p, /KC lane guard/); assert.equal(sent.length, 0, 'nothing sent'); };

await t('own account allowed: path, params, URLSearchParams, body, omitted', async () => {
  sent = [];
  await ax.get(`/locations/${B}`);
  await ax.get('/contacts/', { params: { locationId: B } });
  await ax.get('/contacts/', { params: new URLSearchParams({ locationId: B }) });
  await ax.post('/contacts/', { locationId: B, firstName: 'x' });
  await ax.get('/contacts/abc123');
  await ax.get('/locations/search', { params: { limit: 1 } }); // non-ID segment is not a location
  assert.equal(sent.length, 6);
});
await t('other account in path', () => blocked(ax.get(`/locations/${A}/customFields`)));
await t('path traversal /locations/<own>/../<other>', () => blocked(ax.get(`/locations/${B}/../${A}`)));
await t('encoded traversal', () => blocked(ax.get(`/locations/${B}/%2e%2e/${A}`)));
await t('other account in params object', () => blocked(ax.get('/contacts/', { params: { locationId: A } })));
await t('other account in URLSearchParams', () => blocked(ax.get('/contacts/', { params: new URLSearchParams({ locationId: A }) })));
await t('duplicate key: own then other', () => blocked(ax.get(`/contacts/?locationId=${B}&locationId=${A}`)));
await t('other account in query string (location_id)', () => blocked(ax.get(`/opportunities/search?location_id=${A}`)));
await t('other account in JSON body', () => blocked(ax.post('/contacts/', { locationId: A })));
await t('other account in string body', () => blocked(ax.post('/contacts/', JSON.stringify({ locationId: A }))));
await t('altId with altType=location', () => blocked(ax.get('/medias/files', { params: { altType: 'location', altId: A } })));
await t('client method passing another locationId never reaches GHL', async () => {
  sent = [];
  let out; try { out = await client.searchContacts({ locationId: A, query: 'x', limit: 1 }); } catch (e) { out = e; }
  assert.match(JSON.stringify(out?.message ?? out), /KC lane guard/);
  assert.equal(sent.length, 0);
});
await t('public writes respect the call deadline', async () => {
  sent = [];
  const realNow = Date.now;
  await lane.kcRunToolCall('t', undefined, async () => {
    const start = realNow(); Date.now = () => start + lane.KC_CALL_BUDGET_MS - 5_000;
    try { await assert.rejects(ax.post('/contacts/', { locationId: B }), /not sent/); } finally { Date.now = realNow; }
  });
  assert.equal(sent.length, 0);
});
await t('agency lane (unpinned) allows any account', async () => {
  delete process.env.KC_GHL_PINNED_LOCATION; sent = [];
  try { await ax.get(`/locations/${A}`); assert.equal(sent.length, 1); } finally { process.env.KC_GHL_PINNED_LOCATION = B; }
});
await t('outside a KC lane nothing changes (upstream behavior)', async () => {
  delete process.env.KC_GHL_LANE; sent = [];
  try { await ax.get(`/locations/${A}`); assert.equal(sent.length, 1); } finally { process.env.KC_GHL_LANE = 'test_lane'; }
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
