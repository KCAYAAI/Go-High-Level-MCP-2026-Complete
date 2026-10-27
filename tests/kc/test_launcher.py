"""Offline tests for kc/bin/kc-ghl registry validation. Run: python3 tests/kc/test_launcher.py"""
import copy, json, os, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LAUNCHER = os.path.join(ROOT, 'kc', 'bin', 'kc-ghl')
ID = lambda n: f'EXAMPLE{n:013d}'

GOOD = {
    'server': '/bin/true', 'token_cache_dir': '/tmp/kc-test-cache', 'audit_log': '/tmp/kc-test-audit.jsonl',
    'common_env': {'GHL_API_VERSION': 'v3'},
    'lanes': {
        'loc_lane': {'account': 'Loc', 'location_id': ID(1), 'user_id': ID(2), 'company_id': ID(3), 'credential_owner': 'scout',
                     'callers': ['scout'], 'secrets': {'GHL_API_KEY': 'LOC_TOKEN', 'GHL_FIREBASE_API_KEY': 'FB_KEY', 'GHL_FIREBASE_REFRESH_TOKEN': 'FB_RT'}},
        'agency_lane': {'account': 'Agency', 'location_id': ID(1), 'user_id': ID(2), 'company_id': ID(3), 'credential_owner': 'roary', 'pinned': False,
                        'callers': ['roary', 'scout'], 'secrets': {'GHL_API_KEY': 'AGENCY_TOKEN'},
                        'location_tokens': {ID(1): 'SUB_ONE', ID(4): 'SUB_TWO'}, 'env': {'GHL_USER_TYPE': ''}},
    },
}


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='kc-launcher-', dir=os.environ.get('TMPDIR'))
        helper = os.path.join(self.tmp, 'kc-secret')
        with open(helper, 'w') as f:
            f.write('#!/bin/sh\n[ "$1" = get ] && echo "value-for-$2"\n')
        os.chmod(helper, 0o700)
        self.env = {**os.environ, 'KC_SECRET_BIN': helper, 'KC_GHL_REGISTRY': os.path.join(self.tmp, 'lanes.json')}

    def run_with(self, reg, *args):
        with open(self.env['KC_GHL_REGISTRY'], 'w') as f:
            f.write(reg if isinstance(reg, str) else json.dumps(reg))
        return subprocess.run([sys.executable, LAUNCHER, *args], capture_output=True, text=True, env=self.env, timeout=30)

    def assert_clean_fail(self, reg, needle, *args):
        r = self.run_with(reg, *(args or ('--list',)))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertNotIn('Traceback', r.stderr)
        self.assertTrue(r.stderr.startswith('kc-ghl: '), r.stderr)
        self.assertIn(needle, r.stderr)

    def mutate(self, fn):
        reg = copy.deepcopy(GOOD); fn(reg); return reg

    def test_good_registry_checks(self):
        r = self.run_with(GOOD, '--lane', 'agency_lane', '--caller', 'scout', '--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('2 sub-account tokens', r.stdout)

    def test_not_json(self):
        self.assert_clean_fail('{nope', 'cannot read lane registry')

    def test_missing_top_level_paths(self):
        for k in ('server', 'token_cache_dir', 'audit_log'):
            self.assert_clean_fail(self.mutate(lambda r: r.pop(k)), k)

    def test_secrets_wrong_type(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('secrets', ['GHL_API_KEY'])), 'secrets must map')
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('secrets', 'X')), 'secrets must map')

    def test_secrets_without_api_key(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('secrets', {'GHL_FIREBASE_API_KEY': 'FB_KEY'})), 'GHL_API_KEY')

    def test_bad_ids(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('location_id', '../x')), 'location_id')

    def test_pinned_not_bool(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('pinned', 'no')), 'pinned')

    def test_callers_wrong(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('callers', 'scout')), 'callers')

    def test_location_tokens_on_pinned_lane(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('location_tokens', {ID(1): 'SUB_ONE'})), 'only for unpinned')

    def test_location_tokens_malformed(self):
        self.assert_clean_fail(self.mutate(lambda r: r['lanes']['agency_lane'].__setitem__('location_tokens', {'short': 'SUB'})), 'location_tokens')

    def test_unknown_caller_and_lane(self):
        self.assert_clean_fail(GOOD, 'not approved', '--lane', 'loc_lane', '--caller', 'brand', '--check')
        self.assert_clean_fail(GOOD, 'unknown lane', '--lane', 'nope', '--caller', 'scout', '--check')

    def test_lane_env_cannot_override_launcher_variables(self):
        for k in ('KC_GHL_PINNED_LOCATION', 'KC_GHL_LANE', 'GHL_API_KEY', 'GHL_LOCATION_ID', 'GHL_FIREBASE_REFRESH_TOKEN'):
            self.assert_clean_fail(self.mutate(lambda r: r['lanes']['loc_lane'].__setitem__('env', {k: ''})), 'launcher-controlled')

    def test_lane_env_may_extend_agency_paths(self):
        reg = self.mutate(lambda r: r['lanes']['agency_lane'].__setitem__('env', {'GHL_USER_TYPE': '', 'KC_GHL_AGENCY_PATHS': '/x'}))
        self.assertEqual(self.run_with(reg, '--lane', 'agency_lane', '--caller', 'roary', '--check').returncode, 0)

    def test_common_env_reserved_or_non_string(self):
        self.assert_clean_fail(self.mutate(lambda r: r['common_env'].__setitem__('KC_GHL_LANE', 'x')), 'launcher-controlled')
        self.assert_clean_fail(self.mutate(lambda r: r['common_env'].__setitem__('GHL_API_VERSION', 3)), 'common_env')

    def test_check_works_without_account_label(self):
        r = self.run_with(self.mutate(lambda r: r['lanes']['loc_lane'].pop('account')), '--lane', 'loc_lane', '--caller', 'scout', '--check')
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_add_subaccount_rejects_bad_input_offline(self):
        self.assert_clean_fail(GOOD, 'location ID', '--add-subaccount', 'short', '--vault-key', 'SUB_X')
        self.assert_clean_fail(GOOD, 'pinned', '--add-subaccount', ID(9), '--vault-key', 'SUB_X', '--lane', 'loc_lane')


if __name__ == '__main__':
    unittest.main(verbosity=1)
