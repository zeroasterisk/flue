---
title: Errors
description: SDK HTTP, WebSocket, and stream error types.
lastReviewedAt: 2026-06-02
---

See [Errors Reference](/docs/api/errors-reference/) for shared transport envelopes and stable public error categories.

## `FlueApiError`

```ts
class FlueApiError extends Error {
  readonly status: number;
  readonly body: unknown;
}
```

Failed SDK HTTP JSON request. `status` is the HTTP response status. `body` is the parsed response body when available, or the response text otherwise. Framework-owned routes normally return `{ error: FluePublicError }`; application-owned middleware may return arbitrary bodies.

## `FlueSocketError`

```ts
class FlueSocketError extends Error {
  readonly error: FluePublicError;
  readonly requestId: string | undefined;
  readonly runId: string | undefined;
}
```

Structured server error received over a WebSocket connection. An operation-scoped error rejects the matching request. An unscoped socket error closes the connection and rejects pending work.

## `FluePublicError`

```ts
interface FluePublicError {
  type: string;
  message: string;
  details: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

Structured server error data used by socket errors and protocol messages.

## `AttachedAgentStreamError`

```ts
interface AttachedAgentStreamError {
  type: 'error';
  instanceId: string;
  error: FluePublicError;
}
```

Structured error envelope received while streaming a direct agent interaction. The stream throws `error.message` rather than yielding this envelope.
