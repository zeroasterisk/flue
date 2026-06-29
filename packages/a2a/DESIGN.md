# A2A Channel for Flue — Design Document

## Overview

This package (`@flue/a2a`) implements an [A2A (Agent-to-Agent) protocol](https://a2a-protocol.org/v1.0.0/specification/) channel for the Flue agent framework. It follows the same structural pattern as `@flue/slack`, `@flue/github`, and other channel packages — pure HTTP ingress via Hono handlers with `conversationKey()` / `parseConversationKey()` for stable identity.

## Protocol Version

Targets A2A v1.0 (the current stable release under the Linux Foundation). Implements the **HTTP+JSON/REST protocol binding** — the simplest and most commonly deployed binding. JSON-RPC is also widely used but adds a framing layer; HTTP+JSON maps more naturally to Hono route handlers.

## How A2A Maps to Flue's Channel Pattern

### Channel Interface

```ts
interface A2AChannel<E extends Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: A2ATaskRef): string;
  parseConversationKey(id: string): A2ATaskRef;
}
```

### Routes

| Method | Path                          | A2A Operation         | Description                        |
|--------|-------------------------------|-----------------------|------------------------------------|
| GET    | `/.well-known/agent-card.json`| Agent Card discovery  | Serves generated Agent Card        |
| POST   | `/message/send`               | SendMessage           | Receive A2A message, return task   |
| GET    | `/tasks/:taskId`              | GetTask               | Get task status                    |
| POST   | `/tasks/:taskId/cancel`       | CancelTask            | Cancel a task                      |

Streaming (`/message/stream`, `/tasks/:taskId/subscribe`) and push notification config endpoints are deferred to v2.

### Conversation Key

The A2A `taskId` uniquely identifies an interaction. The conversationKey maps directly:

```
a2a:v1:<taskId>
```

`A2ATaskRef` is simply `{ taskId: string }`. Since A2A task IDs are server-generated UUIDs, they are globally unique and safe to use as conversation keys without additional namespacing.

When a client sends a message without a `taskId` (new conversation), the channel handler generates a task ID and returns it. The application callback then uses `conversationKey({ taskId })` to create or resume the Flue session.

## Ingress: A2A SendMessage → Flue Session

1. Client POSTs to `/message/send` with a `SendMessageRequest` body
2. Channel validates the request structure (message with role, parts, messageId)
3. Channel extracts text content from message parts
4. Channel calls the application's `onMessage` callback with `{ c, message, taskId, contextId }`
5. Application callback maps to a Flue session via `conversationKey()` and calls `session.prompt()`
6. The callback returns either a Task or Message response
7. Channel serializes the response as `SendMessageResponse`

## Task Lifecycle: A2A States ↔ Flue Sessions

| A2A TaskState              | Flue Session State    | Mapping                                    |
|----------------------------|-----------------------|--------------------------------------------|
| `TASK_STATE_SUBMITTED`     | Session created       | Initial state when message received        |
| `TASK_STATE_WORKING`       | Operation in progress | Session is processing a prompt             |
| `TASK_STATE_COMPLETED`     | Operation complete    | Session prompt returned a result           |
| `TASK_STATE_FAILED`        | Operation error       | Session prompt threw an error              |
| `TASK_STATE_INPUT_REQUIRED`| Awaiting user input   | Agent used a tool requesting user input    |
| `TASK_STATE_CANCELED`      | Session aborted       | CancelTask called, session.abort()         |
| `TASK_STATE_REJECTED`      | N/A (v2)             | Agent declines the task                    |
| `TASK_STATE_AUTH_REQUIRED`  | N/A (v2)             | Authentication needed                      |

The channel itself is stateless — it does not persist tasks. Task state management is the responsibility of the application layer using Flue's session durability features. The channel provides the HTTP surface; the application callback bridges to Flue sessions.

## Agent Card Generation

The `createA2AChannel()` function accepts an `agentCard` option — either a complete `AgentCard` object or a simplified config that generates one:

```ts
createA2AChannel({
  agentCard: {
    name: 'My Agent',
    description: 'Helps with tasks',
    version: '1.0.0',
    url: 'https://my-agent.example.com',
    skills: [
      { id: 'general', name: 'General', description: 'General assistance', tags: ['general'] }
    ],
  },
  onMessage({ c, message, taskId, contextId }) {
    // Bridge to Flue session
  },
})
```

The channel generates a conformant `AgentCard` JSON with:
- `supportedInterfaces` pointing to the configured URL with `HTTP+JSON` binding
- `capabilities` reflecting v1 support (no streaming/push notifications yet)
- `defaultInputModes` / `defaultOutputModes` as `["text/plain"]`
- `skills` from the provided config
- `version` and `protocolVersion: "1.0"`

## SDK Decision: Direct Implementation

For v1, the protocol is implemented directly rather than depending on `@a2a-js/sdk`. Rationale:

1. **Minimal surface**: v1 only needs SendMessage, GetTask, CancelTask, and Agent Card — ~200 lines of handler code
2. **No runtime dependency**: Channels in Flue are zero-dependency beyond `hono`
3. **Protocol stability**: A2A v1.0 is a stable spec; the shapes are well-defined in the proto
4. **SDK maturity**: `@a2a-js/sdk` is at 0.3.x and its API may still evolve

The channel defines TypeScript types matching the A2A proto definitions (using camelCase per the JSON serialization convention) and validates incoming requests structurally.

## Future Iterations

### v2 Candidates
- **Streaming**: SSE support for `SendStreamingMessage` and `SubscribeToTask`
- **Push notifications**: Webhook delivery for long-running tasks
- **Authentication**: Security scheme validation on incoming requests
- **Extended Agent Card**: Authenticated card endpoint
- **AgentMsg relay**: Transport option for agent-to-agent communication via relay

### Out of Scope (v1)
- Outbound A2A client (calling other A2A agents) — this would be a separate `defineTool()`, not part of the channel
- Task persistence — handled by Flue's durability layer
- Multi-tenant routing — the `tenant` field is accepted but not enforced
