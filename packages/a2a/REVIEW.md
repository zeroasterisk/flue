# A2A Channel Review

**Verdict:** REQUEST CHANGES

**Overview:** This is a well-structured first implementation of an A2A protocol channel for Flue that closely follows established channel patterns (Slack, GitHub). However, several protocol compliance issues with the A2A v1.0 spec, a missing authentication story, error response format deviations, and the absence of any test coverage require attention before merge.

---

## Critical Issues

### C1. URL paths deviate from the A2A HTTP+JSON/REST binding spec

**Files:** `src/index.ts:170-195`, `src/handlers.ts`

The A2A spec (Section 11.3) defines the HTTP+JSON/REST binding endpoints using Google API-style action verbs:

| This impl              | A2A Spec                  |
|-------------------------|---------------------------|
| `POST /message/send`    | `POST /message:send`      |
| `GET /tasks/:taskId`    | `GET /tasks/{id}`         |
| `POST /tasks/:taskId/cancel` | `POST /tasks/{id}:cancel` |

The spec uses **colon-prefixed action verbs** (`/message:send`, `/tasks/{id}:cancel`) per Google API conventions, not slash-separated sub-resources. A client implementing the spec will POST to `/message:send` and get a 404 on this server.

**Suggested Fix:**
```typescript
// index.ts
routes.push({
  method: 'POST',
  path: '/message\\:send',   // or encode appropriately for Hono
  handler: createSendMessageHandler<E>({...}),
});

// For cancel:
routes.push({
  method: 'POST',
  path: '/tasks/:taskId\\:cancel',
  handler: createCancelTaskHandler<E>({...}),
});
```

Note: Hono's router may require escaping or a different approach for the colon syntax. Verify with Hono's route matching behavior. If Hono cannot handle this, document the deviation explicitly and consider a middleware rewrite.

---

### C2. Error response format does not match the A2A HTTP+JSON/REST binding

**Files:** `src/handlers.ts:114-128`, `src/handlers.ts:159-167`, `src/handlers.ts:219-238`, `src/handlers.ts:281-286`

The spec (Section 11.6) requires the HTTP+JSON error format to use `google.rpc.Status` JSON representation:

```json
{
  "error": {
    "code": 404,
    "status": "NOT_FOUND",
    "message": "The specified task ID does not exist",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "TASK_NOT_FOUND",
        "domain": "a2a-protocol.org"
      }
    ]
  }
}
```

The current implementation uses a non-standard flat format:
```json
{ "type": "...", "title": "...", "status": 404, "detail": "..." }
```

This appears to be RFC 9457 (Problem Details for HTTP APIs), which is not what the A2A spec requires. A spec-compliant A2A client will not be able to parse these errors.

**Suggested Fix:** Create a helper that produces `google.rpc.Status`-shaped responses:

```typescript
function a2aErrorResponse(
  httpStatus: number,
  statusName: string,
  message: string,
  reason?: string,
): Response {
  const body: Record<string, unknown> = {
    error: {
      code: httpStatus,
      status: statusName,
      message,
      details: reason
        ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }]
        : [],
    },
  };
  return Response.json(body, {
    status: httpStatus,
    headers: { 'Content-Type': 'application/a2a+json' },
  });
}
```

---

### C3. `TaskNotCancelableError` maps to wrong HTTP status code

**File:** `src/handlers.ts:229-238`

The handler returns HTTP 409 Conflict, but the A2A spec (Section 5.4) maps `TaskNotCancelableError` to **400 Bad Request**:

| A2A Error Type        | HTTP Status (spec) | HTTP Status (impl) |
|-----------------------|-------------------|-------------------|
| `TaskNotCancelableError` | 400 Bad Request   | 409 Conflict      |

**Suggested Fix:** Change status to 400.

---

### C4. No authentication or request verification

**Files:** `src/index.ts`, `src/handlers.ts`

The Slack channel has HMAC signature verification; the GitHub channel has `X-Hub-Signature-256` verification. This A2A channel has **no authentication mechanism whatsoever**. The A2A spec (Section 8/13) requires agents to declare security schemes in the Agent Card and enforce them.

While the DESIGN.md acknowledges this is deferred to v2, for a `1.0.0-beta.1` package, shipping a public HTTP endpoint with no authentication middleware, no auth hook point, and no documentation warning is a security risk. Any internet-facing deployment is completely unprotected.

**Suggested Fix:** At minimum:
1. Add an optional `authenticate` callback to `A2AChannelOptions` that receives the Hono `Context` and can reject unauthenticated requests (similar pattern to the signing secret in Slack).
2. Add a bold warning in DESIGN.md / JSDoc that this channel has no built-in auth.
3. Consider supporting `securitySchemes` in the agent card config.

---

## Important Issues

### I1. Missing `ListTasks` operation

**File:** `src/index.ts`

The A2A spec defines `ListTasks` as a core operation (Section 3.1.4). The implementation skips it entirely. While `GetTask` and `CancelTask` are optional in this channel, `ListTasks` is described as a core operation that "all A2A implementations must support." At minimum, if not implemented, the endpoint should return `UnsupportedOperationError` (400) rather than being absent (404).

**Suggested Fix:** Either implement `GET /tasks` with pagination support, or register a stub route that returns `UnsupportedOperationError`.

---

### I2. No test coverage

The Slack channel has comprehensive tests (`test/index.test.ts`, `test-workerd/index.test.ts`). This package has zero test files. For a protocol implementation, tests are essential to verify:
- Agent card serialization
- Request validation (missing fields, wrong content-type, oversized body)
- `conversationKey()` / `parseConversationKey()` roundtrip
- Error response format
- Handler callback invocation with correct parameters
- Cancel task state validation logic

**Suggested Fix:** Add `test/index.test.ts` with at least the patterns seen in the Slack channel tests: route exposure, request validation, callback invocation, and conversation key roundtrip.

---

### I3. `Part` type uses a flat structure instead of the spec's `oneof` content

**File:** `src/types.ts:14-29`

The proto definition uses a `oneof content` for Part — meaning exactly one of `text`, `raw`, `url`, or `data` should be present. The TypeScript type makes all four optional, which allows invalid states like `{ text: "hello", url: "https://..." }` simultaneously.

**Suggested Fix:** Use a discriminated union type:
```typescript
export type A2APart = A2APartBase & (
  | { text: string; raw?: never; url?: never; data?: never }
  | { text?: never; raw: string; url?: never; data?: never }
  | { text?: never; raw?: never; url: string; data?: never }
  | { text?: never; raw?: never; url?: never; data: unknown }
);

interface A2APartBase {
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}
```

---

### I4. Agent card JSON is serialized once at construction time

**File:** `src/handlers.ts:25-33`

```typescript
const cardJson = JSON.stringify(options.agentCard);
// ...
return (c) => {
  return c.newResponse(cardJson, { status: 200, headers });
};
```

The agent card is serialized once and the string is captured in the closure. This is efficient (good), but means the card can never be updated at runtime. This is consistent with the Slack channel pattern (the signing secret is also captured once), so it aligns with the Flue convention. However, if the agent card includes dynamic fields (e.g., a URL that depends on the request host), this will be incorrect.

This is acceptable for v1, but document the limitation.

---

### I5. Cancel handler validates state *after* the callback runs

**File:** `src/handlers.ts:229`

```typescript
const task = await options.onCancelTask({ c, taskId, metadata });
if (!task) { ... }
if (task.status && TERMINAL_TASK_STATES.has(task.status.state) && task.status.state !== 'TASK_STATE_CANCELED') {
  return Response.json({ type: A2A_ERROR_TYPES.TASK_NOT_CANCELABLE, ... }, { status: 409 });
}
```

The handler calls `onCancelTask` first, then checks if the returned task is in a terminal state. But by then, the callback has already executed — potentially performing side effects (e.g., aborting a session). The state check should happen *before* calling the callback, or the callback contract should specify it handles state validation internally.

**Suggested Fix:** Either:
1. Pass the current task state into the handler for pre-validation, or
2. Document that `onCancelTask` is responsible for checking the state and throwing `A2AProtocolError` if not cancelable, and remove the post-hoc check.

---

### I6. `A2A_ERROR_TYPES` values use made-up URIs

**File:** `src/types.ts:249-255`

```typescript
export const A2A_ERROR_TYPES = {
  TASK_NOT_FOUND: 'https://a2a-protocol.org/errors/task-not-found',
  TASK_NOT_CANCELABLE: 'https://a2a-protocol.org/errors/task-not-cancelable',
  ...
} as const;
```

The A2A spec (Section 11.6) uses `google.rpc.ErrorInfo` with a `reason` field in `UPPER_SNAKE_CASE` (e.g., `"TASK_NOT_FOUND"`) and a `domain` of `"a2a-protocol.org"`. It does not define error type URIs. These URIs appear to be RFC 9457-style, which is not the A2A error format.

**Suggested Fix:** Use the spec-defined error reasons:
```typescript
export const A2A_ERROR_REASONS = {
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_NOT_CANCELABLE: 'TASK_NOT_CANCELABLE',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  CONTENT_TYPE_NOT_SUPPORTED: 'CONTENT_TYPE_NOT_SUPPORTED',
  VERSION_NOT_SUPPORTED: 'VERSION_NOT_SUPPORTED',
} as const;
```

---

### I7. `SendMessageRequest` validation does not check for messages to tasks in terminal state

**File:** `src/handlers.ts:94-98`

The spec (Section 3.1.1) explicitly states that sending a message to a task in a terminal state MUST return `UnsupportedOperationError`. The handler code has a comment about this but no implementation:

```typescript
// If a taskId is present, check that it's not pointing to a terminal task
// (The application callback is responsible for task state management,
// but we validate at the protocol level when the task state is provided)
const taskId = message.taskId;
```

The comment says to validate at the protocol level, but no validation occurs. This is a spec compliance gap.

**Suggested Fix:** Either implement the check (requires a way to look up task state), or update the comment to explicitly document this is delegated to the `onMessage` callback.

---

## Suggestions

### S1. Consider adding the `A2A-Version` service parameter support

The spec (Section 3.2.6, 11.2) defines `A2A-Version` as a service parameter transmitted via HTTP headers. The implementation doesn't read or validate this. For v1, at minimum log or pass it through to the callback.

### S2. `readBody` allocates intermediate arrays unnecessarily

**File:** `src/handlers.ts:288-314`

The function collects chunks into an array, then copies them into a final `Uint8Array`. For small payloads (the common case with a 1 MiB limit), this is fine. But the copy loop could be avoided using `Response.arrayBuffer()` or `request.arrayBuffer()` with a size check on `Content-Length` first.

### S3. `serializeResponse` uses `Object.prototype.toString` for Response detection

**File:** `src/handlers.ts:274`

```typescript
if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
```

This is consistent with the Slack channel's `serializeHandlerResult` pattern, so it's a known convention. However, `value instanceof Response` would be more readable. The `toString` approach is likely used to handle cross-realm Response objects — if that's intentional, add a comment explaining why.

### S4. `isFullAgentCard` discriminator is fragile

**File:** `src/index.ts:227-229`

```typescript
function isFullAgentCard(card): card is A2AAgentCard {
  return 'supportedInterfaces' in card;
}
```

This works because `A2AAgentCardConfig` doesn't have `supportedInterfaces`. But if someone passes a config object that happens to have this property, it'll be treated as a full card without validation.

### S5. Missing `SendStreamingMessage` endpoint or explicit rejection

The spec requires that if streaming is not supported, attempts to use `SendStreamingMessage` MUST return `UnsupportedOperationError`. The agent card declares `streaming: false`, but there's no `POST /message:stream` route to return the proper error. A spec-compliant client might try this endpoint and get a 404 instead of a proper A2A error.

### S6. `historyLength` validation in GetTask doesn't handle negative values

**File:** `src/handlers.ts:148-150`

The spec (Section 3.2.4) allows negative `historyLength` values to mean "last N messages." The `parseNonNegativeInteger` function rejects negative values, which means the spec's negative-value semantics cannot be used.

---

## What's Done Well

1. **Excellent channel pattern conformance:** The structure closely mirrors `@flue/slack` and `@flue/github` — same `ChannelRoute` type, same `conversationKey()`/`parseConversationKey()` roundtrip pattern with encode/decode and re-encode validation, same error class naming convention. This will feel immediately familiar to Flue developers.

2. **Careful body size enforcement:** The streaming `readBody` implementation with chunk-level size checking prevents memory exhaustion from oversized payloads, exactly matching the Slack channel's approach. The Content-Length pre-check is also a nice optimization.

3. **Clean handler factoring:** Separating `createAgentCardHandler`, `createSendMessageHandler`, `createGetTaskHandler`, and `createCancelTaskHandler` into individual factory functions makes each handler testable in isolation.

4. **Good agent card normalization:** The simplified `A2AAgentCardConfig` type that auto-expands into a full `A2AAgentCard` is a thoughtful DX touch that reduces boilerplate for the common case.

5. **Thorough input validation in `createA2AChannel`:** Card fields (name, description, version, url, skills) are all validated at construction time with clear error messages, failing fast rather than serving a broken card.

6. **Well-written DESIGN.md:** The design document clearly explains the mapping between A2A concepts and Flue channels, justifies the direct implementation decision, and scopes v2 explicitly.

---

## Verification Story

- **Tests reviewed:** No tests exist. This is a gap — every other channel package has tests.
- **Build verified:** Not attempted (no build artifacts present; `tsdown` config exists).
- **Lint/static analysis clean:** Not attempted (TypeScript `check:types` script defined but not run).
- **Security checked:** Yes — no authentication mechanism exists (Critical C4). No injection risks in current code. Body limits are properly enforced.
- **A2A spec compliance checked:** Yes — against the v1.0.0 specification proto and Section 11 HTTP+JSON binding. Multiple deviations identified (C1, C2, C3, I6).
