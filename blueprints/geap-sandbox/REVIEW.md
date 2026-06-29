# GEAP Code Execution Sandbox Adapter — Code Review

**Date:** 2026-06-29
**Reviewer:** Code Review Agent
**Files:** `src/index.ts` (644 lines), `DESIGN.md`, `package.json`, `sandbox--geap.md`

---

## Executive Summary

This adapter implements a well-structured bridge from GEAP's code-execution REST API to Flue's `SandboxApi` by generating Python code snippets for each filesystem and shell operation. The architecture is sound and consistent with existing adapters (E2B, Daytona, Modal), but has **two critical reliability issues** — an unrecoverable cached-promise failure and missing HTTP timeouts — that could leave production agents permanently broken or indefinitely hung.

**Verdict:** REQUEST CHANGES — fix the two Critical issues before merge; Important items should also be addressed.

---

## Critical Issues

### 1. Cached Promise Rejection Is Non-Recoverable

**File:** `src/index.ts:611-624` (inside `geap()` factory)

```typescript
let reasoningEngineNamePromise: Promise<string> | undefined;

async function getReasoningEngineName(): Promise<string> {
    if (options.reasoningEngineId) { ... }
    if (!reasoningEngineNamePromise) {
        reasoningEngineNamePromise = client.createReasoningEngine(
            options.displayName ?? 'flue-geap-sandbox',
        );
    }
    return reasoningEngineNamePromise;
}
```

**Problem:** If the initial `createReasoningEngine` call fails (transient network error, quota exceeded, 503 from GCP), the rejected promise is cached forever. Every subsequent call to `getReasoningEngineName()` — and therefore every `createSessionEnv()` — returns the same rejected promise. The factory is permanently broken for the lifetime of the process. A single transient failure during startup poisons all future sessions.

**Suggested Fix:**

```typescript
let reasoningEngineNamePromise: Promise<string> | undefined;

async function getReasoningEngineName(): Promise<string> {
    if (options.reasoningEngineId) {
        return `projects/${options.projectId}/locations/${region}/reasoningEngines/${options.reasoningEngineId}`;
    }
    if (!reasoningEngineNamePromise) {
        reasoningEngineNamePromise = client.createReasoningEngine(
            options.displayName ?? 'flue-geap-sandbox',
        ).catch((err) => {
            // Clear cached promise on failure so the next caller retries.
            reasoningEngineNamePromise = undefined;
            throw err;
        });
    }
    return reasoningEngineNamePromise;
}
```

This preserves the concurrent-call deduplication (all callers during the in-flight request share the same promise) while allowing retries after failure.

---

### 2. No HTTP Timeout on `fetch` Calls

**File:** `src/index.ts:137-162` (`GeapClient.request`)

```typescript
private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/${path}`;
    const response = await fetch(url, {
        method,
        headers: { ... },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // ← No signal, no timeout
    });
    ...
}
```

**Problem:** Every GEAP API call (`createReasoningEngine`, `createSandboxEnvironment`, `executeCode`, `pollOperation`) uses `fetch` with no `AbortSignal` or timeout. If the GCP API server hangs, stalls, or a network partition occurs, the adapter blocks indefinitely. The Python-level subprocess timeout (line 311) only limits execution *inside* the sandbox — the HTTP transport layer has no deadline.

This is especially dangerous in `pollOperation` (lines 239-259) where the 1-second polling interval compounds: a single hung poll request blocks the entire 2-minute timeout window without any further retries.

**Suggested Fix:**

```typescript
private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
): Promise<T> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/${path}`;
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    ...
}
```

For `executeCode` calls, the timeout should be longer (e.g., the subprocess timeout + a margin):

```typescript
async executeCode(sandboxName: string, code: string, ...): Promise<ExecuteCodeResponse> {
    ...
    // Allow generous HTTP timeout since code execution can take up to 300s.
    return this.request<ExecuteCodeResponse>(
        'POST', `${sandboxName}:executeCode`, body, 330_000,
    );
}
```

---

## Important Issues

### 3. No Validation of `sandbox.name` After Creation

**File:** `src/index.ts:266-267`

```typescript
const resolved = await this.pollOperation(op.name);
return resolved.response as unknown as SandboxEnvironmentResource;
```

**Problem:** The operation response is unsafely cast to `SandboxEnvironmentResource`. If GEAP returns a response without a `name` field (API version change, unexpected shape), `sandbox.name` becomes `undefined`. All subsequent `executeCode` calls would hit `undefined:executeCode`, producing a confusing error far from the root cause.

**Suggested Fix:**

```typescript
const resolved = await this.pollOperation(op.name);
const resource = resolved.response as Record<string, unknown> | undefined;
const name = resource?.name;
if (typeof name !== 'string') {
    throw new Error(
        '[flue:geap] Failed to extract sandbox environment name from operation response.',
    );
}
return { ...resource, name } as SandboxEnvironmentResource;
```

This mirrors the existing validation pattern already used in `createReasoningEngine` (lines 176-180), making both paths consistent.

---

### 4. `writeFile` Embeds Entire Content in Code Payload — No Size Guard

**File:** `src/index.ts:359-370` (`pyWriteFile`) and `src/index.ts:519-529` (`GeapSandboxApi.writeFile`)

**Problem:** For both string and binary writes, the *entire file content* is serialized into a Python string literal inside the code payload. A 50MB file becomes a ~70MB JSON-encoded code string (after JSON escaping and base64 for binary). This will:

1. Approach or exceed GEAP's 100MB request limit
2. Cause significant memory pressure from string construction (`Array.from(content).map(String.fromCharCode).join('')` for binary creates a full intermediate string)
3. Potentially hit JSON serialization limits

The GEAP API already supports `inputFiles` for file transfer — the `GeapClient.executeCode` method accepts them (line 220) but `writeFile` doesn't use this path.

**Suggested Fix:** For large content, use the `inputFiles` API and have the Python code read from the input file:

```typescript
async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === 'string') {
        // For content under a threshold, embed directly in code.
        if (content.length < 1_000_000) {
            await this.run<null>(pyWriteFile(path, content));
        } else {
            // Use inputFiles for large content.
            const code = `
import json, shutil, sys
try:
    shutil.copy('/input/upload', ${pyStr(path)})
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)`.trim();
            const response = await this.client.executeCode(
                this.sandboxName, code,
                [{ name: '/input/upload', contents: content }],
            );
            parseCodeResult<null>(response);
        }
    } else {
        // ... similar for binary with base64
    }
}
```

---

### 5. `pollOperation` Uses Fixed Interval — No Backoff, Tight Timeout

**File:** `src/index.ts:239-259`

```typescript
private async pollOperation(
    operationName: string,
    intervalMs = 1000,
    maxAttempts = 120,
): Promise<Operation> {
```

**Problems:**
- **Fixed 1-second polling** with no exponential backoff. At 120 requests in 2 minutes, this generates significant API load and may trigger GCP rate limiting.
- **2-minute hard cap** may be insufficient for reasoning engine creation in large projects or under GCP load.
- **Timeout message is misleading:** states `maxAttempts * intervalMs` ms but actual wall-clock time is longer due to HTTP request latency.

**Suggested Fix:**

```typescript
private async pollOperation(
    operationName: string,
    initialIntervalMs = 500,
    maxWaitMs = 300_000, // 5 minutes
): Promise<Operation> {
    const start = Date.now();
    let interval = initialIntervalMs;
    while (Date.now() - start < maxWaitMs) {
        const op = await this.request<Operation>('GET', operationName);
        if (op.done) {
            if (op.error) {
                throw new Error(
                    `[flue:geap] Operation failed: ${op.error.message ?? 'unknown error'} (code ${op.error.code})`,
                );
            }
            return op;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
        interval = Math.min(interval * 1.5, 5000); // Cap at 5s
    }
    throw new Error(
        `[flue:geap] Operation ${operationName} timed out after ${Date.now() - start}ms.`,
    );
}
```

---

### 6. No Tests

**Observation:** The `geap-sandbox` package has no test files. Given the complexity of the Python code generation, the structured output parsing, and the string escaping logic, at minimum unit tests should cover:

- `pyStr` with edge-case inputs (backslashes, quotes, newlines, unicode, empty strings)
- `parseCodeResult` with valid JSON, invalid JSON, empty stdout, execution errors
- `pyExec` / `pyWriteFile` / `pyReadFile` code generation correctness
- The `readFileBuffer` base64 round-trip
- The `writeFile` binary-to-base64 encoding path

---

## Suggestions

### 7. `pyStr` — Theoretical Edge Case with Surrogate Pairs

**File:** `src/index.ts:303-305`

```typescript
function pyStr(value: string): string {
    return JSON.stringify(value);
}
```

Using `JSON.stringify` for Python string escaping is clever and works for the vast majority of inputs. Both JSON and Python 3 interpret `\"`, `\\`, `\n`, `\r`, `\t` identically within double-quoted strings.

However, `JSON.stringify` encodes characters above U+FFFF as surrogate pairs (`𐀀`), which are invalid in Python 3 string literals (Python uses `\UXXXXXXXX` for supplementary plane characters). This is extremely unlikely to affect real file paths or shell commands, but the docstring claim of "repr-style escaping" is inaccurate — it's JSON escaping, which is *almost* Python-compatible.

**No action required**, but consider noting this limitation in the docstring.

---

### 8. `AbortSignal` Not Forwarded to `fetch`

**File:** `src/index.ts:570-582` (`exec` method)

The `exec` method accepts `signal?: AbortSignal` in its options but never forwards it to the underlying `fetch` call. Per the `SandboxApi` interface contract, this is acceptable:

> *"Sandbox adapters that can't honor it should ignore it; the deadline is still enforced via `timeoutMs`."*

And `createSandboxSessionEnv` wraps the adapter with pre/post abort checks (lines 260-262 in `sandbox.ts`). So abort semantics are correct at the `SessionEnv` layer.

However, forwarding the signal to `fetch` would allow true mid-flight cancellation of GEAP API calls, which could save time during agent shutdown or timeout scenarios.

---

### 9. Reasoning Engine Cleanup / Resource Leak

**File:** `src/index.ts:607-643`

The factory may create a reasoning engine (lines 618-621) that persists indefinitely in the GCP project. Unlike sandbox environments which auto-expire via TTL, reasoning engines are permanent resources. Each factory instance (without a `reasoningEngineId`) creates a new one.

If the adapter is used in serverless environments (Cloud Run, Workers) where instances are ephemeral, this could create orphaned reasoning engines over time.

**Recommendation:** Document this behavior prominently. Consider adding a cleanup utility or recommending that users always provide `reasoningEngineId` for production use.

---

### 10. Error Messages May Include Sensitive Server Details

**File:** `src/index.ts:154-158`

```typescript
if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
        `[flue:geap] ${method} ${path} failed (${response.status}): ${text}`,
    );
}
```

The full response body from GCP errors is included in the thrown error. GCP error responses can contain internal service details, request IDs, and occasionally project metadata. While this is valuable for debugging, it could be a concern if these errors are surfaced to end-users.

For a sandbox adapter used in agentic contexts, this is probably fine, but consider truncating `text` to a reasonable limit (e.g., 500 chars) to prevent very large error bodies from bloating logs.

---

## What's Done Well

1. **Structured output protocol** — The `{"ok": true, "data": ...}` JSON envelope pattern is robust. Every Python snippet follows the same try/catch → JSON → stdout pattern, and `parseCodeResult` parses the last non-empty line. This elegantly handles cases where Python prints warnings or import messages to stdout before the result.

2. **Token refresh architecture** — Supporting both `string` and `() => string | Promise<string>` for `accessToken` is a thoughtful design. The function variant enables seamless token rotation in production (e.g., via `google-auth-library`) without requiring the adapter to take a dependency on it.

3. **Correct subprocess pattern** — `subprocess.run(command, shell=True, capture_output=True, text=True)` correctly captures stdout/stderr separately, handles timeouts with a proper `TimeoutExpired` catch that returns exit code 124 (Unix convention), and the `env` merging with `{**os.environ, ...custom}` preserves the sandbox's baseline environment.

4. **SandboxApi conformance** — All 9 methods (`readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`, `exec`) are implemented. The method signatures match the interface exactly. The `FileStat` return shape correctly uses optional fields (`isSymbolicLink`, `size`, `mtime`) per the interface contract. The `stat` implementation correctly uses `follow_symlinks=True` for the main stat but separately checks `os.path.islink` for the symlink flag — semantically consistent with POSIX `stat` behavior.

5. **Consistent error tagging** — All errors use the `[flue:geap]` prefix, following the project's established convention (E2B uses `[flue:e2b]`, Daytona uses `[flue:daytona]`). This aids log filtering.

6. **Clean separation of concerns** — `GeapClient` handles HTTP/auth, Python generators handle code construction, `GeapSandboxApi` implements the `SandboxApi` interface, and the `geap()` factory manages lifecycle. Each layer has a single responsibility.

7. **Zero external dependencies** — Using built-in `fetch` instead of requiring a Google Cloud SDK package keeps the dependency tree clean. The `peerDependencies` only lists `@flue/runtime`, which is correct.

---

## Verification Story

- **Tests reviewed:** No — no test files exist in the package.
- **Build verified:** No — workspace dependency resolution not available in this environment. TypeScript config (`tsconfig.json`) is correctly configured with `strict: true`.
- **Lint/static analysis clean:** Not runnable, but no obvious type issues beyond the `createSessionEnv` signature note (TypeScript allows fewer parameters, consistent with E2B/Daytona adapters).
- **Security checked:** Yes — `pyStr` using `JSON.stringify` is safe against Python code injection for practical inputs. Auth tokens are passed via Bearer header only. No secrets in generated code. Error messages could leak server details (Suggestion #10).

---

## Summary of Findings

| # | Severity | Summary |
|---|----------|---------|
| 1 | **Critical** | Cached promise rejection permanently breaks the factory |
| 2 | **Critical** | No HTTP timeout — hung GCP calls block indefinitely |
| 3 | Important | No validation of `sandbox.name` after creation |
| 4 | Important | `writeFile` embeds full content in code — no size guard |
| 5 | Important | `pollOperation` needs backoff and longer timeout |
| 6 | Important | No unit tests for code generation or parsing |
| 7 | Suggestion | `pyStr` surrogate pair edge case — document limitation |
| 8 | Suggestion | `AbortSignal` not forwarded to `fetch` |
| 9 | Suggestion | Reasoning engine cleanup / resource leak risk |
| 10 | Suggestion | Truncate error response bodies |
