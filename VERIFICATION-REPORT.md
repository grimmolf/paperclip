# Verification Report

**Date**: 2026-03-12
**Verifier**: quality-engineer (independent verification)
**Scope**: Build fixes, security audit top findings, code quality audit top findings

---

## Build Verification

### pnpm install --frozen-lockfile: PASS
Output: `Lockfile is up to date, resolution step is skipped. Already up to date. Done in 812ms`

### Server build: PASS
`pnpm --filter @paperclipai/server build` completed successfully (runs `tsc`).

### UI build: PASS
`pnpm --filter @paperclipai/ui build` completed successfully (vite build, `built in 6.51s`).

### Dockerfile fix: CORRECT
Line 22 of the Dockerfile contains:
```dockerfile
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
```
This is correctly placed after the other adapter COPY lines (claude-local, codex-local, cursor-local, openclaw-gateway, opencode-local, pi-local) and before the `RUN pnpm install --frozen-lockfile` step. The placement follows the existing pattern exactly.

---

## Security Finding Verification

### Finding 1: Shell Command Injection via Workspace Provision Command
**Reported Severity**: CRITICAL
**Reported Location**: `server/src/services/workspace-runtime.ts:270-302`
**Status**: CONFIRMED

**Evidence**: Independently verified at `workspace-runtime.ts:276-278`:
```typescript
const shell = process.env.SHELL?.trim() || "/bin/sh";
const child = spawn(shell, ["-c", input.command], {
  cwd: input.cwd,
  env: input.env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

The `input.command` originates from `provisionCommand` at line 314:
```typescript
const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
```

Which flows from `shared/src/validators/project.ts:10`:
```typescript
provisionCommand: z.string().optional().nullable(), // No sanitization beyond z.string()
```

**Mitigating controls NOT mentioned in report**: None found. The `provisionCommand` is a plain string accepted from project configuration with no shell metacharacter filtering, no allowlist, and no sandboxing. Any user who can update a project's execution workspace policy can inject arbitrary shell commands.

**Verdict**: The vulnerability exists exactly as described. This is a genuine CRITICAL RCE vector.

---

### Finding 2: Shell Command Injection via Runtime Service Commands
**Reported Severity**: CRITICAL
**Reported Location**: `server/src/services/workspace-runtime.ts:696-702`
**Status**: CONFIRMED

**Evidence**: Independently verified at `workspace-runtime.ts:696-702`:
```typescript
const shell = process.env.SHELL?.trim() || "/bin/sh";
const child = spawn(shell, ["-lc", command], {
  cwd: serviceCwd,
  env,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

The `command` flows from `asString(input.service.command, "")` at line ~672, which comes from the `workspaceRuntime` project configuration validated as `z.record(z.unknown())` at `shared/src/validators/project.ts:21` — accepting any arbitrary value.

**Mitigating controls NOT mentioned in report**: None found. The `-lc` flag means the shell reads the command string directly. The `z.record(z.unknown())` schema provides zero validation on the command content.

**Verdict**: The vulnerability exists exactly as described. This is a genuine CRITICAL RCE vector, essentially the same pattern as Finding 1 but through a different configuration path.

---

### Finding 3: Arbitrary Command Execution via Adapter Config
**Reported Severity**: HIGH
**Reported Location**: All adapter `execute.ts` files
**Status**: CONFIRMED

**Evidence**: Independently verified across all 6 adapters:
- `claude-local/src/server/execute.ts:114`: `const command = asString(config.command, "claude");`
- `codex-local/src/server/execute.ts:114`: `const command = asString(config.command, "codex");`
- `cursor-local/src/server/execute.ts:158`: `const command = asString(config.command, "agent");`
- `gemini-local/src/server/execute.ts:133`: `const command = asString(config.command, "gemini");`
- `opencode-local/src/server/execute.ts:92`: `const command = asString(config.command, "opencode");`
- `pi-local/src/server/execute.ts:108`: `const command = asString(config.command, "pi");`

The `adapterConfig` is validated via `z.record(z.unknown())` at `shared/src/validators/agent.ts:14`, allowing any key-value pairs.

The command is then passed to `runChildProcess` in `adapter-utils/src/server-utils.ts:295`:
```typescript
const child = spawn(target.command, target.args, {
  cwd: opts.cwd,
  env: mergedEnv,
  shell: false,  // Good: prevents shell metacharacter injection through args
  stdio: [...]
});
```

**Mitigating controls NOT mentioned in report**: The `shell: false` in `spawn()` is correctly noted as a mitigating factor — it prevents shell metacharacter injection through arguments. However, the `command` field itself can point to any binary on the system. Additionally, `resolveSpawnTarget` at line 293 resolves the command path before spawning, which could allow pointing to arbitrary executables.

**Verdict**: The vulnerability exists as described. The `shell: false` mitigates shell injection through arguments but does NOT prevent executing arbitrary binaries via the `command` field. The severity of HIGH is appropriate — it requires the attacker to have agent-creation permissions and a writable binary path, making it less immediately exploitable than the CRITICAL findings, but still a real risk.

---

## Code Quality Finding Verification

### Finding 1: TOCTOU Race in `ensureRuntimeServicesForRun()`
**Reported Severity**: HIGH
**Reported Location**: `server/src/services/workspace-runtime.ts:853-865`
**Status**: CONFIRMED

**Evidence**: Independently verified at lines 853-868:
```typescript
if (reuseKey) {
  const existingId = runtimeServicesByReuseKey.get(reuseKey);          // CHECK
  const existing = existingId ? runtimeServicesById.get(existingId) : null;
  if (existing && existing.status === "running") {
    // ... reuse existing service
    continue;
  }
}

const record = await startLocalRuntimeService({  // USE (async gap!)
  ...
});
```

The `runtimeServicesByReuseKey` and `runtimeServicesById` Maps are module-level (lines 80-82):
```typescript
const runtimeServicesById = new Map<string, RuntimeServiceRecord>();
const runtimeServicesByReuseKey = new Map<string, string>();
const runtimeServiceLeasesByRun = new Map<string, string[]>();
```

The check-then-act pattern has an async gap: `startLocalRuntimeService` is `async`, meaning the event loop can interleave between the check at line 854 and the Map update inside `startLocalRuntimeService`. Two concurrent calls with the same `reuseKey` could both see `existing` as `null` and both proceed to start a new service.

**Mitigating controls NOT mentioned in report**: The `heartbeat.ts` module has a `withAgentStartLock` (line 91) that serializes heartbeat starts per agent. This reduces but does NOT eliminate the race — if `maxConcurrentRuns > 1`, multiple runs for the same agent could still reach `ensureRuntimeServicesForRun` concurrently.

**Verdict**: The race condition exists as described. The `withAgentStartLock` in heartbeat provides partial mitigation for single-run agents, but the gap is real for concurrent runs.

---

### Finding 2: Child Processes Not Cleaned Up on SIGTERM/SIGINT
**Reported Severity**: HIGH
**Reported Location**: `server/src/index.ts:650-659`, `server/src/services/workspace-runtime.ts:80-82`
**Status**: CONFIRMED

**Evidence**: Independently verified the shutdown handler at `index.ts:650-667`:
```typescript
const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
  logger.info({ signal }, "Stopping embedded PostgreSQL");
  try {
    await embeddedPostgres?.stop();
  } catch (err) {
    logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
  } finally {
    process.exit(0);
  }
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
```

The shutdown handler ONLY stops embedded PostgreSQL and then calls `process.exit(0)`. There is NO cleanup of:
- `runtimeServicesById` (Map of running child processes at `workspace-runtime.ts:80`)
- `runtimeServicesByReuseKey` (at line 81)
- `runtimeServiceLeasesByRun` (at line 82)

Child processes are spawned with `detached: false` (line 700), meaning they share the parent's process group. When `process.exit(0)` is called, Node.js drains the event loop and exits. Depending on timing:
- If the parent exits cleanly, child processes may receive SIGHUP (standard Unix behavior for process group members), but this is not guaranteed across all platforms
- On Linux with `detached: false`, the child inherits the parent's session/group, so `SIGHUP` is typically sent
- However, explicit cleanup is the correct approach for reliable behavior

**Mitigating controls NOT mentioned in report**: The `detached: false` flag provides *some* implicit cleanup on most Unix systems, but this is platform-dependent and not guaranteed. Also, the shutdown handler is only registered when `embeddedPostgres && embeddedPostgresStartedByThisProcess` is true (line 649) — meaning in non-embedded-postgres deployments, there is NO shutdown handler at all, and the process would simply terminate on SIGTERM without any cleanup.

**Verdict**: The finding is confirmed. The shutdown handler does not terminate child processes. The implicit OS-level cleanup via `detached: false` provides partial mitigation but is not reliable across all deployment scenarios.

---

## Overall Assessment

### Build Verification: ALL PASS
All four checks passed. The Dockerfile fix is correctly placed and both `pnpm install` and package builds succeed.

### Security Findings: 3/3 CONFIRMED
All three top security findings were independently verified in the source code. The two CRITICAL shell command injection vulnerabilities and the HIGH arbitrary command execution vulnerability exist exactly as described in the security audit. No significant mitigating controls were found that would reduce the severity.

### Code Quality Findings: 2/2 CONFIRMED
Both top code quality findings were independently verified. The TOCTOU race condition in shared service reuse and the missing child process cleanup on shutdown exist as described. The code quality audit identified a partial mitigating control for the TOCTOU race (`withAgentStartLock`) that was not mentioned in the report, but the race is still possible under concurrent runs.

### Summary Table

| Check | Result |
|-------|--------|
| pnpm install --frozen-lockfile | PASS |
| Server build | PASS |
| UI build | PASS |
| Dockerfile fix | CORRECT |
| CRITICAL: Shell injection via provisionCommand | CONFIRMED |
| CRITICAL: Shell injection via runtime services | CONFIRMED |
| HIGH: Arbitrary command via adapterConfig | CONFIRMED |
| HIGH: TOCTOU race in service reuse | CONFIRMED |
| HIGH: Child process cleanup on shutdown | CONFIRMED |

**Conclusion**: The build fixes are correct and working. The security and code quality audits produced accurate findings that were independently verified against the actual source code. The most urgent items requiring remediation are the two CRITICAL shell command injection vulnerabilities in `workspace-runtime.ts`.
