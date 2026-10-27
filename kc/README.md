# KC lanes for the BusyBee GHL MCP server

KC Power Clean's fork of [BusyBee3333/Go-High-Level-MCP-2026-Complete](https://github.com/BusyBee3333/Go-High-Level-MCP-2026-Complete).
Branch `kc/main` = upstream `main` + KC fixes + KC lanes. Releases are tagged `kc-vX.Y.Z`.

## What a lane is

One MCP server process for one GHL account and one calling agent, started by `kc/bin/kc-ghl`:

```bash
kc-ghl --lane <lane> --caller <agent>          # start the MCP server (Hermes stdio)
kc-ghl --lane <lane> --caller <agent> --check  # validate lane, caller and secrets; start nothing
kc-ghl --list                                  # lanes, accounts, allowed callers
```

The launcher reads the lane registry, loads only that lane's secrets from the KC vault
(`kc-secret get <name>`), starts the server with a minimal environment, and sets:

| Variable | Purpose |
|---|---|
| `KC_GHL_LANE`, `KC_GHL_CALLER` | Lane mode on; audit attribution |
| `KC_GHL_PINNED_LOCATION` | Account pin. Omitted for the agency lane (`"pinned": false`) |
| `KC_GHL_TOKEN_CACHE_DIR`, `KC_GHL_CREDENTIAL` | Shared Firebase ID-token cache, keyed by login name |
| `KC_GHL_AUDIT_LOG` | One JSONL line per tool call: time, caller, lane, tool, ok, ms |

Outside a lane (no `KC_GHL_LANE`) the server behaves exactly like upstream.

## Configuration: nothing secret in Git

- **Lane registry** (`lanes.json`): account IDs, user IDs, vault key names, allowed callers. Lives on the host at
  `~/.local/share/kc-ghl/lanes.json` (override with `KC_GHL_REGISTRY`). Git-ignored. Format: `kc/lanes.example.json`.
- **Secrets**: only in the KC vault. The registry names vault keys; it never holds values.
- Back up `lanes.json` to `~/.local/share/kc-ghl/backups/` before every edit.

## What the KC code does (`src/kc/lane.ts` + small hooks)

- **Account pin.** In a pinned lane every workflow request (`backend.leadconnectorhq.com/workflow/<location>/...`)
  and every public API request must target the pinned location. Checked on the final URL after normalization,
  query merging, and the JSON body. Workflow and location IDs must be plain identifiers (no `..`, `/`, `%`, `\`).
  The workflow tools accept an optional `locationId`; pinned lanes only allow their own, the agency lane any.
- **Shared token cache.** One Firebase ID token per login, shared by every lane on that login. One refresh at a time:
  the lock is a Linux abstract Unix socket (`\0kc-ghl-refresh-<id>`) that the lanes and the keeper bind; the kernel
  frees it the moment the holder exits or crashes. Waiters reuse the result; Google 429 retried after 5/10/20 s.
  A token GHL rejects (401) is refreshed once under the lock; a newer token another lane published is never
  overwritten. Malformed tokens are never cached.
- **Per-call deadline.** Hermes allows 120 s per tool call. Each call gets 100 s for auth plus all its requests.
  A write (POST/PUT/PATCH/DELETE) is not sent unless 27 s remain, so nothing lands after the caller gives up.
  Caller cancellation aborts in-flight requests and blocks later writes.
- **No ambient credentials.** In a lane the server skips `.env` loading and the legacy workflow-builder env file.

## Agency lane: one private integration per sub-account

A GHL **agency** private integration only offers agency-level scopes (sub-accounts, users, snapshots,
SaaS, phone numbers, and similar). It cannot read contacts, conversations, opportunities, or other
sub-account data, and it cannot mint sub-account tokens. Each sub-account therefore has its own
**sub-account** private integration, and the unpinned agency lane picks the right one per request:

| Request | Token sent |
|---|---|
| Agency endpoint: catalog `Agency-Access`-only, `KC_DEFAULT_AGENCY_PATHS`, or `KC_GHL_AGENCY_PATHS` | agency token (`GHL_API_KEY`) |
| Names one sub-account (path, query, or body) | that sub-account's token |
| Names no sub-account (for example, contact by ID) | the lane's default sub-account (`location_id`) token |
| Names two sub-accounts, or one with no registered token | refused before sending |

Everything is data in the lane registry; adding a sub-account needs no code change:

```json
"ghl_agency_admin": {
  "pinned": false,
  "location_tokens": { "<locationId>": "<VAULT_KEY>" },
  "env": { "GHL_USER_TYPE": "", "KC_GHL_AGENCY_PATHS": "/extra-agency-prefix" }
}
```

To add a sub-account:

1. In GHL, switch into the sub-account → **Settings → Private Integrations → Create new integration**.
   Name it `Hermes agency lane (read-only)` and select only the read scopes (`*.readonly`, `*.read`).
2. Store the token in the vault: `kc-secret set <VAULT_KEY>` (never paste it in chat).
3. Register it: `kc-ghl --add-subaccount <locationId> --vault-key <VAULT_KEY>`. This verifies the token
   reads that sub-account and nothing else, backs up `lanes.json`, and adds the entry.
4. Restart the lane (`/reload-mcp` in open sessions).

## Token keeper (`kc/bin/kc-ghl-token-keeper`)

The single writer for Firebase logins. A systemd user timer (`kc/systemd/`) runs it every 10 minutes.

- Keeps at least 25 minutes of ID-token life in the shared cache, so lanes almost never refresh themselves.
- Owns refresh-token rotation. Tries the newest token first (a lane's hand-off file, then the vault, then
  `<KEY>_PREV`). If Firebase returns a new refresh token, it saves it to the 0600 hand-off file first, backs up
  the old vault value to `<KEY>_PREV`, stores the new value, reads it back, then clears the hand-off file.
- Lanes never write the vault. If a lane's own refresh returns a new token, the lane leaves it in the hand-off file.
- `kc-secret set/unset` take an exclusive lock, so concurrent vault writes never lose an update.
- Alerts Scout's Slack channel `KC_GHL_ALERT_CHANNEL` once when a login dies (all tokens rejected: log in again
  and store a new refresh token) or fails 3 runs in a row, and once on recovery.
- Logs show 8-character SHA-256 prefixes only, never token values.

```bash
kc-ghl-token-keeper --status                      # health per login
systemctl --user list-timers kc-ghl-token-keeper.timer
journalctl --user -u kc-ghl-token-keeper -n 20    # recent runs
```

Known limits (accepted): `--caller` is attribution, not authentication (all agents run as one OS user).
## Test

```bash
npm test          # upstream suite
npm run test:kc   # KC lane suites (offline, placeholder IDs)
```

## Release and deploy

```bash
git tag kc-vX.Y.Z && git push origin kc/main kc-vX.Y.Z
# on the host
R=~/.local/share/kc-ghl/releases/kc-vX.Y.Z
git -C <checkout> worktree add --detach "$R" kc-vX.Y.Z   # or git archive
cp -al <checkout>/node_modules "$R/node_modules" && (cd "$R" && node scripts/build-server.mjs)
ln -sfn "$R" ~/.local/share/kc-ghl/current.new && mv -T ~/.local/share/kc-ghl/current.new ~/.local/share/kc-ghl/current
```

Rollback: point `current` at the previous release. Running servers keep their loaded code until restarted;
open Hermes sessions pick up the new release after `/reload-mcp`.

## Updating from upstream

```bash
git fetch upstream && git checkout kc/main && git merge upstream/main
npm test && npm run test:kc
```

KC changes are concentrated in `src/kc/lane.ts`; upstream files carry only small hooks
(`tool-registry.ts`, `server.ts`, `clients/ghl-api-client.ts`, `clients/workflow-builder-client.ts`,
`tools/workflow-builder-tools.ts`), so merges should stay small.
