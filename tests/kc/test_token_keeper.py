"""Offline tests for kc/bin/kc-ghl-token-keeper: fake Firebase server, throwaway vault.
Run: python3 tests/kc/test_token_keeper.py"""
import base64, http.server, importlib.machinery, importlib.util, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KEEPER = os.path.join(ROOT, 'kc', 'bin', 'kc-ghl-token-keeper')
SECRET_BIN = os.environ.get('KC_SECRET_BIN_FOR_TESTS', '/home/aya/.local/bin/kc-secret')


def jwt(exp):
    b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
    return f"{b({'alg': 'none'})}.{b({'exp': exp})}.sig"


class Firebase(http.server.BaseHTTPRequestHandler):
    """Rules: tokens in DEAD are rejected; ROTATE maps an old token to a new one; others return themselves."""
    DEAD, ROTATE, CALLS, MODE = set(), {}, [], 'ok'

    def do_POST(self):
        body = urllib.parse.parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())
        rt = body['refresh_token'][0]
        Firebase.CALLS.append(rt)
        if Firebase.MODE == 'garbage':
            data = b'<html>not json</html>'
            self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data); return
        if Firebase.MODE == '429':
            return self._send(429, {'error': {'message': 'QUOTA_EXCEEDED'}})
        if rt in Firebase.DEAD:
            return self._send(400, {'error': {'message': 'INVALID_REFRESH_TOKEN'}})
        self._send(200, {'id_token': jwt(int(time.time()) + 3600), 'refresh_token': Firebase.ROTATE.get(rt, rt)})

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *a):
        pass


class KeeperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Firebase)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='keeper-test-', dir=os.environ.get('TMPDIR'))
        self.vault = os.path.join(self.tmp, 'vault'); self.cache = os.path.join(self.tmp, 'cache')
        os.environ.update(KC_SECRETS_HOME=self.vault, KC_SECRET_BIN=SECRET_BIN,
                          KC_GHL_FIREBASE_TOKEN_URL=f'http://127.0.0.1:{self.srv.server_port}/v1/token',
                          KC_GHL_REGISTRY=os.path.join(self.tmp, 'lanes.json'), KC_GHL_ALERT_CHANNEL='')
        json.dump({'token_cache_dir': self.cache, 'lanes': {'lane_a': {'credential_owner': 'owner', 'secrets': {
            'GHL_FIREBASE_REFRESH_TOKEN': 'T_RT', 'GHL_FIREBASE_API_KEY': 'T_KEY'}}}}, open(os.environ['KC_GHL_REGISTRY'], 'w'))
        self.k = self.load()
        self.k.vault_set('T_KEY', 'web-key')
        Firebase.DEAD, Firebase.ROTATE, Firebase.CALLS, Firebase.MODE = set(), {}, [], 'ok'
        self.k.time.sleep = lambda s: None  # no real backoff waits

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def load(self):
        loader = importlib.machinery.SourceFileLoader('keeper', KEEPER)
        spec = importlib.util.spec_from_loader('keeper', loader)
        m = importlib.util.module_from_spec(spec); loader.exec_module(m)
        return m

    def run_keeper(self, *args):
        sys.argv = ['kc-ghl-token-keeper', *args]
        return self.k.main()

    def files(self, suffix):
        return [os.path.join(self.cache, f) for f in os.listdir(self.cache) if f.endswith(suffix)] if os.path.isdir(self.cache) else []

    def status(self):
        return json.load(open(os.path.join(self.cache, 'keeper-status.json')))['owner:T_RT']

    def test_rotation_promotes_new_token_with_backup(self):
        self.k.vault_set('T_RT', 'OLD'); Firebase.ROTATE = {'OLD': 'NEW'}
        self.assertEqual(self.run_keeper(), 0)
        self.assertEqual(self.k.vault_get('T_RT'), 'NEW')
        self.assertEqual(self.k.vault_get('T_RT_PREV'), 'OLD')
        self.assertEqual(self.files('.refresh-pending'), [])
        self.assertEqual(len(self.files('.json')) - 1, 1)  # one cache file + status
        self.assertIn('last_rotation', self.status())

    def test_stable_token_is_not_rewritten_and_fresh_cache_skips_exchange(self):
        self.k.vault_set('T_RT', 'STABLE')
        self.run_keeper()
        self.assertEqual(self.k.vault_get('T_RT_PREV'), '')
        n = len(Firebase.CALLS)
        self.run_keeper()
        self.assertEqual(len(Firebase.CALLS), n, 'fresh cache: no exchange')

    def test_lane_handoff_is_used_first_and_promoted(self):
        self.k.vault_set('T_RT', 'OLD')
        self.run_keeper()  # creates cache dir and cache
        pending = self.files('.json')[0].replace('keeper-status.json', '')
        cache = [f for f in self.files('.json') if not f.endswith('keeper-status.json')][0]
        open(cache.replace('.json', '.refresh-pending'), 'w').write('FROM_LANE')
        self.run_keeper()
        self.assertEqual(Firebase.CALLS[-1], 'FROM_LANE')
        self.assertEqual(self.k.vault_get('T_RT'), 'FROM_LANE')
        self.assertEqual(self.k.vault_get('T_RT_PREV'), 'OLD')
        self.assertEqual(self.files('.refresh-pending'), [])
        self.assertTrue(pending is not None)

    def test_dead_current_falls_back_to_prev(self):
        self.k.vault_set('T_RT', 'BROKEN'); self.k.vault_set('T_RT_PREV', 'GOOD'); Firebase.DEAD = {'BROKEN'}
        self.assertEqual(self.run_keeper(), 0)
        self.assertEqual(self.k.vault_get('T_RT'), 'GOOD')

    def test_all_dead_reports_dead_and_alerts_once(self):
        self.k.vault_set('T_RT', 'X'); Firebase.DEAD = {'X'}
        posted = []
        self.k.slack = lambda text: (posted.append(text), True)[1]
        self.assertEqual(self.run_keeper(), 1)
        self.assertEqual(self.status()['state'], 'dead')
        self.run_keeper()
        self.assertEqual(len(posted), 1, 'alert once, not every run')
        Firebase.DEAD = set()
        self.assertEqual(self.run_keeper(), 0)
        self.assertEqual(len(posted), 2, 'recovery notice')
        self.assertEqual(self.status()['state'], 'ok')

    def test_quota_is_transient_and_alerts_after_three_runs(self):
        self.k.vault_set('T_RT', 'OK1'); Firebase.MODE = '429'
        posted = []; self.k.slack = lambda text: (posted.append(text), True)[1]
        for _ in range(2):
            self.assertEqual(self.run_keeper(), 1)
        self.assertEqual((self.status()['state'], len(posted)), ('retrying', 0))
        self.run_keeper()
        self.assertEqual(len(posted), 1)
        self.assertEqual(self.k.vault_get('T_RT'), 'OK1', 'vault untouched on quota errors')

    def test_vault_write_failure_keeps_new_token_pending_then_recovers(self):
        self.k.vault_set('T_RT', 'OLD'); Firebase.ROTATE = {'OLD': 'NEW'}
        real = self.k.vault_set
        def failing(key, value):
            if key == 'T_RT':
                raise RuntimeError('vault write failed for T_RT')
            real(key, value)
        self.k.vault_set = failing
        self.assertEqual(self.run_keeper(), 1)
        pend = self.files('.refresh-pending')
        self.assertEqual(len(pend), 1); self.assertEqual(open(pend[0]).read(), 'NEW')
        self.assertEqual(oct(os.stat(pend[0]).st_mode & 0o777), '0o600')
        Firebase.DEAD = {'OLD'}  # worst case: provider revoked the old token
        self.k.vault_set = real
        self.assertEqual(self.run_keeper(), 0)
        self.assertEqual(self.k.vault_get('T_RT'), 'NEW')
        self.assertEqual(self.files('.refresh-pending'), [])

    def _two_logins(self):
        reg = json.load(open(os.environ['KC_GHL_REGISTRY']))
        reg['lanes']['lane_b'] = {'credential_owner': 'other', 'secrets': {'GHL_FIREBASE_REFRESH_TOKEN': 'T_RT2', 'GHL_FIREBASE_API_KEY': 'T_KEY'}}
        json.dump(reg, open(os.environ['KC_GHL_REGISTRY'], 'w'))
        self.k.vault_set('T_RT2', 'SECOND')

    def test_vault_timeout_fails_one_login_and_the_run_continues(self):
        self._two_logins(); self.k.vault_set('T_RT', 'S')
        real = self.k.vault_get
        def slow(key):
            if key == 'T_RT':
                raise self.k.Transient('vault read timed out or failed (TimeoutExpired)')
            return real(key)
        self.k.vault_get = slow
        self.assertEqual(self.run_keeper(), 1)
        st = json.load(open(os.path.join(self.cache, 'keeper-status.json')))
        self.assertEqual(st['owner:T_RT']['state'], 'retrying')
        self.assertEqual(st['other:T_RT2']['state'], 'ok', 'second login still processed')

    def test_non_json_firebase_response_is_transient(self):
        self.k.vault_set('T_RT', 'S'); Firebase.MODE = 'garbage'
        self.assertEqual(self.run_keeper(), 1)
        self.assertIn('non-JSON', self.status()['last_error'])

    def test_failed_alert_is_retried_and_success_marks_it(self):
        self.k.vault_set('T_RT', 'X'); Firebase.DEAD = {'X'}
        attempts = []
        self.k.slack = lambda text: (attempts.append(text), len(attempts) >= 2)[1]   # first post fails, second succeeds
        self.run_keeper(); self.assertFalse(self.status().get('alerted'))
        self.run_keeper(); self.assertTrue(self.status().get('alerted'))
        self.run_keeper(); self.assertEqual(len(attempts), 2, 'no repeat after a delivered alert')

    def test_dead_pending_token_is_removed(self):
        self.k.vault_set('T_RT', 'GOOD'); self.run_keeper()
        pending = [f for f in self.files('.json') if not f.endswith('keeper-status.json')][0][:-5] + '.refresh-pending'
        with open(pending, 'w') as f:
            f.write('STALE')
        Firebase.DEAD = {'STALE'}
        self.assertEqual(self.run_keeper('--force'), 0)
        self.assertFalse(os.path.exists(pending), 'rejected hand-off token removed')
        n = len(Firebase.CALLS); self.run_keeper('--force')
        self.assertNotIn('STALE', Firebase.CALLS[n:])

    def test_vault_read_error_is_transient_not_dead(self):
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        real_bin = self.k.SECRET_BIN
        broken = os.path.join(self.tmp, 'broken-secret')
        with open(broken, 'w') as f:
            f.write('#!/bin/sh\necho "vault locked" >&2\nexit 3\n')
        os.chmod(broken, 0o700)
        self.k.SECRET_BIN = broken
        try:
            self.assertEqual(self.run_keeper('--force'), 1)
            self.assertEqual(self.status()['state'], 'retrying')
            self.assertIn('vault read failed', self.status()['last_error'])
        finally:
            self.k.SECRET_BIN = real_bin

    def test_invalid_registry_is_reported_not_a_traceback(self):
        reg = json.load(open(os.environ['KC_GHL_REGISTRY'])); del reg['token_cache_dir']
        json.dump(reg, open(os.environ['KC_GHL_REGISTRY'], 'w'))
        alerts = []; self.k.slack = lambda text: (alerts.append(text), True)[1]
        self.assertEqual(self.run_keeper(), 2)
        self.assertEqual(len(alerts), 1); self.assertIn('token_cache_dir', alerts[0])

    def test_failed_recovery_notice_does_not_suppress_next_incident(self):
        self.k.vault_set('T_RT', 'X'); Firebase.DEAD = {'X'}
        posts = []; ok = {'v': True}
        self.k.slack = lambda text: (posts.append(text), ok['v'])[1]
        self.run_keeper()                                   # dead -> incident alert delivered
        self.assertEqual(len(posts), 1)
        Firebase.DEAD = set(); ok['v'] = False
        self.run_keeper('--force')                          # healthy, recovery post fails
        self.assertTrue(self.status().get('recovery_pending'))
        Firebase.DEAD = {'X'}; ok['v'] = True
        self.run_keeper('--force')                          # new incident must alert
        self.assertIn('rotating_light', posts[-1])
        self.assertTrue(self.status().get('alerted'))

    def test_null_lane_entry_is_a_registry_problem(self):
        reg = json.load(open(os.environ['KC_GHL_REGISTRY'])); reg['lanes']['broken'] = None
        json.dump(reg, open(os.environ['KC_GHL_REGISTRY'], 'w'))
        self.k.ALERT_CHANNEL = 'C_TEST'
        alerts = []; self.k.slack = lambda text: (alerts.append(text), True)[1]
        self.assertEqual(self.run_keeper(), 2)
        self.assertEqual(self.run_keeper(), 2)
        self.assertEqual(len(alerts), 1, 'one alert per distinct registry problem')
        self.assertIn('broken', alerts[0])

    def test_second_keeper_run_is_skipped_while_one_runs(self):
        import fcntl
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        held = open(os.environ['KC_GHL_REGISTRY'] + '.keeper.lock', 'a'); fcntl.flock(held, fcntl.LOCK_EX)
        try:
            n = len(Firebase.CALLS)
            self.assertEqual(self.run_keeper('--force'), 0)
            self.assertEqual(len(Firebase.CALLS), n)
        finally:
            held.close()

    def test_old_status_healthy_but_alerted_still_alerts_new_incident(self):
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        st = json.load(open(os.path.join(self.cache, 'keeper-status.json')))
        key = next(k for k in st if k.startswith('owner:'))
        st[key].update(state='ok', alerted=True)          # format left by the previous keeper after a failed recovery post
        json.dump(st, open(os.path.join(self.cache, 'keeper-status.json'), 'w'))
        self.k.vault_set('T_RT', 'X'); Firebase.DEAD = {'X', 'S'}
        posts = []; self.k.slack = lambda text: (posts.append(text), True)[1]
        self.run_keeper('--force')
        self.assertTrue(posts and 'rotating_light' in posts[-1], 'new incident alerted')

    def test_registry_marker_cleared_once_valid_even_if_absent(self):
        self.k.vault_set('T_RT', 'S')
        self.assertEqual(self.run_keeper(), 0)            # no marker present: no error
        open(os.environ['KC_GHL_REGISTRY'] + '.keeper-alerted', 'w').write('old problem')
        self.assertEqual(self.run_keeper(), 0)
        self.assertFalse(os.path.exists(os.environ['KC_GHL_REGISTRY'] + '.keeper-alerted'))

    def test_owed_recovery_survives_a_failure_that_does_not_alert(self):
        self.k.vault_set('T_RT', 'X'); Firebase.DEAD = {'X'}
        posts = []; ok = {'v': True}
        self.k.slack = lambda text: (posts.append(text), ok['v'])[1]
        self.run_keeper()                                     # dead -> alert delivered
        Firebase.DEAD = set(); ok['v'] = False
        self.run_keeper('--force')                            # healthy, recovery post fails
        Firebase.DEAD = set(); Firebase.MODE = '429'; ok['v'] = True
        self.run_keeper('--force')                            # one transient failure, below the alert threshold
        Firebase.MODE = 'ok'
        self.run_keeper('--force')                            # healthy again -> owed recovery notice sent
        self.assertEqual(sum('healthy again' in p for p in posts if p), 2, posts)   # failed attempt + delivered one
        self.assertFalse(self.status().get('recovery_pending'))

    def test_registry_marker_not_latched_without_a_channel(self):
        reg = json.load(open(os.environ['KC_GHL_REGISTRY'])); reg['lanes']['broken'] = None
        json.dump(reg, open(os.environ['KC_GHL_REGISTRY'], 'w'))
        self.k.ALERT_CHANNEL = ''
        self.assertEqual(self.run_keeper(), 2)
        self.assertFalse(os.path.exists(os.environ['KC_GHL_REGISTRY'] + '.keeper-alerted'))

    def test_old_status_owed_recovery_survives_one_transient_failure(self):
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        sf = os.path.join(self.cache, 'keeper-status.json'); st = json.load(open(sf))
        key = next(k for k in st if k.startswith('owner:')); st[key].update(state='ok', alerted=True, failures=0); json.dump(st, open(sf, 'w'))
        posts = []; self.k.slack = lambda text: (posts.append(text), True)[1]
        Firebase.MODE = '429'; self.run_keeper('--force')          # one transient failure, below threshold
        Firebase.MODE = 'ok'; self.run_keeper('--force')            # healthy
        self.assertEqual(sum('healthy again' in p for p in posts), 1, posts)

    def test_no_alert_channel_never_counts_as_delivered(self):
        self.k.ALERT_CHANNEL = ''
        self.assertFalse(self.k.slack('x'))

    def test_lock_unavailable_alerts_and_does_not_run_unlocked(self):
        alerts = []; self.k.slack = lambda text: (alerts.append(text), True)[1]
        self.k.REGISTRY = os.path.join(self.tmp, 'missing-dir', 'lanes.json')
        n = len(Firebase.CALLS)
        self.assertEqual(self.run_keeper(), 2)
        self.assertEqual(len(Firebase.CALLS), n); self.assertTrue(alerts and 'run lock' in alerts[0])

    def _cid(self):
        cache = [f for f in self.files('.json') if not f.endswith('keeper-status.json')][0]
        return os.path.basename(cache)[:-5]

    def _hold_py(self, cid):
        code = "import socket,time\ns=socket.socket(socket.AF_UNIX)\ns.bind('\\x00kc-ghl-refresh-%s')\nprint('held',flush=True)\ntime.sleep(60)" % cid
        ch = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
        ch.stdout.readline()
        return ch

    def _hold_node(self, cid):
        code = "const s=require('net').createServer();s.listen({path:'\\u0000kc-ghl-refresh-%s'},()=>{process.stdout.write('held\\n')});setInterval(()=>{},1e6)" % cid
        ch = subprocess.Popen(['node', '-e', code], stdout=subprocess.PIPE, text=True)
        ch.stdout.readline()
        return ch

    def test_live_lock_is_respected(self):
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        ch = self._hold_py(self._cid())
        try:
            self.k.LOCK_WAIT_S = 0.3
            n = len(Firebase.CALLS)
            self.assertEqual(self.run_keeper('--force'), 1)
            self.assertEqual(len(Firebase.CALLS), n, 'no refresh while another process holds the lock')
            self.assertIn('lock', self.status()['last_error'])
        finally:
            ch.kill(); ch.wait()

    def test_holder_crash_frees_the_lock_immediately(self):
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        ch = self._hold_py(self._cid())
        ch.kill(); ch.wait()
        self.assertEqual(self.run_keeper('--force'), 0)

    def test_lane_and_keeper_share_one_lock(self):
        """Cross-language: a Node lane holding the lock blocks the keeper."""
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        ch = self._hold_node(self._cid())
        try:
            self.k.LOCK_WAIT_S = 0.3
            self.assertEqual(self.run_keeper('--force'), 1)
        finally:
            ch.kill(); ch.wait()

    def test_no_secret_values_in_output_or_status(self):
        import io, contextlib
        self.k.vault_set('T_RT', 'SECRETVALUE123'); Firebase.ROTATE = {'SECRETVALUE123': 'NEWSECRET456'}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.run_keeper()
        text = buf.getvalue() + open(os.path.join(self.cache, 'keeper-status.json')).read()
        self.assertNotIn('SECRETVALUE123', text); self.assertNotIn('NEWSECRET456', text)
        self.assertIn('rotated vault', text)

    def test_cache_is_readable_by_the_lane_code(self):
        """Cross-language check: a lane on the same login uses the keeper's token without calling Firebase."""
        dist = os.path.join(ROOT, 'dist', 'clients', 'workflow-builder-client.js')
        if not os.path.exists(dist):
            self.skipTest('dist not built')
        self.k.vault_set('T_RT', 'S'); self.run_keeper()
        n = len(Firebase.CALLS)
        js = f"""
        process.env.KC_GHL_LANE='t'; process.env.KC_GHL_TOKEN_CACHE_DIR={json.dumps(self.cache)}; process.env.KC_GHL_CREDENTIAL='owner:T_RT';
        process.env.KC_GHL_PINNED_LOCATION='AAAAAAAAAAAAAAAAAAA1';
        globalThis.fetch = async (u) => {{ if (String(u).includes('token')) {{ console.log('FIREBASE_CALLED'); }} return new Response('{{"rows":[]}}', {{status:200}}); }};
        const {{ WorkflowBuilderClient: C }} = await import({json.dumps(dist)});
        const c = new C({{ apiKey:'p', firebaseApiKey:'web-key', firebaseRefreshToken:'S', userId:'u', locationId:'AAAAAAAAAAAAAAAAAAA1' }});
        await c.listWorkflows({{ limit: 1 }}); console.log('LANE_OK');
        """
        out = subprocess.run(['node', '--input-type=module', '-e', js], capture_output=True, text=True, timeout=60)
        self.assertIn('LANE_OK', out.stdout, out.stderr[-400:])
        self.assertNotIn('FIREBASE_CALLED', out.stdout)
        self.assertEqual(len(Firebase.CALLS), n)


if __name__ == '__main__':
    unittest.main(verbosity=2)
