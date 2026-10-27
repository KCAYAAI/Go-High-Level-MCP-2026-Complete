"""Apply KC lane patches to the neutral BusyBee copy. Exact-match replacements; aborts if any anchor is missing or ambiguous."""
import pathlib, sys

ROOT = pathlib.Path('/home/aya/.local/share/kc-ghl/busybee/src')

def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'ABORT {label}: anchor found {n} times')
    return text.replace(old, new)

# ── workflow-builder-client.ts ──────────────────────────────
p = ROOT / 'clients/workflow-builder-client.ts'
t = p.read_text()
t = sub(t, "import { randomUUID } from 'crypto';\nimport { readFileSync, writeFileSync, existsSync } from 'fs';\nimport { resolve } from 'path';\n",
"import { randomUUID, createHash } from 'crypto';\nimport { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync, mkdirSync } from 'fs';\nimport { resolve, join } from 'path';\n\nconst kcSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));\n", 'imports')

t = sub(t, "  constructor(config: WorkflowBuilderConfig) {\n    this.config = config;\n  }\n",
"""  constructor(config: WorkflowBuilderConfig) {
    this.config = config;
    // KC lane guard: the client must use the lane's pinned account.
    const pinned = process.env.KC_GHL_PINNED_LOCATION;
    if (pinned && pinned !== config.locationId) {
      throw new Error("KC lane guard: workflow client account does not match this lane's pinned account");
    }
  }
""", 'constructor')

t = sub(t, "    if (!this.cachedIdToken || Date.now() >= this.tokenExpiry) {\n      await this.refreshFirebaseToken();\n    }\n",
"    if (!this.cachedIdToken || Date.now() >= this.tokenExpiry) {\n      await this.refreshFirebaseTokenShared();\n    }\n", 'getHeaders')

t = sub(t, "  /**\n   * Write a token back to the .env file (preserves other lines).\n   */\n",
"""  /**
   * KC shared token cache: one cached Firebase ID token per credential, shared by
   * every lane process using that credential. One refresh at a time (lock file),
   * other processes wait and reuse the result. Retries Google quota (429) with backoff.
   */
  private async refreshFirebaseTokenShared(): Promise<void> {
    const dir = process.env.KC_GHL_TOKEN_CACHE_DIR;
    if (!dir) {
      await this.refreshFirebaseTokenWithBackoff();
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = createHash('sha256')
      .update(`${this.config.firebaseApiKey}:${this.config.firebaseRefreshToken}`)
      .digest('hex')
      .slice(0, 24);
    const cacheFile = join(dir, `${id}.json`);
    const lockFile = join(dir, `${id}.lock`);
    const margin = 120_000;
    const useCache = (): boolean => {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as { idToken?: string; expiresAt?: number };
        if (c.idToken && c.expiresAt && c.expiresAt - Date.now() > margin) {
          this.cachedIdToken = c.idToken;
          this.tokenExpiry = c.expiresAt - margin;
          return true;
        }
      } catch {
        // no usable cache yet
      }
      return false;
    };
    if (useCache()) return;

    const deadline = Date.now() + 90_000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lockFile, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > 120_000) {
            unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error('KC token cache: timed out waiting for another lane to refresh');
        await kcSleep(500);
        if (useCache()) return;
      }
    }
    try {
      if (useCache()) return;
      await this.refreshFirebaseTokenWithBackoff();
      const expiresAt = this.idTokenExpiry();
      this.tokenExpiry = expiresAt - margin;
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ idToken: this.cachedIdToken, expiresAt }), { mode: 0o600 });
      renameSync(tmp, cacheFile);
      process.stderr.write('[KC GHL] Firebase token refreshed and shared\\n');
    } finally {
      closeSync(fd);
      try { unlinkSync(lockFile); } catch { /* already gone */ }
    }
  }

  private async refreshFirebaseTokenWithBackoff(): Promise<void> {
    const waits = [5_000, 15_000, 30_000];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.refreshFirebaseToken();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('(429)') || attempt >= waits.length) throw err;
        process.stderr.write(`[KC GHL] Firebase token quota hit; retrying in ${waits[attempt] / 1000}s\\n`);
        await kcSleep(waits[attempt]);
      }
    }
  }

  private idTokenExpiry(): number {
    try {
      const part = (this.cachedIdToken || '').split('.')[1];
      const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: number };
      if (claims.exp) return claims.exp * 1000;
    } catch {
      // fall through
    }
    return Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS;
  }

  /**
   * Write a token back to the .env file (preserves other lines).
   */
""", 'shared-cache')

t = sub(t, "  ): Promise<{ status: number; data: T }> {\n    const headers = await this.getHeaders();\n",
"""  ): Promise<{ status: number; data: T }> {
    // KC lane guard: every workflow request must target this lane's pinned account.
    const pinned = process.env.KC_GHL_PINNED_LOCATION;
    if (pinned && path.split(/[/?]/)[1] !== pinned) {
      throw new Error("KC lane guard: blocked a workflow request outside this lane's account");
    }
    const headers = await this.getHeaders();
""", 'request-guard')
p.write_text(t)

# ── server.ts audit log ─────────────────────────────────────
p = ROOT / 'server.ts'
t = p.read_text()
first_import_end = t.index('\n', t.index('import '))
t = t[:first_import_end + 1] + """import { appendFileSync as kcAppend, mkdirSync as kcMkdir } from 'fs';
import { dirname as kcDirname } from 'path';

// KC audit log: one line per tool call. Records who called which lane, never arguments or results.
function kcAudit(tool: string, ok: boolean, ms: number): void {
  const file = process.env.KC_GHL_AUDIT_LOG;
  if (!file) return;
  try {
    kcMkdir(kcDirname(file), { recursive: true, mode: 0o700 });
    kcAppend(file, JSON.stringify({
      ts: new Date().toISOString(),
      caller: process.env.KC_GHL_CALLER || 'unknown',
      lane: process.env.KC_GHL_LANE || 'unknown',
      tool,
      ok,
      ms,
    }) + '\\n', { mode: 0o600 });
  } catch {
    // auditing must never break a tool call
  }
}
""" + t[first_import_end + 1:]
t = sub(t, "      process.stderr.write(`[GHL MCP] Executing tool: ${name}\\n`);\n\n      try {\n",
"      process.stderr.write(`[GHL MCP] Executing tool: ${name}\\n`);\n      const kcStarted = Date.now();\n      let kcOk = false;\n\n      try {\n", 'audit-start')
t = sub(t, "        return {\n          content: [{\n            type: 'text',\n            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)\n          }]\n        };\n",
"        kcOk = true;\n        return {\n          content: [{\n            type: 'text',\n            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)\n          }]\n        };\n", 'audit-ok')
t = sub(t, "        throw new McpError(code, `Tool execution failed: ${message}`);\n      }\n    });\n",
"        throw new McpError(code, `Tool execution failed: ${message}`);\n      } finally {\n        kcAudit(name, kcOk, Date.now() - kcStarted);\n      }\n    });\n", 'audit-finally')
p.write_text(t)
print('patches applied')
