"""KC GHL lane cutover. Sequential per profile: backup, set new lanes via hermes CLI, unset old, verify.
Stops at the first failed verification. Prints no secrets (configs hold only env references)."""
import copy, datetime, json, os, shutil, subprocess, sys, yaml

H = '/home/aya/.hermes'
STAMP = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
KC = ['ghl_kc', 'ghl_kcnext']
LD = ['ghl_lionsden', 'ghl_lionsden_demo']
PLAN = [  # profile, caller, {new lane: old entry to copy settings from}, old entries to remove
    ('scout',   'scout',   {l: 'highlevel_busybee' for l in KC}, ['highlevel_busybee']),
    ('default', 'aya',     {l: 'highlevel_busybee' for l in KC}, ['highlevel_busybee']),
    ('dev',     'dev',     {l: 'highlevel_busybee' for l in KC}, ['highlevel_busybee']),
    ('fiona',   'fiona',   {l: 'highlevel_busybee' for l in KC}, ['highlevel_busybee']),
    ('cadence', 'cadence', {l: 'highlevel_busybee' for l in KC}, ['highlevel_busybee']),
    ('roary',   'roary',   {'ghl_lionsden': 'highlevel_lionsden', 'ghl_lionsden_demo': 'highlevel_lionsden_demo'}, ['highlevel_lionsden', 'highlevel_lionsden_demo']),
    ('brand',   'brand',   {l: 'highlevel_busybee' for l in LD}, ['highlevel_busybee']),
]
KEEP = ['enabled', 'lazy', 'idle_timeout_seconds', 'timeout', 'connect_timeout', 'sampling']
only = sys.argv[1:]

def cfg_path(p):
    return f'{H}/config.yaml' if p == 'default' else f'{H}/profiles/{p}/config.yaml'

def hset(p, key, value):
    v = value if isinstance(value, str) else json.dumps(value)
    r = subprocess.run(['hermes', '-p', p, 'config', 'set', key, v], capture_output=True, text=True, cwd=H)
    if r.returncode != 0 or '✓' not in r.stdout:
        sys.exit(f'ABORT {p}: set {key} failed: {(r.stdout + r.stderr)[-300:]}')

def hunset(p, key):
    r = subprocess.run(['hermes', '-p', p, 'config', 'unset', key], capture_output=True, text=True, cwd=H)
    if r.returncode != 0:
        sys.exit(f'ABORT {p}: unset {key} failed: {(r.stdout + r.stderr)[-300:]}')

for prof, caller, lanes, remove in PLAN:
    if only and prof not in only:
        continue
    path = cfg_path(prof)
    before = yaml.safe_load(open(path))
    servers = before.get('mcp_servers') or {}
    if any(l in servers for l in lanes):
        print(f'{prof}: new lanes already present, skipping')
        continue
    bdir = (f'{H}/backups' if prof == 'default' else f'{H}/profiles/{prof}/backups') + f'/kc-ghl-cutover-{STAMP}'
    os.makedirs(bdir, mode=0o700, exist_ok=True)
    shutil.copy2(path, f'{bdir}/config.yaml')
    os.chmod(f'{bdir}/config.yaml', 0o600)

    expected = {}
    for lane, src in lanes.items():
        old = servers[src]
        entry = {'command': '/home/aya/.local/bin/kc-ghl', 'args': ['--lane', lane, '--caller', caller]}
        entry.update({k: old[k] for k in KEEP if k in old})
        expected[lane] = entry
        for k, v in entry.items():
            hset(prof, f'mcp_servers.{lane}.{k}', v)
    for old in remove:
        hunset(prof, f'mcp_servers.{old}')

    after = yaml.safe_load(open(path))
    am = after.get('mcp_servers') or {}
    ok_new = all(am.get(l) == e for l, e in expected.items())
    ok_old = all(o not in am for o in remove)
    b2, a2 = copy.deepcopy(before), copy.deepcopy(after)
    bm, amm = b2.pop('mcp_servers'), a2.pop('mcp_servers')
    for o in remove: bm.pop(o, None)
    for l in lanes: amm.pop(l, None)
    ok_rest = (b2 == a2) and (bm == amm)
    print(f'{prof:8} caller={caller:8} lanes={list(lanes)} | new ok={ok_new} old removed={ok_old} rest unchanged={ok_rest} | backup {bdir}')
    if not (ok_new and ok_old and ok_rest):
        shutil.copy2(f'{bdir}/config.yaml', path)
        sys.exit(f'ABORT {prof}: verification failed; config restored from backup')
print('cutover configs complete')
