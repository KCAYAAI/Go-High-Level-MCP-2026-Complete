// KC public-API location pin test. Offline: axios adapter is stubbed. Run from busybee-next.
import assert from 'node:assert/strict';
const KC = 'AAAAAAAAAAAAAAAAAAA1', NEXT = 'AAAAAAAAAAAAAAAAAAA2';
process.env.KC_GHL_PINNED_LOCATION = NEXT;
const { GHLApiClient } = await import('../../dist/clients/ghl-api-client.js');
const client = new GHLApiClient({ accessToken: 'pit', baseUrl: 'https://services.leadconnectorhq.com', version: '2021-07-28', locationId: NEXT, apiGeneration: 'v3' });
const ax = client.axiosInstance;
let sent = [];
ax.defaults.adapter = async (config) => { sent.push(config); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
const results = [];
const t = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
const blocked = (p) => assert.rejects(p, /KC lane guard/);

await t('own location allowed (path, params, body, omitted)', async () => {
  sent = [];
  await ax.get(`/locations/${NEXT}`);
  await ax.get('/contacts/', { params: { locationId: NEXT } });
  await ax.post('/contacts/', { locationId: NEXT, firstName: 'x' });
  await ax.get('/contacts/abc123');
  assert.equal(sent.length, 4);
});
await t('other location blocked in path', () => blocked(ax.get(`/locations/${KC}/customFields`)));
await t('other location blocked in params', () => blocked(ax.get('/contacts/', { params: { locationId: KC } })));
await t('other location blocked in query string', () => blocked(ax.get(`/opportunities/search?location_id=${KC}`)));
await t('other location blocked in JSON body', () => blocked(ax.post('/contacts/', { locationId: KC })));
await t('other location blocked in string body', () => blocked(ax.post('/contacts/', JSON.stringify({ locationId: KC }))));
await t('altId with altType=location blocked', () => blocked(ax.get('/medias/files', { params: { altType: 'location', altId: KC } })));
await t('client method passing another locationId is blocked', async () => {
  sent = [];
  let out;
  try { out = await client.searchContacts({ locationId: KC, query: 'x', limit: 1 }); } catch (e) { out = e; }
  assert.match(JSON.stringify(out?.message ?? out), /KC lane guard/, 'caller sees the guard error');
  assert.equal(sent.length, 0, 'nothing sent to GHL');
});
await t('agency lane (unpinned) allows any location', async () => {
  delete process.env.KC_GHL_PINNED_LOCATION; sent = [];
  await ax.get(`/locations/${KC}`);
  assert.equal(sent.length, 1);
  process.env.KC_GHL_PINNED_LOCATION = NEXT;
});
for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
