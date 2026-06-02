---
title: WebSocket protocol
description: SDK WebSocket configuration and low-level protocol types.
lastReviewedAt: 2026-06-02
---

Agent and workflow socket URLs inherit the public mount pathname from `baseUrl`. HTTP URLs are converted to `ws:` or `wss:` URLs before applying `websocketUrl`.

`token` and `headers` apply only to HTTP requests. Browser socket authentication should use cookies or an application-designed URL transformation through `websocketUrl`. Node consumers that need implementation-specific handshake headers can supply a custom `websocket` factory.

## `WebSocketLike`

```ts
interface WebSocketLike {
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
```

Minimal socket interface required by the client SDK.

## WebSocket configuration types

| Type                    | Description                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| `WebSocketFactory`      | Creates a socket for a fully resolved WebSocket URL.                         |
| `WebSocketTarget`       | Identifies the agent or workflow route that a WebSocket URL will connect to. |
| `WebSocketUrlTransform` | Transforms a WebSocket URL before connection.                                |

## WebSocket listener types

| Type                          | Description                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `AgentSocketEventListener`    | Receives direct-agent events and prompt correlation metadata.     |
| `WorkflowSocketEventListener` | Receives workflow-run events and invocation correlation metadata. |
| `SocketEventListener`         | Union of the agent and workflow listener types.                   |
| `AgentSocketEventContext`     | Contains the prompt `requestId`.                                  |
| `WorkflowSocketEventContext`  | Contains the invocation `requestId` and workflow `runId`.         |
| `SocketEventContext`          | Union of the agent and workflow event-context types.              |
| `SocketInvokeResult`          | Union of the agent and workflow invocation-result types.          |

## Low-level WebSocket protocol

Most consumers should use `AgentSocket` and `WorkflowSocket`. Low-level protocol consumers can use the exported message types:

| Type                               | Description                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `AgentWebSocketClientMessage`      | Messages sent over an agent WebSocket.                      |
| `AgentWebSocketServerMessage`      | Messages received from an agent WebSocket.                  |
| `WorkflowWebSocketClientMessage`   | Message sent over a workflow WebSocket.                     |
| `WorkflowWebSocketServerMessage`   | Messages received from a workflow WebSocket.                |
| `WebSocketServerMessage`           | Union of agent and workflow server messages.                |
| `WebSocketErrorMessage`            | Connection- or request-scoped socket error message.         |
| `WorkflowRunWebSocketErrorMessage` | Workflow-run-scoped socket failure after run id allocation. |
