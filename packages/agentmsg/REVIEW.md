# @flue/agentmsg — Code Review

**Reviewer:** Senior Staff Engineer / Security Researcher
**Date:** 2026-06-29
**Files reviewed:** `src/index.ts` (696 lines), `src/types.ts` (150 lines), `DESIGN.md`, `package.json`
**Reference:** Python client at `/workspace/agentmsg/clients/python/src/agentmsg_client/__init__.py`
**Cross-reference:** AgentMsg relay backend (`mailbox_controller.ex`, `messages.ex`)

---

## Executive Summary

The AgentMsg channel is a well-structured, protocol-correct implementation that follows Flue channel conventions (factory function, routes, `conversationKey`/`parseConversationKey`). However, it has one **critical bug** in its ack-failure comment that reveals a misunderstanding of relay semantics (DELIVERED messages ARE redelivered on poll), one important issue with missing HTTP timeouts, and several moderate observations around polling reliability and tool design.

**Verdict: REQUEST CHANGES** — the ack-failure handling must be corrected before merge; messages will be silently re-processed if ack fails.

---

## Critical Issues

### 1. [src/index.ts:355-357] Incorrect ack-failure comment hides a real redelivery bug

The comment on the ack failure catch reads:

```ts
// Ack failure is non-fatal — messages will be re-processed
// next poll (relay marks them DELIVERED, not PENDING, so
// they won't appear again anyway).
```

**This is factually wrong.** Verified against the relay backend (`messages.ex:202-204`):

```elixir
from(m in MessageEnvelope,
  where: m.target_agent_id == ^agent_id,
  where: m.status in ["PENDING", "DELIVERED"],  # <-- BOTH statuses returned
  ...
)
```

The relay's `get_pending_messages` returns messages with status **PENDING or DELIVERED**. The GET endpoint marks PENDING → DELIVERED, but DELIVERED messages **continue to appear** on subsequent polls until they are ACKed (DELIVERED → ACKNOWLEDGED). This means:

- If ack fails, every un-acked message will be **re-delivered on every subsequent poll**
- The `onMessage` handler will be called **again** for already-processed messages
- This can cause duplicate side effects (duplicate responses, duplicate tool invocations)

The comment creates false confidence that ack failure is harmless, when it is actually a source of duplicate message processing.

**Recommended fix:** Either:
- **(A)** Retry ack with backoff (preferred), or
- **(B)** Track acked message IDs locally to deduplicate on the next poll cycle, or
- **(C)** At minimum, fix the comment and log a warning so operators know ack failed and redelivery will occur

Minimal fix for option (C):

```ts
// Ack failure is non-fatal — but un-acked messages WILL
// reappear on the next poll (the relay returns both PENDING
// and DELIVERED messages). The onMessage handler should be
// idempotent or callers should deduplicate by message ID.
```

And for option (A), a retry:

```ts
if (ackIds.length > 0) {
    const ackUrl = `${relayUrl}/mailbox/${encodeURIComponent(agentId)}/ack`;
    const ackBody = { message_ids: ackIds };
    await relayFetch(fetchFn, 'POST', ackUrl, ackBody).catch(async () => {
        // Retry once — un-acked messages will be redelivered on the next poll
        await relayFetch(fetchFn, 'POST', ackUrl, ackBody).catch(() => {});
    });
}
```

### 2. [src/index.ts:438-447] Same incorrect ack assumption in webhook handler

The webhook path has the same fire-and-forget ack with `.catch(() => {})` and no comment at all. The same redelivery risk applies if the relay re-pushes un-acked messages.

---

## Important Issues

### 3. [src/index.ts:158-184] No HTTP timeout on `relayFetch`

The `relayFetch` function calls `fetchFn(url, { method, headers, body })` with no `signal` or timeout. The reference Python client uses a 25-second timeout (`timeout: float = 25.0`).

A hanging relay connection will block the poll loop indefinitely. Since `polling = true` is the guard, a stuck fetch means no further polls will run — the channel silently stops receiving messages.

**Recommended fix:**

```ts
async function relayFetch(
    fetchFn: typeof globalThis.fetch,
    method: string,
    url: string,
    body?: unknown,
    timeoutMs = 25_000,
): Promise<{ status: number; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetchFn(url, {
            method,
            headers,
            body: reqBody,
            signal: controller.signal,
        });
        // ...
    } finally {
        clearTimeout(timer);
    }
}
```

### 4. [src/index.ts:610] Send tool ignores `context.signal` (AbortSignal)

The `AgentMsgSendToolDefinition` interface declares `signal?: AbortSignal` in the `run()` context, but the implementation at line 610-628 never passes it through to `relayFetch`. If the Flue runtime cancels a tool call (e.g., the user aborts a session), the HTTP request will continue in the background.

**Recommended fix:** Pass `context.signal` to `relayFetch` and forward it to the underlying `fetch` call.

### 5. [src/index.ts:486-495] `start()` does not propagate initial poll errors

```ts
async start() {
    await register();
    // Immediately poll once, then set up interval
    pollMailbox().catch(() => {}); // <-- swallowed
    if (pollIntervalMs > 0) {
        pollTimer = setInterval(() => {
            pollMailbox().catch(() => {});
        }, pollIntervalMs);
    }
},
```

The initial `pollMailbox()` call after registration is fire-and-forget. If registration succeeds but the first poll fails (e.g., the mailbox endpoint is misconfigured), the caller of `start()` has no way to know. Consider `await`-ing the first poll or at least documenting this behavior.

### 6. No test file

There are no test files (`*.test.ts`, `*.spec.ts`) in the package. For a channel that handles message routing, polling, and ack, tests are important to prevent regressions — especially for:
- `parseMailboxEntry` parsing edge cases
- `buildEnvelope` format correctness
- `conversationKey`/`parseConversationKey` round-trip
- Poll-loop overlap guard behavior
- Webhook handler's dual-format parsing

---

## Suggestions

### 7. [src/index.ts:317-319] Polling overlap guard is not concurrency-safe

```ts
if (polling) return; // guard against overlapping polls
polling = true;
```

This is a simple boolean guard. In a Node.js single-threaded environment this is fine for `setInterval`, but if `pollMailbox` is ever called concurrently from multiple code paths (e.g., webhook triggers a manual poll), the check-then-set pattern could theoretically race. For single-threaded JS this is safe in practice, but documenting the assumption would help future maintainers.

### 8. [src/index.ts:326-328] Silent poll failure — consider logging

```ts
if (status !== 200) {
    // Non-fatal: log but don't crash the poll loop
    return;
}
```

The comment says "log" but no logging actually occurs. Without observability, a persistent poll failure (auth expired, endpoint moved) will be invisible. Consider accepting an optional `logger` in options or at minimum emitting a `console.warn`.

### 9. [src/index.ts:247-252] `randomHex()` produces only 8 hex chars

```ts
function randomHex(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
```

This produces 8 hex characters (32 bits of entropy) for request IDs, message IDs, and context IDs. The Python client uses `uuid.uuid4().hex[:8]` which is also 8 hex chars (32 bits). These match, so it's protocol-consistent, but 32 bits provides only ~65K IDs before a 50% collision probability (birthday paradox). For request/message IDs that need uniqueness across agents and time, consider using a full UUID or at least 8 bytes (64 bits).

### 10. [src/index.ts:586-628] Tool schema missing `additionalProperties: false`

The tool input schema doesn't set `additionalProperties: false`. While not strictly required, LLMs sometimes hallucinate extra properties (e.g., `{ to: "...", message: "...", priority: "high" }`). Setting `additionalProperties: false` tells the model exactly what's accepted.

### 11. [src/index.ts:293-302] Registration `card.url` points to relay, not to the agent

```ts
const card = {
    name: displayName,
    url: `${relayUrl}/a2a`,  // <-- this is the relay URL
    description: `Flue agent ${agentId}`,
    ...extraCard,
};
```

The Python client has the same pattern (`"url": f"{self.base_url}/a2a"`), so this is protocol-consistent. However, semantically the agent card URL should point to the agent's own A2A endpoint, not the relay's. Since AgentMsg agents don't have public endpoints (that's the point of the relay), this is a reasonable convention — but a comment explaining why would help.

### 12. [src/index.ts:497-500] `stop()` doesn't cancel in-flight poll

```ts
stop() {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
},
```

If a poll is in-flight when `stop()` is called, the HTTP request continues. Combined with Issue #3 (no timeout), this means `stop()` doesn't guarantee cleanup. Consider using an `AbortController` that is aborted in `stop()`.

### 13. [src/index.ts:640-656] `listAgentMsgAgents` uses `/agents` endpoint

The function calls `GET /agents`. The relay's registration endpoint is `POST /api/agents`, but the catalog listing is at `GET /agents`. This is consistent with the Python client which also uses `GET /agents` for catalog. Just flagging that the API surface is split between `/api/agents` (write) and `/agents` (read) — this is relay-side, not a bug here.

### 14. [src/types.ts] No `callback_url` in `AgentMsgRegisterRequest` type despite being protocol-supported

The Python client's `register()` method accepts `callback_url` for push delivery. The TS `AgentMsgRegisterRequest` type includes `callback_url?: string` (line 29), which is correct. But `createAgentMsgChannel` never sends it during registration (line 297-304), even though the channel does set up a webhook handler. If push delivery is intended, the registration should include the callback URL.

---

## What's Done Well

1. **Protocol correctness is strong.** The envelope format (`jsonrpc: "2.0"`, `method: "message/send"`, `params.metadata.relay_target_agent_id` / `sender_agent_id`, `params.message.parts[].text`) exactly matches the Python reference client and relay expectations. Registration endpoint (`POST /api/agents`) and status code handling (`200 | 201`) are correct.

2. **Defensive message parsing.** `parseMailboxEntry` gracefully handles missing fields with `|| ({} as ...)` fallback chaining, and the poll loop skips entries without `senderAgentId`. This matches the Python client's defensive parsing style.

3. **Channel pattern compliance.** The `conversationKey`/`parseConversationKey` implementation with the `agentmsg:v1:` prefix, round-trip assertion, and `encodeURIComponent`-based encoding follows the exact pattern used by `@flue/a2a`, `@flue/slack`, and `@flue/telegram` channels.

4. **Clean separation of concerns.** The code is well-organized into logical sections (errors, HTTP helpers, message parsing, envelope construction, channel factory, send tool, catalog, validation). The `createAgentMsgSendTool` factory is independent from the channel and can be used standalone — good composability.

5. **Webhook dual-format handling.** The webhook handler (lines 402-418) correctly handles both mailbox entry format (with `a2a_payload`) and raw envelope format (with `params`). This is forward-thinking for relay push delivery flexibility.

6. **Solid input validation.** `validateOptions`, `assertOption`, `assertRef`, and `assertIdentifier` provide clear error messages. The `assertIdentifier` check for untrimmed strings prevents subtle bugs with whitespace-padded agent IDs.

7. **TypeScript types are comprehensive.** The `types.ts` file provides complete typing for the AgentMsg protocol surface, including all request/response shapes. Types are well-documented with JSDoc comments.

---

## Verification Story

- **Tests reviewed:** No — no test files exist in the package
- **Build verified:** Yes — `tsc --noEmit` passes clean
- **Lint/static analysis clean:** Yes — no type errors
- **Security checked:** Yes — no credential exposure found; `relayUrl` is config-provided, not hardcoded; `agentId` is used in URL paths with `encodeURIComponent`; webhook handler validates JSON input. Missing HTTP timeouts noted as Important (Issue #3).
- **Protocol verified:** Cross-referenced envelope format, endpoint paths, status codes, and ack semantics against the Python reference client and the Elixir relay backend source code.

---

## Summary Table

| # | Severity | File:Line | Issue |
|---|----------|-----------|-------|
| 1 | **Critical** | index.ts:355-357 | Incorrect ack comment — DELIVERED messages ARE redelivered; ack failure causes duplicates |
| 2 | **Critical** | index.ts:438-447 | Same ack issue in webhook handler |
| 3 | **Important** | index.ts:158-184 | No HTTP timeout — hanging relay blocks poll loop indefinitely |
| 4 | **Important** | index.ts:610 | Send tool ignores AbortSignal |
| 5 | **Important** | index.ts:486-495 | Initial poll error silently swallowed |
| 6 | **Important** | (package) | No test coverage |
| 7 | Suggestion | index.ts:317-319 | Document single-thread assumption for poll guard |
| 8 | Suggestion | index.ts:326-328 | "Log" comment but no actual logging |
| 9 | Suggestion | index.ts:247-252 | 32-bit entropy for IDs — low collision resistance |
| 10 | Suggestion | index.ts:586 | Tool schema missing `additionalProperties: false` |
| 11 | Suggestion | index.ts:297 | Card URL points to relay — add explanatory comment |
| 12 | Suggestion | index.ts:497-500 | `stop()` doesn't cancel in-flight requests |
| 13 | Suggestion | index.ts:640 | `/agents` vs `/api/agents` — just noting the split |
| 14 | Suggestion | types.ts:29 | `callback_url` defined in type but never sent in registration |
