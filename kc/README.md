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
- **Shared token cache.** One Firebase ID token per login, shared by every lane on that login. One refresh at a time
  (PID lock file), waiters reuse the result, Google 429 retried after 5/10/20 s. A token GHL rejects (401) is cleared
  for every lane. Malformed tokens are never cached.
- **Per-call deadline.** Hermes allows 120 s per tool call. Each call gets 100 s for auth plus all its requests.
  A write (POST/PUT/PATCH/DELETE) is not sent unless 27 s remain, so nothing lands after the caller gives up.
  Caller cancellation aborts in-flight requests and blocks later writes.
- **No ambient credentials.** In a lane the server skips `.env` loading and the legacy workflow-builder env file.

Known limits (accepted): `--caller` is attribution, not authentication (all agents run as one OS user).
Firebase refresh tokens are not rotated by Google in practice; if one is, the server logs a warning and keeps
the vault value. A rare three-way race around an abandoned lock can cause one extra token refresh, never a wrong
account or corrupt cache.

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
