# Security HIGH Severity Fixes -- Status Report

**Date**: 2026-03-11
**Agent**: security-engineer
**Status**: COMPLETE -- changes unstaged on master, awaiting critical fixes commit before staging

---

## Fix 1: Path Traversal -- resolveHomeAwarePath

**Files Modified**:
- `server/src/home-paths.ts` -- Added `resolveWithinRoot()` exported function that validates resolved paths stay within an allowed root directory
- `server/src/services/workspace-runtime.ts` -- `resolveConfiguredPath()` was already patched on master (validates relative paths do not traverse outside the base directory)

**What Changed**:
- New `resolveWithinRoot(value, allowedRoot)` function checks that `path.resolve()` output starts with `allowedRoot + path.sep` (or equals it exactly), preventing prefix-matching attacks (e.g., `/workspace/project-evil` would not match `/workspace/project`)
- `resolveConfiguredPath()` validation was already present in HEAD

**Test**: `server/src/__tests__/path-validation.test.ts` (new file)

---

## Fix 2: CSRF Bypass -- Board Mutation Guard

**Files Modified**:
- `server/src/middleware/board-mutation-guard.ts` -- Replaced Host-header-based trust with configured trusted origins list
- `server/src/app.ts` -- Updated `createApp` to accept `trustedOrigins` option and pass it to `boardMutationGuard()`
- `server/src/index.ts` -- Hoisted `trustedOrigins` variable from authenticated block scope and passed it to `createApp`

**What Changed**:
- Removed `trustedOriginsForRequest()` which built trusted origins from the client-controlled `Host` / `X-Forwarded-Host` headers
- `boardMutationGuard()` now accepts an optional `trustedOrigins` parameter (array of allowed origin URLs)
- Origins are validated against the configured set (plus default dev origins) at middleware creation time, not per-request from headers
- In authenticated mode, the same `effectiveTrustedOrigins` computed for better-auth are now shared with the board mutation guard

**Test**: `server/src/__tests__/board-mutation-guard.test.ts` (updated -- added tests for configured origins, Host-header bypass rejection, case-insensitive matching)

---

## Fix 3: Silent Auth Passthrough

**Files Modified**:
- `server/src/middleware/auth.ts` -- Changed fail-open to fail-closed when bearer tokens are present but invalid

**What Changed**:
- Empty bearer token (header present but no value): now returns 401
- Invalid token (no matching API key AND invalid JWT): now returns 401 instead of silently continuing as `type: "none"`
- Agent not found or company mismatch (JWT path): now returns 401
- Terminated or pending_approval agent (JWT path): now returns 403
- Agent not found, terminated, or pending_approval (API key path): now returns 401
- Requests WITHOUT a bearer token still pass through as `type: "none"` (preserving public endpoint access)

**Test**: `server/src/__tests__/auth-fail-closed.test.ts` (new file)

---

## Fix 4: WebSocket Token in URL Parameters

**Files Modified**:
- `server/src/realtime/live-events-ws.ts` -- Removed query parameter token support, added Sec-WebSocket-Protocol auth

**What Changed**:
- Removed `url.searchParams.get("token")` from the `authorizeUpgrade()` function
- Added `parseSecWebSocketProtocolToken()` helper that parses the `Sec-WebSocket-Protocol` header using the `"access_token, <token_value>"` convention
- Token resolution now: Authorization header (bearer) > Sec-WebSocket-Protocol > null
- Tokens are no longer exposed in URLs (server logs, browser history, proxy logs, Referer headers)

---

## Files Changed Summary

| File | Change Type |
|------|------------|
| `server/src/home-paths.ts` | Added `resolveWithinRoot()` |
| `server/src/middleware/board-mutation-guard.ts` | Rewrote to use configured origins |
| `server/src/middleware/auth.ts` | Fail-closed on invalid tokens |
| `server/src/realtime/live-events-ws.ts` | Removed query token, added WS protocol auth |
| `server/src/app.ts` | Pass `trustedOrigins` to guard |
| `server/src/index.ts` | Thread `trustedOrigins` to `createApp` |
| `server/src/__tests__/board-mutation-guard.test.ts` | Updated with new test cases |
| `server/src/__tests__/auth-fail-closed.test.ts` | New test file |
| `server/src/__tests__/path-validation.test.ts` | New test file |

## Conflict Risk Assessment

These changes do NOT touch the same code as the CRITICAL fixes (hardcoded secret in `better-auth.ts`, shell injection in `workspace-runtime.ts:270-302` and `:696-702`, SSRF in `company-portability.ts`). Merge conflicts are unlikely.
