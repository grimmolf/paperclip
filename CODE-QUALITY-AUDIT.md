# Code Quality Audit — Paperclip Monorepo

**Date**: 2026-03-12
**Scope**: server/, ui/, packages/, tests/
**Reviewer**: code-reviewer agent (Tasks #9 and #10)

---

## 1. Architecture

### [INFO] Overall structure is well-organized
**Severity**: INFO
**Location**: /
**Description**: The monorepo follows a clean separation: `server/` (Express 5 API), `ui/` (frontend), `cli/`, and `packages/` (db, shared, adapter-utils, adapters/*). The server follows a routes → services → data-access pattern consistently.
**Impact**: Positive — easy to navigate and maintain.
**Recommendation**: No change needed.

---

### [MEDIUM] Large files exceed 800-line threshold
**Severity**: MEDIUM
**Location**: server/src/services/heartbeat.ts, server/src/routes/access.ts, server/src/services/workspace-runtime.ts
**Description**: Several files are very large:
- `heartbeat.ts`: >1,000 lines (single orchestration function with many concerns)
- `access.ts`: >2,600 lines (massive route file handling invitations, board claims, member permissions, onboarding, etc.)
- `workspace-runtime.ts`: >1,077 lines

**Impact**: Increases cognitive load. Changes become harder to reason about; merge conflicts more likely.
**Recommendation**: Extract `access.ts` into sub-routers by domain (e.g., `invites.ts`, `board-access.ts`, `member-management.ts`). Extract helpers from `heartbeat.ts` into focused service modules.

---

### [LOW] `validate.ts` middleware relies on Express 5 implicit error forwarding
**Severity**: LOW
**Location**: server/src/middleware/validate.ts:6
**Description**: The `validate()` middleware calls `schema.parse(req.body)` synchronously without a try/catch or `next(err)`. This works in Express 5 (which auto-catches synchronous throws in middleware and forwards them to the error handler), but would silently break if ported to Express 4 or composed into a non-Express context.
**Impact**: Low — Express 5 handles it correctly. However, the code doesn't communicate this dependency.
**Recommendation**: Add a comment: `// Express 5 automatically forwards synchronous throws to next(err)` or use explicit try/catch for clarity:
```ts
try {
  req.body = schema.parse(req.body);
  next();
} catch (err) {
  next(err);
}
```

---

## 2. Error Handling

### [MEDIUM] Error context passed between middleware via `as any` property injection
**Severity**: MEDIUM
**Location**: server/src/middleware/error-handler.ts:20,29 — server/src/middleware/logger.ts
**Description**: The `errorHandler` sets `(res as any).__errorContext` and `(res as any).err` on the Response object to pass structured error data to the `logger.ts` response-finish handler. This is not type-safe — there is no augmented `Response` type.
**Impact**: If the property name changes in one location but not the other, errors will silently go unlogged. TypeScript cannot catch this mismatch.
**Recommendation**: Declare a module augmentation for Express `Response`:
```ts
// in a .d.ts file or inline
declare global {
  namespace Express {
    interface Response {
      __errorContext?: ErrorContext;
      err?: Error;
    }
  }
}
```
Or use a `WeakMap<Response, ErrorContext>` for correlation instead of property injection.

---

### [MEDIUM] `errorHandler` does not log errors directly — depends on logger middleware ordering
**Severity**: MEDIUM
**Location**: server/src/middleware/error-handler.ts
**Description**: The `errorHandler` only attaches context to the response; the actual log emission happens in the `logger.ts` `res.on("finish")` hook. If the logger middleware is not registered before routes, or if a response path skips the finish event, 5xx errors could go unlogged.
**Impact**: Silent 500 errors in unexpected configurations.
**Recommendation**: Consider logging directly in `errorHandler` for 5xx errors as a belt-and-suspenders approach, especially for unhandled errors.

---

### [INFO] ZodError responses leak internal schema field names
**Severity**: INFO
**Location**: server/src/middleware/error-handler.ts:56
**Description**: `res.status(400).json({ error: "Validation error", details: err.errors })` sends full Zod error details including field paths and constraint descriptions to the client.
**Impact**: Minor information disclosure — field names and validation rules are visible to API consumers. This is usually acceptable for API clients but worth being intentional about.
**Recommendation**: Acceptable as-is for an API product. Document the intent if intentional.

---

## 3. Type Safety

### [MEDIUM] `dbOrTx: any` in core service functions
**Severity**: MEDIUM
**Location**: server/src/services/issues.ts:223,244,260,346,361 — server/src/services/projects.ts:295
**Description**: Several internal service functions accept `dbOrTx: any` to support being called both outside and inside Drizzle transactions. The proper type for a transaction-aware function is the intersection of `Db` and the transaction callback argument type.
**Impact**: TypeScript cannot detect incorrect arguments (e.g., passing a plain object). Future refactors may break silently.
**Recommendation**: Use a proper union/intersection type:
```ts
type DbOrTx = Db | Parameters<Db['transaction']>[0];
```
Or expose `DbOrTx` as a named export from `@paperclipai/db`.

---

### [MEDIUM] `any` used to bypass typing on core server startup functions
**Severity**: MEDIUM
**Location**: server/src/index.ts (lines with `db as any`, `ensureLocalTrustedBoardPrincipal(db: any)`)
**Description**: The `ensureLocalTrustedBoardPrincipal` function accepts `db: any` and the call site passes `db as any`. The root cause is the startup sequence where the DB instance is not yet properly typed.
**Impact**: Masks potential type mismatches at server startup.
**Recommendation**: Type `ensureLocalTrustedBoardPrincipal` with the actual `Db` type from `@paperclipai/db`.

---

### [INFO] `as any` used legitimately in test files
**Severity**: INFO
**Location**: server/src/__tests__/*.ts (many files)
**Description**: Test files use `as any` extensively to create partial mock objects. This is common and acceptable in tests but should not be exported or used in production code paths.
**Impact**: Low — test-only. However, it can mask type errors in test assertions.
**Recommendation**: Consider using `satisfies` or partial type utilities from vitest for better mock typing.

---

### [INFO] `strict: true` is enabled globally — good baseline
**Severity**: INFO
**Location**: tsconfig.base.json:8
**Description**: `"strict": true` is set in the base tsconfig, providing noImplicitAny, strictNullChecks, and other strictness flags across the entire monorepo.
**Impact**: Positive — reduces entire classes of bugs.
**Recommendation**: No change needed. The existing `any` usages are targeted violations rather than systematic gaps.

---

## 4. Test Coverage

### [MEDIUM] No tests for live-events.ts subscription/publish cycle
**Severity**: MEDIUM
**Location**: server/src/services/live-events.ts
**Description**: The `live-events.ts` module (EventEmitter-based pub/sub backbone for WebSocket events) has no dedicated unit tests. This module's `setMaxListeners(0)` call and the subscription lifecycle (subscribe → publish → unsubscribe) are not covered.
**Impact**: Regressions in event fan-out, memory leaks from forgotten unsubscriptions, or silent no-ops on companyId mismatches would not be caught.
**Recommendation**: Add unit tests for `publishLiveEvent` and `subscribeCompanyLiveEvents`, including the unsubscribe cleanup function.

---

### [MEDIUM] No E2E tests beyond single onboarding flow
**Severity**: MEDIUM
**Location**: tests/e2e/onboarding.spec.ts
**Description**: Only one E2E test exists (`onboarding.spec.ts`). Critical flows like agent heartbeat execution, workspace creation, invite acceptance, and approval flows are covered only by unit/integration tests.
**Impact**: Integration regressions between the UI and server may not be caught until production.
**Recommendation**: Add E2E tests for: agent wakeup → heartbeat run → result visible in UI, invite flow, and approval workflow.

---

### [INFO] Good unit test coverage for critical paths
**Severity**: INFO
**Location**: server/src/__tests__/ (45 test files)
**Description**: Comprehensive unit/integration tests exist for: error handler, heartbeat run summaries, workspace sessions, board mutation guard, agent auth JWT, adapter environments, company path guards, approval routes, activity routes, hire hook, private hostname guard, and more.
**Impact**: Positive.
**Recommendation**: Continue this pattern.

---

### [LOW] No vitest coverage thresholds configured
**Severity**: LOW
**Location**: vitest.config.ts
**Description**: The root vitest config does not configure `coverage.thresholds`. Coverage is not enforced in CI (if any).
**Impact**: Coverage can silently decline over time without alerting.
**Recommendation**: Add:
```ts
coverage: {
  thresholds: { lines: 70, functions: 70 }
}
```

---

## 5. Resource Management

### 🚨 CRITICAL: Child processes not terminated on SIGTERM/SIGINT
**Severity**: HIGH
**Location**: server/src/index.ts:650-659 — server/src/services/workspace-runtime.ts:80-82
**Description**: The `shutdown` handler on SIGTERM/SIGINT only stops embedded PostgreSQL. The module-level Maps in `workspace-runtime.ts` (`runtimeServicesById`, `runtimeServicesByReuseKey`, `runtimeServiceLeasesByRun`) hold references to running child processes (`ChildProcess`). On graceful shutdown, these child processes are not terminated.

Child processes are spawned with `detached: false`, which means they will be killed when the Node.js parent exits abnormally. However, on a graceful shutdown (`process.exit(0)` after Postgres stops), the child processes may still be running briefly as the event loop drains.
**Impact**: Runtime services (dev servers, build watchers spawned by workspace-runtime) may become orphaned or leave ports occupied, causing failures on restart.
**Recommendation**: In the `shutdown` handler, call `releaseRuntimeServicesForRun` for all active leases, or iterate `runtimeServicesById` and call `stopRuntimeService()` for all running services before exiting.

---

### [MEDIUM] `startLocksByAgent` Map in heartbeat.ts grows without bound
**Severity**: MEDIUM
**Location**: server/src/services/heartbeat.ts:47, `withAgentStartLock`
**Description**: The `startLocksByAgent` Map stores a Promise per agentId as a mutex. The cleanup at line ~102 removes the entry only when the stored marker equals the current value — this is correct but only happens if no new request comes in for that agent. For active agents, the Map entry persists indefinitely.
**Impact**: Minor memory growth for long-lived servers with many unique agents. Not a leak per se (entries are reused), but the Map never shrinks for terminated agents.
**Recommendation**: Low priority. Consider adding a TTL-based cleanup or `WeakRef` pattern if memory usage becomes a concern.

---

### [INFO] DB utility connections are properly cleaned up
**Severity**: INFO
**Location**: packages/db/src/client.ts — all `createUtilitySql` callers
**Description**: Every function that calls `createUtilitySql(url)` wraps the usage in try/finally with `await sql.end()`. Connection resources are reliably released.
**Impact**: Positive.
**Recommendation**: No change needed.

---

### [INFO] WebSocket ping interval properly tied to server lifecycle
**Severity**: INFO
**Location**: server/src/realtime/live-events-ws.ts:190-233
**Description**: The `setInterval` for WebSocket pings is cleared in `wss.on("close")`. Client cleanup (event unsubscription, Map cleanup) happens in `socket.on("close")`. The pattern is correct.
**Impact**: Positive.
**Recommendation**: No change needed.

---

### [INFO] run-log-store.ts stream handling is correct
**Severity**: INFO
**Location**: server/src/services/run-log-store.ts:71-78
**Description**: `createReadStream` is consumed via event listeners (`data`, `error`, `end`) wrapped in a Promise. The stream will be garbage collected when the Promise resolves/rejects and references drop. No explicit `stream.destroy()` is needed here.
**Impact**: Positive.
**Recommendation**: No change needed.

---

## 6. Dead Code / Unused Dependencies

### [INFO] No unused production dependencies found
**Severity**: INFO
**Location**: server/package.json
**Description**: All listed production dependencies appear to be imported and used:
- `detect-port`: used in `server/src/index.ts:23`
- `embedded-postgres`: used for embedded PG mode
- `aws-sdk/client-s3`: used for S3 log storage
- `multer`: used in assets route
- `open`: used to open browser on startup
**Impact**: No dead dependencies.
**Recommendation**: No change needed.

---

### [LOW] `pino-pretty` listed as production dependency (should be devDependency)
**Severity**: LOW
**Location**: server/package.json
**Description**: `pino-pretty` is a human-readable log formatter primarily useful in development. It is listed as a production dependency, adding ~200KB to the production bundle unnecessarily. In production, structured JSON logs are preferred.
**Impact**: Marginally larger Docker image.
**Recommendation**: Move `pino-pretty` to `devDependencies` and use conditional loading (already common with pino's `transport` config):
```ts
transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
```

---

## 7. Race Conditions

### ⚠️ HIGH: TOCTOU race in `ensureRuntimeServicesForRun` shared service reuse
**Severity**: HIGH
**Location**: server/src/services/workspace-runtime.ts:853-865
**Description**: The shared service reuse check is not atomic:
```ts
const existingId = runtimeServicesByReuseKey.get(reuseKey);  // check
const existing = existingId ? runtimeServicesById.get(existingId) : null;
if (existing && existing.status === "running") {
  // reuse
}
// else: start new service  <-- TOCTOU gap here
```
If two concurrent heartbeat runs for the same agent and workspace both reach this check simultaneously (before either has started the service), both will pass the `if (existing ...)` check as false and both will call `startLocalRuntimeService`. Two instances of the same service will be started, one of which will be orphaned.
**Impact**: Duplicate service instances, port conflicts, resource waste. Likely only triggers under concurrent agent runs (possible with `maxConcurrentRuns > 1`).
**Recommendation**: Guard service creation with a per-reuseKey lock (similar to `withAgentStartLock`). Or register a "starting" placeholder in `runtimeServicesByReuseKey` before the async `startLocalRuntimeService` call.

---

### [LOW] `nextEventId` counter in live-events.ts has no overflow protection
**Severity**: LOW
**Location**: server/src/services/live-events.ts:10,17
**Description**: `let nextEventId = 0` increments on every event. JavaScript's `Number` type loses integer precision above `Number.MAX_SAFE_INTEGER` (~9 quadrillion). In practice this would take years, but is worth noting.
**Impact**: Negligible in practice.
**Recommendation**: Use `BigInt` for robustness, or reset the counter at `Number.MAX_SAFE_INTEGER`:
```ts
nextEventId = nextEventId >= Number.MAX_SAFE_INTEGER ? 1 : nextEventId + 1;
```

---

### [INFO] Per-agent start lock in heartbeat.ts is correctly implemented
**Severity**: INFO
**Location**: server/src/services/heartbeat.ts:91-106 (`withAgentStartLock`)
**Description**: The promise-chaining mutex pattern correctly serializes concurrent heartbeat start attempts for the same agent. The `marker` pattern ensures the Map entry is cleaned up even if no new requests follow.
**Impact**: Positive — prevents double-starts within an agent.
**Recommendation**: No change needed.

---

## Summary

| Category | Critical | High | Medium | Low | Info |
|----------|----------|------|--------|-----|------|
| Architecture | 0 | 0 | 1 | 1 | 1 |
| Error Handling | 0 | 0 | 2 | 1 | 1 |
| Type Safety | 0 | 0 | 2 | 0 | 2 |
| Test Coverage | 0 | 0 | 2 | 1 | 2 |
| Resource Management | 0 | 1 | 1 | 1 | 3 |
| Dead Code/Deps | 0 | 0 | 0 | 1 | 1 |
| Race Conditions | 0 | 1 | 0 | 1 | 1 |
| **Total** | **0** | **2** | **8** | **6** | **11** |

### Top Priority Findings

1. **[HIGH] TOCTOU race in shared service reuse** (`workspace-runtime.ts:853`) — concurrent runs can spawn duplicate service instances
2. **[HIGH] Child processes not terminated on graceful shutdown** — runtime services orphaned on SIGTERM
3. **[MEDIUM] `dbOrTx: any` in core services** (`issues.ts`, `projects.ts`) — should use proper DB transaction type
4. **[MEDIUM] Error context passed via `as any` property injection** — fragile coupling between error-handler and logger
5. **[MEDIUM] `access.ts` is 2,600+ lines** — needs splitting into focused sub-routers
6. **[MEDIUM] Missing validate() on several mutation routes** (`agents.ts`: pause/resume/terminate/cancel, `issues.ts`: release/comments-attachments) — review whether these need body validation
