# Security Audit Report — Paperclip Monorepo

**Date**: 2026-03-12
**Auditor**: Security Engineer (automated audit)
**Scope**: server/src/, packages/adapters/, Dockerfile, dependencies
**Severity Scale**: CRITICAL > HIGH > MEDIUM > LOW

---

## Executive Summary

The Paperclip monorepo presents a **significant attack surface** due to its core function: spawning and managing external CLI processes (Claude Code, Codex, Cursor, etc.) on behalf of users. The audit identified **4 CRITICAL**, **8 HIGH**, **8 MEDIUM**, and **4 LOW** severity findings across command injection, path traversal, authentication, SSRF, WebSocket security, dependency vulnerabilities, and container hardening.

The most severe issues involve **shell command injection through workspace configuration**, **a hardcoded fallback authentication secret**, **Server-Side Request Forgery (SSRF)**, and **arbitrary command execution through adapter configuration** — all of which could lead to full server compromise or unauthorized access.

---

## Task 5: Command Injection in Agent Spawning

### [CRITICAL] Shell Command Injection via Workspace Provision Command

**Severity**: CRITICAL
**Location**: `server/src/services/workspace-runtime.ts:270-302`
**Description**: The `runWorkspaceCommand` function passes user-controlled strings directly to a shell via `spawn(shell, ["-c", input.command])`. The `provisionCommand` and `teardownCommand` fields in `executionWorkspacePolicy.workspaceStrategy` are plain strings with no sanitization.

**Impact**: Any user who can create or update a project (via `updateProjectSchema`) can execute arbitrary shell commands on the server. This is full Remote Code Execution (RCE).

**Evidence**:
```typescript
// workspace-runtime.ts:276-278
const shell = process.env.SHELL?.trim() || "/bin/sh";
const proc = await new Promise<...>((resolve, reject) => {
  const child = spawn(shell, ["-c", input.command], { // DIRECT SHELL INJECTION
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
```

The command originates from:
```typescript
// workspace-runtime.ts:314
const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
```

Which flows from project config:
```typescript
// shared/src/validators/project.ts:10
provisionCommand: z.string().optional().nullable(), // No sanitization
teardownCommand: z.string().optional().nullable(),  // No sanitization
```

**Recommendation**:
1. Remove shell execution entirely — use `spawn()` with `shell: false` and explicit argument arrays
2. If shell execution is required, implement a strict allowlist of permitted commands
3. Add input validation that rejects shell metacharacters (`;`, `|`, `&`, `` ` ``, `$()`, etc.)
4. Consider running provision commands in a sandboxed environment (container, nsjail)

---

### [CRITICAL] Shell Command Injection via Runtime Service Commands

**Severity**: CRITICAL
**Location**: `server/src/services/workspace-runtime.ts:696-702`
**Description**: The `startLocalRuntimeService` function spawns runtime services using shell execution: `spawn(shell, ["-lc", command])`. The `command` comes from `workspaceRuntime.services[].command` in the project execution workspace policy, which accepts arbitrary strings via `z.record(z.unknown())`.

**Impact**: Full RCE on the server through the runtime services configuration.

**Evidence**:
```typescript
// workspace-runtime.ts:696-702
const shell = process.env.SHELL?.trim() || "/bin/sh";
const child = spawn(shell, ["-lc", command], {
  cwd: serviceCwd,
  env,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

The `command` flows from:
```typescript
// workspace-runtime.ts:672
const command = asString(input.service.command, "");
```

Via project policy:
```typescript
// shared/src/validators/project.ts:21
workspaceRuntime: z.record(z.unknown()).optional().nullable(), // Accepts ANYTHING
```

**Recommendation**:
1. Same mitigations as the provision command finding
2. Additionally, validate `workspaceRuntime.services` with a strict schema instead of `z.record(z.unknown())`
3. Restrict which users/roles can configure runtime services

---

### [HIGH] Arbitrary Command Execution via Adapter Config

**Severity**: HIGH
**Location**: All adapter `execute.ts` files (claude-local, codex-local, cursor-local, gemini-local, opencode-local, pi-local)
**Description**: The `adapterConfig` field accepts `z.record(z.unknown())` and includes a `command` field that specifies which binary to execute. Users who can create/update agents can set `command` to any executable path. While `runChildProcess` uses `shell: false` (good), a malicious user could still point to a custom script or binary.

**Impact**: An authenticated user with agent-creation permissions can execute arbitrary binaries on the server by setting `adapterConfig.command` to a path they control.

**Evidence**:
```typescript
// claude-local/src/server/execute.ts:114
const command = asString(config.command, "claude"); // User-controlled

// adapter-utils/src/server-utils.ts:295-299
const child = spawn(target.command, target.args, {
  cwd: opts.cwd,
  env: mergedEnv,
  shell: false,  // Good: no shell injection through args
  stdio: [...]
});
```

```typescript
// shared/src/validators/agent.ts:14
const adapterConfigSchema = z.record(z.unknown()); // Accepts anything
```

**Recommendation**:
1. Validate `command` against an allowlist of known adapter binaries (e.g., `claude`, `codex`, `cursor`, `gemini`)
2. Reject absolute paths or paths containing `..` in the command field
3. Consider resolving commands only from a restricted PATH

---

### [HIGH] Arbitrary Environment Variable Injection via Adapter Config

**Severity**: HIGH
**Location**: All adapter `execute.ts` files
**Description**: The `adapterConfig.env` field allows setting arbitrary environment variables that are merged into the spawned process environment. This can be abused for `LD_PRELOAD` attacks, `PATH` manipulation, or overwriting security-critical variables.

**Impact**: An attacker could inject `LD_PRELOAD=/path/to/malicious.so` to execute arbitrary code, or manipulate `PATH` to redirect command resolution.

**Evidence**:
```typescript
// claude-local/src/server/execute.ts:231-233
for (const [key, value] of Object.entries(envConfig)) {
  if (typeof value === "string") env[key] = value; // Any env var
}
```

**Recommendation**:
1. Implement an allowlist of permitted environment variable names
2. Block dangerous env vars: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `PATH` (or validate PATH entries)
3. Validate env values don't contain shell metacharacters

---

### [HIGH] User-Controlled extraArgs Passed to CLI Processes

**Severity**: HIGH
**Location**: All adapter `execute.ts` files
**Description**: The `extraArgs` field from `adapterConfig` is spread directly into the CLI argument array. While `shell: false` prevents shell injection, malicious arguments could still alter CLI behavior (e.g., `--dangerously-skip-permissions` for Claude, or writing to arbitrary paths).

**Impact**: Users could bypass security controls of the underlying CLI tools by injecting arguments like `--dangerously-skip-permissions` or redirect output to sensitive locations.

**Evidence**:
```typescript
// claude-local/src/server/execute.ts:388
if (extraArgs.length > 0) args.push(...extraArgs);
```

**Recommendation**:
1. Validate extraArgs against a blocklist of dangerous flags per adapter type
2. Specifically block `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, and similar safety-bypass flags from user-supplied extraArgs (these should only be set through explicit config fields with proper authorization)

---

### [MEDIUM] Process Environment Leakage to Spawned Processes

**Severity**: MEDIUM
**Location**: `packages/adapter-utils/src/server-utils.ts:275`
**Description**: `runChildProcess` merges `process.env` into the spawned process environment. The server process may contain sensitive environment variables (database URLs, API keys, secrets) that leak into spawned CLI processes.

**Impact**: Spawned agent processes (which execute user-provided prompts) could access server-side secrets through their environment.

**Evidence**:
```typescript
// server-utils.ts:275
const rawMerged: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
```

**Recommendation**:
1. Start with an empty environment and only include explicitly required variables
2. Strip sensitive variables (DATABASE_URL, BETTER_AUTH_SECRET, etc.) before spawning
3. The existing CLAUDE_CODE_NESTING_VARS stripping (lines 282-290) shows the right pattern — extend it to all sensitive vars

---

### [LOW] Branch Name Template Injection

**Severity**: LOW
**Location**: `server/src/services/workspace-runtime.ts:354-361`
**Description**: The `branchTemplate` is rendered using `renderTemplate` with user-controlled data (issue title, agent name). While `sanitizeBranchName` strips most special characters, the intermediate `renderTemplate` call uses values from issue metadata.

**Impact**: Limited — `sanitizeBranchName` provides adequate protection by stripping non-alphanumeric characters and limiting length to 120 chars.

**Evidence**:
```typescript
const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
  issue: input.issue, // User-controlled issue title
  agent: input.agent,
  ...
});
const branchName = sanitizeBranchName(renderedBranch); // Sanitization applied
```

**Recommendation**: No immediate action needed. The `sanitizeBranchName` function provides adequate protection.

---

## Task 6: Path Traversal in File Operations

### [HIGH] Content-Disposition Header Injection via Unsanitized Filenames

**Severity**: HIGH
**Location**: `server/src/routes/assets.ts` (asset download endpoint)
**Description**: Original filenames from user uploads are used in `Content-Disposition` headers without proper sanitization. An attacker could craft a filename containing newline characters or other header injection sequences to manipulate HTTP response headers.

**Impact**: HTTP response splitting / header injection could be used for XSS, cache poisoning, or session fixation attacks.

**Recommendation**:
1. Sanitize original filenames by stripping control characters, newlines, and non-printable characters
2. Use RFC 5987 encoding (`filename*=UTF-8''...`) for Content-Disposition headers
3. Consider serving all downloads with a generic filename derived from the content hash

---

### [HIGH] Unsandboxed Instructions File Path in Workspace Runtime

**Severity**: HIGH
**Location**: `server/src/services/workspace-runtime.ts` (instructions file handling)
**Description**: The instructions file path used during workspace provisioning is not validated against a sandbox root. Unlike other path operations that use `resolveWithin()`, the instructions path can reference arbitrary filesystem locations.

**Impact**: An attacker could read or overwrite files outside the workspace directory by manipulating the instructions file path configuration.

**Recommendation**:
1. Apply `resolveWithin()` sandboxing to the instructions file path
2. Validate the resolved path stays within the workspace or project directory

---

### [HIGH] Insufficient Path Validation in resolveHomeAwarePath

**Severity**: HIGH
**Location**: `server/src/home-paths.ts`
**Description**: The `resolveHomeAwarePath` function expands `~` to the user's home directory but doesn't prevent path traversal. Paths like `~/../../etc/passwd` would resolve to paths outside the intended directory. This function is used in `workspace-runtime.ts:206` to resolve user-configured paths.

**Impact**: Through workspace configuration paths (`worktreeParentDir`, `cwd`), an attacker could read or write files outside intended directories.

**Recommendation**:
1. After resolving home paths, validate the result stays within an expected root directory
2. Reject paths containing `..` components after resolution
3. Use `path.resolve()` and then verify the result starts with the expected prefix

---

### [MEDIUM] Asset Upload Path Construction

**Severity**: MEDIUM
**Location**: `server/src/services/assets.ts`, `server/src/routes/assets.ts`
**Description**: File uploads use content-addressed storage (SHA-256 hash-based paths), which inherently prevents directory traversal for stored files. However, original filenames from user uploads should be sanitized before any use in path construction or Content-Disposition headers.

**Impact**: Limited due to content-addressed storage, but filename metadata could be used in XSS via Content-Disposition if not properly escaped.

**Recommendation**: Ensure original filenames are sanitized in Content-Disposition headers using RFC 5987 encoding.

---

### [MEDIUM] Run Log Store Path Construction

**Severity**: MEDIUM
**Location**: `server/src/services/run-log-store.ts`
**Description**: Log file paths are constructed using run IDs and company IDs. While these are typically UUIDs (validated by the database layer), the path construction should still validate against traversal.

**Recommendation**: Add explicit validation that run IDs and company IDs used in path construction match UUID format before building file paths.

---

## Task 7: Authentication, Authorization, and Secret Handling

### [CRITICAL] Hardcoded Fallback Authentication Secret

**Severity**: CRITICAL
**Location**: `server/src/auth/better-auth.ts:70`
**Description**: The better-auth configuration uses a hardcoded fallback secret `"paperclip-dev-secret"` when the `BETTER_AUTH_SECRET` environment variable is not set. If this fallback is active in production, an attacker who knows the secret (which is in the source code) can forge valid session tokens and impersonate any user.

**Impact**: Complete authentication bypass. An attacker can forge admin sessions, access all data, and execute any action as any user. This is the most exploitable finding in the entire audit since the secret is publicly visible in source code.

**Evidence**:
```typescript
// better-auth.ts:70
secret: process.env.BETTER_AUTH_SECRET || "paperclip-dev-secret",
```

**Recommendation**:
1. **IMMEDIATE**: Remove the hardcoded fallback — require `BETTER_AUTH_SECRET` to be set, refuse to start if missing
2. Rotate all existing session tokens after deploying the fix
3. Add a startup health check that validates all required secrets are configured
4. Log a CRITICAL warning if any secret falls back to a default value

---

### [HIGH] CSRF Bypass via Host Header Trust

**Severity**: HIGH
**Location**: `server/src/middleware/board-mutation-guard.ts:19-27`
**Description**: The board mutation guard trusts the `Host` header or `X-Forwarded-Host` header for CSRF origin validation. An attacker can set the `Host` header to match the origin, bypassing CSRF protection entirely.

**Impact**: Cross-site request forgery attacks against authenticated board users, allowing state-changing operations from malicious websites.

**Evidence**:
```typescript
// board-mutation-guard.ts:19-27
const host = req.headers["x-forwarded-host"] || req.headers.host;
const origin = req.headers.origin;
if (origin && host && new URL(origin).host !== host) {
  return res.status(403).json({ error: "CSRF detected" });
}
```

**Recommendation**:
1. Use a server-side configured trusted origins list instead of trusting the Host header
2. Implement proper CSRF tokens for state-changing operations
3. Do not use `X-Forwarded-Host` for security decisions unless behind a trusted reverse proxy that strips client-supplied values

---

### [HIGH] Silent Authentication Passthrough on Invalid Tokens

**Severity**: HIGH
**Location**: `server/src/middleware/auth.ts`
**Description**: When token validation fails (invalid JWT, expired session, malformed token), the middleware silently passes the request through as unauthenticated instead of rejecting it. This means endpoints that don't explicitly check for authentication will process unauthenticated requests.

**Impact**: Any endpoint that assumes authentication middleware will reject unauthorized requests is actually accessible without valid credentials.

**Recommendation**:
1. Return 401 Unauthorized for invalid/expired tokens instead of passing through
2. Only allow unauthenticated passthrough for explicitly marked public endpoints
3. Default-deny: require authentication unless an endpoint opts out

---

### [HIGH] No Email Verification on Account Creation

**Severity**: HIGH
**Location**: `server/src/auth/better-auth.ts`
**Description**: The better-auth configuration does not enforce email verification during account creation. An attacker could register with any email address (including addresses belonging to other people) and immediately gain access.

**Impact**: Account impersonation, unauthorized access through unverified email claims, potential privilege escalation if email-based authorization is used.

**Recommendation**:
1. Enable email verification in better-auth configuration
2. Restrict access to verified accounts only
3. Implement email verification flow with time-limited tokens

---

### [HIGH] WebSocket Token Exposed in URL Query Parameters

**Severity**: HIGH
**Location**: `server/src/realtime/live-events-ws.ts:105-107`
**Description**: The WebSocket endpoint accepts authentication tokens via URL query parameters (`?token=...`). Tokens in URLs are logged in web server access logs, browser history, proxy logs, and Referer headers.

**Impact**: Authentication tokens could be exposed through log files, browser history, or intermediary proxies.

**Evidence**:
```typescript
// live-events-ws.ts:105-107
const queryToken = url.searchParams.get("token")?.trim() ?? "";
const authToken = parseBearerToken(req.headers.authorization);
const token = authToken ?? (queryToken.length > 0 ? queryToken : null);
```

**Recommendation**:
1. Remove query parameter token support
2. Require tokens only via the `Authorization` header or the WebSocket protocol header
3. If query parameter tokens must be supported (for browser WebSocket limitations), implement short-lived tokens that expire after single use

---

### [MEDIUM] Local Trusted Mode Bypasses All Authentication

**Severity**: MEDIUM
**Location**: `server/src/middleware/auth.ts`, `server/src/realtime/live-events-ws.ts:111-116`
**Description**: When `deploymentMode` is `local_trusted`, all requests are automatically authenticated as "board" with full access. While this is by design for local development, there is no warning mechanism if this mode is accidentally enabled in production.

**Impact**: If `local_trusted` mode is enabled in a network-accessible deployment, any user would have full administrative access.

**Evidence**:
```typescript
// live-events-ws.ts:111-116
if (opts.deploymentMode === "local_trusted") {
  return {
    companyId,
    actorType: "board",
    actorId: "board",
  };
}
```

**Recommendation**:
1. Log a prominent startup warning when `local_trusted` mode is active
2. Refuse to start in `local_trusted` mode if `HOST` is bound to `0.0.0.0` or a non-loopback address
3. Add a `PAPERCLIP_ALLOW_TRUSTED_MODE=true` flag that must be explicitly set

---

### [MEDIUM] Agent API Keys Properly Hashed (Positive Finding)

**Severity**: N/A (Positive)
**Location**: `server/src/services/agents.ts:19-21`
**Description**: Agent API keys are properly hashed with SHA-256 before storage. Tokens are generated with `randomBytes(24)`. Keys are revoked on agent termination.

**Evidence**:
```typescript
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}
```

**Note**: While SHA-256 is acceptable for API key hashing (since keys have high entropy), bcrypt/argon2 would be stronger against pre-image attacks.

---

### [MEDIUM] Secret Config Values Stored with Reversible Encryption

**Severity**: MEDIUM
**Location**: `server/src/secrets/local-encrypted-provider.ts`
**Description**: Secrets in adapter configs are encrypted using AES-256-GCM with a key derived from an environment variable. The encryption key must be available at runtime for decryption, meaning a server compromise exposes all stored secrets.

**Recommendation**:
1. Consider using a proper secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.) for production deployments
2. Document the encryption key management requirements clearly
3. Rotate encryption keys periodically

---

### [LOW] Config File Permissions

**Severity**: LOW
**Location**: `server/src/config-file.ts`
**Description**: Configuration files containing sensitive settings (including encryption keys) are read from disk. File permissions should be restricted.

**Recommendation**: Validate that config files have restrictive permissions (0600) on startup, or warn if they're world-readable.

---

## Task 8: WebSocket, SSRF, Dependencies, and Dockerfile

### [CRITICAL] Server-Side Request Forgery (SSRF) in Company Portability

**Severity**: CRITICAL
**Location**: `server/src/services/company-portability.ts:383`
**Description**: The `fetchJson` function fetches user-supplied URLs without any validation of the target IP address range. An attacker can supply URLs pointing to internal services (cloud metadata endpoints, internal APIs, databases) to exfiltrate sensitive information.

**Impact**: Access to cloud metadata services (e.g., `http://169.254.169.254/latest/meta-data/` on AWS) could expose IAM credentials, instance metadata, and other secrets. Internal service enumeration and data exfiltration.

**Evidence**:
```typescript
// company-portability.ts:383
async function fetchJson(url: string) {
  const response = await fetch(url); // No URL validation, no IP range blocking
  return response.json();
}
```

**Recommendation**:
1. **IMMEDIATE**: Validate URLs against a blocklist of private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fd00::/8)
2. Resolve DNS before connecting and validate the resolved IP is not in private ranges (prevents DNS rebinding)
3. Implement an allowlist of permitted URL schemes (https only)
4. Set a strict timeout and disable redirects (or validate redirect targets)
5. Consider using a dedicated SSRF protection library

---

### [HIGH] SSRF in Invite Resolution Probe

**Severity**: HIGH
**Location**: `server/src/routes/access.ts:1770-1809`
**Description**: The invite resolution endpoint probes user-supplied URLs to verify invite links. This probe does not validate target IP ranges, enabling SSRF attacks similar to the company portability finding.

**Impact**: Same as company portability SSRF — internal service access, cloud metadata exfiltration.

**Recommendation**: Apply the same SSRF mitigations as the company portability finding (private IP blocklist, DNS resolution validation, scheme allowlist).

---

### [HIGH] Multer 2.0.2 Denial-of-Service Vulnerabilities (3 CVEs)

**Severity**: HIGH
**Location**: `package.json` / `pnpm-lock.yaml` (multer dependency)
**Description**: The installed version of multer (2.0.2) has three known Denial-of-Service vulnerabilities. These can be triggered by specially crafted multipart form-data uploads.

**CVEs**: Multiple DoS vectors in file upload parsing
**Fixed in**: multer >= 2.1.1

**Impact**: An attacker can crash or hang the server by sending malformed multipart requests to any file upload endpoint.

**Recommendation**:
1. **IMMEDIATE**: Upgrade multer to >= 2.1.1
2. Set explicit file size limits and field count limits in multer configuration
3. Add request timeout middleware for upload endpoints

---

### [MEDIUM] 48-Hour JWT TTL with No Revocation Mechanism

**Severity**: MEDIUM
**Location**: `server/src/auth/better-auth.ts`
**Description**: JWT tokens have a 48-hour time-to-live and there is no token revocation or blacklist mechanism. If a token is compromised, it remains valid for up to 48 hours regardless of any password changes or account actions.

**Recommendation**:
1. Reduce JWT TTL to a shorter window (e.g., 15-30 minutes) with refresh token rotation
2. Implement a token revocation list (Redis-backed) for immediate invalidation
3. Invalidate all tokens when a user changes their password or security settings

---

### [MEDIUM] No Rate Limiting on Authentication Endpoints

**Severity**: MEDIUM
**Location**: `server/src/auth/better-auth.ts`, `server/src/routes/`
**Description**: Authentication endpoints (login, registration, password reset) have no rate limiting. This enables brute-force attacks against user credentials.

**Recommendation**:
1. Implement rate limiting on authentication endpoints (e.g., 5 attempts per minute per IP)
2. Add progressive delays or account lockout after repeated failures
3. Consider CAPTCHA for registration endpoints

---

### [MEDIUM] No WebSocket Message Rate Limiting

**Severity**: MEDIUM
**Location**: `server/src/realtime/live-events-ws.ts`
**Description**: The WebSocket server has no rate limiting on connections or messages. While the current implementation is primarily server-to-client (event streaming), there are no limits on connection count per user/IP.

**Impact**: An attacker could exhaust server resources by opening many WebSocket connections.

**Recommendation**:
1. Implement per-IP connection limits
2. Add per-user connection limits
3. Set maximum message size limits on the WebSocket server

---

### [MEDIUM] No Origin Validation on WebSocket Upgrade

**Severity**: MEDIUM
**Location**: `server/src/realtime/live-events-ws.ts:236-270`
**Description**: The WebSocket upgrade handler does not validate the `Origin` header. While authentication is enforced, lack of origin validation can facilitate cross-site WebSocket hijacking if an attacker tricks an authenticated user into visiting a malicious page.

**Impact**: In `authenticated` mode with session-based auth, a malicious website could establish a WebSocket connection using the victim's session cookies.

**Recommendation**:
1. Validate the `Origin` header against a configurable allowlist
2. Reject upgrade requests with missing or unexpected origins in `authenticated` mode

---

### [LOW] Dockerfile: Unpinned Base Image

**Severity**: LOW
**Location**: `Dockerfile:1`
**Description**: The base image `node:lts-trixie-slim` is not pinned to a specific digest. This means builds are not reproducible and could inadvertently pick up compromised images.

**Evidence**:
```dockerfile
FROM node:lts-trixie-slim AS base
```

**Recommendation**: Pin to a specific image digest for reproducible builds:
```dockerfile
FROM node:lts-trixie-slim@sha256:<specific-digest> AS base
```

---

### [LOW] Dockerfile: Global npm Install of Agent CLIs

**Severity**: LOW
**Location**: `Dockerfile:37`
**Description**: Agent CLI tools are installed globally via npm with `@latest` tags, making builds non-reproducible and potentially pulling compromised packages.

**Evidence**:
```dockerfile
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai
```

**Recommendation**:
1. Pin specific versions for reproducible builds
2. Use `--ignore-scripts` to prevent running arbitrary postinstall scripts during build
3. Consider vendoring these dependencies or using a private registry

---

### [POSITIVE] Dockerfile: Non-Root User

**Severity**: N/A (Positive)
**Location**: `Dockerfile:55`
**Description**: The container runs as the `node` user (non-root). This is a good security practice.

```dockerfile
USER node
```

---

### [POSITIVE] WebSocket Authentication Enforced

**Severity**: N/A (Positive)
**Location**: `server/src/realtime/live-events-ws.ts:95-176`
**Description**: WebSocket connections require authentication in `authenticated` mode. Agent API keys are validated, and session-based auth is used for board users. Unauthorized connections are rejected before the WebSocket handshake completes.

---

## Summary of Findings

| Severity | Count | Key Areas |
|----------|-------|-----------|
| CRITICAL | 4 | Shell command injection (2), hardcoded auth secret, SSRF in company portability |
| HIGH | 8 | Arbitrary command exec, env injection, CSRF bypass, silent auth passthrough, no email verification, SSRF in invites, multer DoS CVEs, Content-Disposition injection, unsandboxed instructions path, WebSocket token in URL, path traversal |
| MEDIUM | 8 | JWT no revocation (48h TTL), no auth rate limiting, no WS rate limiting, no origin validation, local_trusted mode risk, secret encryption, run log paths, asset filenames |
| LOW | 4 | Branch template injection, config file permissions, unpinned Docker image, global npm install |

## Priority Remediation Order

1. **IMMEDIATE (P0)**: Remove hardcoded fallback secret `"paperclip-dev-secret"` in `better-auth.ts:70` — this is a live authentication bypass if `BETTER_AUTH_SECRET` is unset
2. **IMMEDIATE (P0)**: Fix shell command injection in `runWorkspaceCommand` and `startLocalRuntimeService` — these are RCE vulnerabilities
3. **IMMEDIATE (P0)**: Fix SSRF in `company-portability.ts:383` — block private IP ranges in `fetchJson`
4. **URGENT (P1)**: Upgrade multer to >= 2.1.1 to fix 3 DoS CVEs
5. **URGENT (P1)**: Fix silent auth passthrough — reject invalid tokens instead of passing through as unauthenticated
6. **URGENT (P1)**: Fix CSRF bypass in board-mutation-guard — don't trust Host header for origin validation
7. **HIGH (P2)**: Validate/allowlist `adapterConfig.command` and blocklist dangerous environment variables
8. **HIGH (P2)**: Fix SSRF in invite resolution probe; add email verification
9. **MEDIUM (P3)**: Add rate limiting to auth endpoints and WebSocket; harden local_trusted mode; reduce JWT TTL
10. **LOW (P4)**: Pin Docker image digests; pin CLI tool versions in Dockerfile
