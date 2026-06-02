---
title: client.runs
description: Inspect and stream workflow runs.
lastReviewedAt: 2026-06-02
---

Run APIs inspect workflow runs only. Direct agent prompts and dispatched agent inputs are not runs.

## `client.runs.get(...)`

```ts
get(runId: string): Promise<RunRecord>;
```

Retrieves one workflow-run record.

## `client.runs.events(...)`

```ts
events(runId: string, options?: RunEventsOptions): Promise<{ events: FlueEvent[] }>;
```

Retrieves recorded workflow-run events. `after` returns events strictly after one event index. `limit` defaults to `100` and accepts `1..1000`. Use `types` to select event types.

## `client.runs.stream(...)`

```ts
stream(runId: string, options?: RunStreamOptions): AsyncIterable<FlueEvent>;
```

Streams workflow-run events over server-sent events until `run_end`, cancellation, or an unrecoverable error. Interrupted streams resume after the latest received event index. A stream-infrastructure `event: error` frame carries `{ error: FluePublicError }`; the SDK rejects iteration with `error.message` rather than yielding the envelope as a workflow event.

### `RunStreamOptions`

| Option           | Type          | Default | Description                                                |
| ---------------- | ------------- | ------- | ---------------------------------------------------------- |
| `lastEventId`    | `number`      | —       | Resume after this event index.                             |
| `signal`         | `AbortSignal` | —       | Stop consuming events when aborted.                        |
| `maxRetries`     | `number`      | `3`     | Maximum reconnection attempts after an interrupted stream. |
| `initialRetryMs` | `number`      | `250`   | Initial reconnection delay in milliseconds.                |
