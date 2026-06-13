---
title: Google Chat
description: Receive authenticated Google Chat interactions and Workspace Events with a project-owned REST client.
---

## Add Google Chat

Run the Google Chat recipe through your coding agent:

```sh
flue add google-chat --print | codex
```

It installs `@flue/google-chat` for authenticated ingress and creates a
project-owned Fetch client for outbound messages.

Google's current `google-auth-library` package targets Node and brings
Node-oriented authentication and HTTP dependencies. The recipe uses Google's
documented service-account JWT assertion, OAuth token exchange, and Chat REST
protocols through Fetch so the integration runs on Node and Cloudflare Workers.

Set the Google Chat app's HTTP endpoint URL to:

```txt
https://example.com/channels/google-chat/interactions
```

Set `GOOGLE_CHAT_APP_URL` to that exact URL.
`GOOGLE_CHAT_CLIENT_EMAIL` and `GOOGLE_CHAT_PRIVATE_KEY` authenticate the
project-owned outbound client.

## Channel module

```ts title="src/channels/google-chat.ts"
import { createGoogleChatChannel, type GoogleChatConversationRef } from '@flue/google-chat';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createGoogleChatClient } from '../lib/google-chat-client.ts';

const appUrl = process.env.GOOGLE_CHAT_APP_URL!;

export const client = createGoogleChatClient({
  clientEmail: process.env.GOOGLE_CHAT_CLIENT_EMAIL!,
  privateKey: process.env.GOOGLE_CHAT_PRIVATE_KEY!,
});

export const channel = createGoogleChatChannel({
  interactions: {
    authentication: {
      type: 'endpoint-url',
      audience: appUrl,
    },

    // Path: /channels/google-chat/interactions
    async handler({ event }) {
      switch (event.type) {
        case 'message':
        case 'app_command': {
          if (!event.destination) return;
          await dispatch(assistant, {
            id: channel.conversationKey(event.destination),
            input: {
              type: `google-chat.${event.type}`,
              user: event.user,
              payload: event.payload,
            },
          });
          return;
        }
        default:
          return;
      }
    },
  },
});

export function postMessage(ref: GoogleChatConversationRef) {
  return defineTool({
    name: 'post_google_chat_message',
    description: 'Post to the Google Chat conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const message = await client.postMessage(ref, text);
      return JSON.stringify({ message: message.name });
    },
  });
}
```

The generated `lib/google-chat-client.ts` signs a short-lived service-account
assertion, exchanges it for a `chat.bot` access token, caches the token, and
sends messages to the trusted space and thread.

Direct interactions have typed message, space-membership, card-action,
app-command, app-home, and form-submit variants. Other authenticated types use
`type: 'unknown'`. Return nothing for an empty `200`, return JSON for a Google
Chat response body, or use the Hono context for explicit status control.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/google-chat.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The model selects only message text. Trusted code binds the service account,
space, and thread.

Conversation keys validate syntax, not authorization. Keep this agent
dispatch-only, or independently authorize caller-selected instance ids before
using them for outbound requests.

## Workspace Events

Direct interactions cover messages sent to the app, mentions, space
membership changes involving the app, and interactive actions. To receive
broader space activity such as all messages, reactions, membership changes, or
space updates, create a Google Workspace Events subscription backed by an
authenticated Pub/Sub push subscription.

Enable the optional route in the channel:

```ts
workspaceEvents: {
  authentication: {
    subscription: process.env.GOOGLE_CHAT_PUBSUB_SUBSCRIPTION!,
    audience: process.env.GOOGLE_CHAT_PUBSUB_AUDIENCE!,
    serviceAccountEmail: process.env.GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT!,
  },

  // Path: /channels/google-chat/events
  async handler({ event }) {
    await handleWorkspaceEvent(event);
  },
},
```

The subscription must match the exact
`projects/<project>/subscriptions/<subscription>` resource in the push body.
The audience and service-account email must match the authenticated push
subscription's OIDC configuration. Flue also validates the CloudEvent source,
subject, event type, and resource relationship before invoking the handler.

Workspace Events expire and can be suspended. The route forwards typed
subscription lifecycle events so application code can renew or repair the
subscription. Creating subscriptions, domain-wide delegation, impersonation,
and durable subscription state remain application concerns.

## Authentication

For endpoint-URL authentication, `@flue/google-chat` verifies:

- Google's `RS256` signing key and signature;
- the Google issuer, exact endpoint URL audience, and expiration;
- the verified `chat@system.gserviceaccount.com` identity.

The package also supports Google's project-number token format with
`authentication: { type: 'project-number', projectNumber }`.

For Workspace Events, the package independently verifies the Pub/Sub push OIDC
token's issuer, audience, expiration, and configured service-account identity.

The package does not deduplicate interaction ids, Pub/Sub message ids, or
CloudEvent ids. Claim the relevant id in application-owned durable storage
before dispatch when duplicate admission is unacceptable.

See the [`@flue/google-chat` API reference](/docs/api/google-chat-channel/).
