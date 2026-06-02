---
title: client.workflows
description: Start workflow invocations over WebSockets.
lastReviewedAt: 2026-06-02
---

## `client.workflows.connect(...)`

```ts
connect(name: string): WorkflowSocket;
```

Opens a WebSocket connection for one workflow invocation.

### `WorkflowSocket`

```ts
interface WorkflowSocket {
  readonly ready: Promise<void>;
  readonly runId: Promise<string>;
  invoke(payload?: unknown): Promise<WorkflowSocketInvokeResult>;
  onEvent(listener: WorkflowSocketEventListener): () => void;
  close(code?: number, reason?: string): void;
}
```

`ready` resolves after the server accepts the connection. A workflow socket accepts only one `invoke()` call. `runId` resolves after that invocation is admitted, before the terminal result arrives. Start the invocation before awaiting `runId`:

```ts
const workflow = client.workflows.connect('summarize');
await workflow.ready;

const completion = workflow.invoke({ text: 'Summarize me' });
const runId = await workflow.runId;

console.log('admitted run', runId);
console.log(await completion);
```

`runId` rejects if the socket closes or the invocation fails before admission. Once resolved, it remains available if the initiating socket later disconnects. `onEvent()` subscribes to workflow-run events and returns an unsubscribe function. `close()` rejects pending work.

### `WorkflowSocketInvokeResult`

```ts
interface WorkflowSocketInvokeResult {
  result: unknown;
  runId: string;
}
```
