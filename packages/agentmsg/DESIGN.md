# @flue/agentmsg — AgentMsg Relay Channel

## Overview

AgentMsg is a store-and-forward relay for agent-to-agent messaging. Unlike the
direct A2A channel (`@flue/a2a`) which requires a public HTTP endpoint, AgentMsg
uses poll-based mailbox delivery — agents register, poll for messages, and send
via the relay. This enables communication for agents behind NAT.

## Protocol Summary

| Operation | Method | Endpoint | Purpose |
|-----------|--------|----------|---------|
| Register | POST | `/api/agents` | Register agent with relay |
| Send | POST | `/a2a` | Send JSON-RPC `message/send` envelope |
| Poll | GET | `/mailbox/{agent_id}` | Retrieve pending messages |
| Ack | POST | `/mailbox/{agent_id}/ack` | Acknowledge processed messages |
| Catalog | GET | `/agents` | List registered agents |

## Architecture

### Channel Pattern Compliance

Follows the standard Flue channel structural contract:
- `createAgentMsgChannel(options)` → `{ routes, conversationKey, parseConversationKey }`
- Routes are Hono handlers for optional webhook push delivery
- `conversationKey` maps sender agent IDs to stable Flue conversation keys

### Key Differences from Other Channels

1. **Poll-based ingress**: Unlike Slack/Telegram which receive webhooks, AgentMsg
   primarily uses polling. The channel starts a poll loop on creation that calls
   `GET /mailbox/{agent_id}` at a configurable interval (default 30s).

2. **Lifecycle management**: The channel registers the Flue agent on the relay at
   startup and provides `start()`/`stop()` methods to control the poll loop.

3. **Outbound tool**: Provides a `createAgentMsgSendTool()` factory that returns a
   `ToolDefinition` for agents to send messages to other agents via the relay.

### Conversation Key Scheme

```
agentmsg:v1:<sender_agent_id>
```

Uses the sender's agent ID as the conversation key. Each remote agent gets its
own conversation/session, with all messages from that agent routed to the same
Flue session.

### Message Flow

```
Inbound:
  AgentMsg Relay → poll loop → onMessage callback → Flue session.prompt()
                                                  ↑ conversationKey = sender_agent_id

Outbound:
  Agent tool call → agentmsg_send → POST /a2a → AgentMsg Relay → recipient mailbox
```

## File Structure

```
packages/agentmsg/
├── src/
│   ├── index.ts      # createAgentMsgChannel(), createAgentMsgSendTool(), exports
│   └── types.ts      # AgentMsg protocol types
├── package.json
├── tsconfig.json
├── tsdown.config.ts
└── DESIGN.md
```

## Configuration

```ts
createAgentMsgChannel({
  // Required
  relayUrl: 'https://agentmsg-relay.example.com',
  agentId: 'my-flue-agent',
  displayName: 'My Flue Agent',
  onMessage: ({ c, message, senderAgentId }) => { ... },

  // Optional
  pollIntervalMs: 30_000,    // default 30s
  agentCard: { ... },        // extra agent card fields
})
```

## Tool Definition

```ts
createAgentMsgSendTool({
  relayUrl: 'https://agentmsg-relay.example.com',
  agentId: 'my-flue-agent',
})
```

Creates a `ToolDefinition` named `agentmsg_send` that agents can call with
`{ to: "<target_agent_id>", message: "<text>" }`.
