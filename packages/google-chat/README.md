# `@flue/google-chat`

Authenticated Google Chat interaction and Workspace Event ingress for Flue
applications.

```ts
import { createGoogleChatChannel } from '@flue/google-chat';

export const channel = createGoogleChatChannel({
  interactions: {
    authentication: {
      type: 'endpoint-url',
      audience: process.env.GOOGLE_CHAT_APP_URL!,
    },

    // Path: /channels/google-chat/interactions
    async handler({ event }) {
      await handleInteraction(event);
    },
  },
});
```

Place this export in `channels/google-chat.ts`. Flue discovers it and serves
`POST /channels/google-chat/interactions` relative to the `flue()` mount.

The package verifies Google-signed direct requests before normalizing messages,
space membership, card actions, app commands, app-home requests, form
submissions, and unknown verified interactions. An optional authenticated
`POST /channels/google-chat/events` route receives Google Workspace Events
delivered through Pub/Sub push.

This package does not include an outbound Chat client, credential storage,
Workspace Events subscription management, or model tools. Run
`flue add google-chat` to generate editable project code using a narrow
service-account OAuth and Chat REST client.

Conversation keys identify Google Chat spaces and threads. They are not
authorization capabilities. The package is stateless and does not deduplicate
interaction or Pub/Sub event ids.
