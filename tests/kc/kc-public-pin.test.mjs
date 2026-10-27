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
const adapter = async (config) => { sent.push(config); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
ax.defaults.adapter = adapter;
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
await t('traversal via tool arg locationId "<own>/../<other>"', () => blocked(ax.get(`/locations/${B}/../${A}/customFields`)));
await t('percent-encoded location ID in path', () => blocked(ax.get(`/locations/%41${A.slice(1)}/customFields`)));
await t('location ID in a non-/locations path (catalog template)', () => blocked(ax.get(`/social-media-posting/${A}/categories`)));
await t('locationIds array in body', () => blocked(ax.post('/users/', { locationIds: [B, A] })));
await t('nested locationId in body', () => blocked(ax.post('/x/bulk', { contacts: [{ locationId: B }, { locationId: A }] })));
await t('form-urlencoded string body', () => blocked(ax.post('/oauth/locationToken', `companyId=c&locationId=${A}`)));
await t('URLSearchParams body', () => blocked(ax.post('/oauth/locationToken', new URLSearchParams({ locationId: A }))));
await t('FormData altId/altType=location', async () => { const f = new FormData(); f.append('altType', 'location'); f.append('altId', A); await blocked(ax.post('/medias/upload-file', f)); });
await t('own-account shapes of the same kinds still pass', async () => {
  sent = [];
  await ax.get(`/social-media-posting/${B}/categories`);
  await ax.post('/users/', { locationIds: [B] });
  await ax.post('/oauth/locationToken', `companyId=c&locationId=${B}`);
  await ax.get('/contacts/', { params: { query: 'my flow #1 50%' } });
  assert.equal(sent.length, 4);
});
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
await t('empty path segment /locations//<other>', () => blocked(ax.get(`/locations//${A}/customFields`)));
await t('dot segment /locations/./<other>', () => blocked(ax.get(`/locations/./${A}`)));
await t('upper-case /Locations/<other>', () => blocked(ax.get(`/Locations/${A}/customFields`)));
await t('upper-case catalog path /Social-Media-Posting/<other>/categories', () => blocked(ax.get(`/Social-Media-Posting/${A}/categories`)));
await t('other ID with junk appended /locations/<other>;x', () => blocked(ax.get(`/locations/${A};x`)));
await t('tab inside the path', () => blocked(ax.get(`/loca\ttions/${A}`)));
await t('array params serialize as locationId[]=', () => blocked(ax.get('/contacts/', { params: { locationId: [B, A] } })));
await t('indexed query key locationIds[0]', () => blocked(ax.get(`/users/?locationIds[0]=${A}`)));
await t('bracketed key filter[locationId]', () => blocked(ax.get(`/contacts/?filter[locationId]=${A}`)));
await t('upper-case query key LocationId', () => blocked(ax.get(`/contacts/?LocationId=${A}`)));
await t('bracketed form key locationIds[]', () => blocked(ax.post('/oauth/locationToken', `locationIds[]=${A}`)));
await t('bracketed FormData key', async () => { const f = new FormData(); f.append('locationIds[]', A); await blocked(ax.post('/medias/upload-file', f)); });
await t('nested object under a location key', () => blocked(ax.post('/x', { locationIds: { first: B, second: A } })));
await t('own-account versions of the new shapes still pass', async () => {
  sent = [];
  await ax.get('/contacts/', { params: { locationId: [B] } });
  await ax.get(`/users/?locationIds[0]=${B}`);
  await ax.get(`/Locations/${B}`);
  await ax.get('/locations/search', { params: { limit: 1 } });
  assert.equal(sent.length, 4);
});
await t('a request with its own (non-aborted) signal still obeys caller cancellation', async () => {
  const own = new AbortController(); const caller = new AbortController(); let seen;
  ax.defaults.adapter = async (config) => { seen = config.signal; caller.abort(); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
  try {
    await assert.rejects(lane.kcRunToolCall('t', caller.signal, () => ax.get(`/locations/${B}`, { signal: own.signal })), /cancel/i);
    assert.ok(seen && seen !== own.signal, 'signal was composed');
    assert.equal(seen.aborted, true, 'caller cancel reaches the request');
    assert.equal(own.signal.aborted, false);
  } finally { ax.defaults.adapter = adapter; }
});
await t('tool level: OfficialSpecTools catalog endpoint for another account never reaches GHL', async () => {
  const { OfficialSpecTools } = await import('../../dist/tools/official-spec-tools.js');
  const tools = new OfficialSpecTools(client); sent = [];
  let out; try { out = await tools.handleToolCall('official_social_media_posting_get_categories_location_id', { locationId: A }); } catch (e) { out = e; }
  assert.match(String(out?.message ?? JSON.stringify(out)), /KC lane guard/);
  assert.equal(sent.length, 0);
  await tools.handleToolCall('official_social_media_posting_get_categories_location_id', { locationId: B });
  assert.equal(sent.length, 1);
});
await t('catalog missing, malformed, or too small: pinned lane fails closed', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'kc-cat-'));
  const real = (await import('node:url')).fileURLToPath(new URL('../../dist/tools/official-spec-endpoints.json', import.meta.url));
  try {
    for (const [name, body] of [['missing.json', null], ['bad.json', '{not json'], ['obj.json', '{}'], ['small.json', JSON.stringify([{ path: '/x/{locationId}' }])]]) {
      const f = join(d, name); if (body !== null) writeFileSync(f, body);
      lane.kcSetCatalogPathForTests(f);
      sent = [];
      await assert.rejects(ax.get(`/locations/${B}`), /endpoint catalog/, name);
      assert.equal(sent.length, 0, name);
    }
  } finally { lane.kcSetCatalogPathForTests(real); }
  sent = []; await ax.get(`/locations/${B}`); assert.equal(sent.length, 1, 'real catalog restored');
});
await t('guard refusals are reported as KC refusals, not "GHL API Error (500)"', async () => {
  let msg = ''; try { await ax.get(`/locations/${A}`); } catch (e) { msg = e.message; }
  assert.match(msg, /^KC lane guard/);
});
await t('a public write cut off in flight reports an unknown outcome', async () => {
  const caller = new AbortController();
  ax.defaults.adapter = (config) => new Promise((_, reject) => {
    config.signal.addEventListener('abort', () => { const e = new Error('canceled'); e.code = 'ERR_CANCELED'; e.config = config; e.isAxiosError = true; reject(e); });
    setTimeout(() => caller.abort(), 20);
  });
  try {
    await assert.rejects(lane.kcRunToolCall('t', caller.signal, () => ax.post('/contacts/', { locationId: B })), /was sent but did not finish.*may or may not have applied/s);
  } finally { ax.defaults.adapter = adapter; }
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
