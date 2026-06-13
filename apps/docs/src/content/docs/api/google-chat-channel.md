---
title: Google Chat Channel API
description: Reference for authenticated Google Chat ingress from @flue/google-chat.
lastReviewedAt: 2026-06-13
---

Import from `@flue/google-chat`.

## `createGoogleChatChannel()`

```ts
function createGoogleChatChannel<E extends Env = Env>(
  options: GoogleChatChannelOptions<E>,
): GoogleChatChannel<E>;
```

Creates stateless direct-interaction and optional Workspace Event routes. At
least one surface is required.

## `GoogleChatChannelOptions`

```ts
interface GoogleChatChannelOptions<E extends Env = Env> {
  interactions?: {
    authentication: GoogleChatInteractionAuthentication;
    handler(input: GoogleChatInteractionHandlerInput<E>): GoogleChatHandlerResult;
  };
  workspaceEvents?: {
    authentication: GoogleChatPubSubAuthentication;
    handler(input: GoogleChatWorkspaceEventHandlerInput<E>): GoogleChatHandlerResult;
  };
  fetch?: typeof globalThis.fetch;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
}
```

| Field              | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `interactions`     | Publishes `POST /interactions` for direct Chat callbacks.  |
| `workspaceEvents`  | Publishes `POST /events` for authenticated Pub/Sub push.   |
| `fetch`            | Fetch used only for Google signing-key discovery.          |
| `bodyLimit`        | Maximum request body. Default: 1 MiB.                      |
| `handlerTimeoutMs` | Direct interaction deadline. Default: 25 seconds; max: 30. |

```ts
type GoogleChatHandlerResult = void | JsonValue | Response | Promise<void | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. An ordinary Hono or Fetch `Response` passes through unchanged.

## Interaction authentication

```ts
type GoogleChatInteractionAuthentication =
  | {
      type: 'endpoint-url';
      audience: string;
      jwksUrl?: string;
    }
  | {
      type: 'project-number';
      projectNumber: string;
      certificatesUrl?: string;
    };
```

`endpoint-url` verifies a Google OIDC token for the exact configured HTTPS
audience and `chat@system.gserviceaccount.com` identity. `project-number`
verifies Google's Chat service token against the configured numeric project
number and Chat service-account certificates.

The discovery URL overrides are intended for supported Google environments and
local protocol tests.

## Pub/Sub authentication

```ts
interface GoogleChatPubSubAuthentication {
  subscription: string;
  audience: string;
  serviceAccountEmail: string;
  jwksUrl?: string;
}
```

`subscription` is the exact
`projects/<project>/subscriptions/<subscription>` resource expected in push
bodies. The token must have the configured audience and verified
service-account identity. `jwksUrl` overrides Google's OIDC JWKS endpoint.

## `GoogleChatChannel`

```ts
interface GoogleChatChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: GoogleChatConversationRef): string;
  parseConversationKey(id: string): GoogleChatConversationRef;
}
```

`routes` contains only configured surfaces. A file named
`channels/google-chat.ts` serves `/channels/google-chat/interactions` and
optionally `/channels/google-chat/events` relative to the `flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.

## Direct interactions

```ts
type GoogleChatInteraction =
  | GoogleChatMessageInteraction
  | GoogleChatAddedToSpaceInteraction
  | GoogleChatRemovedFromSpaceInteraction
  | GoogleChatCardClickedInteraction
  | GoogleChatAppCommandInteraction
  | GoogleChatAppHomeInteraction
  | GoogleChatSubmitFormInteraction
  | GoogleChatUnknownInteraction;
```

Known `type` values are `message`, `added_to_space`, `removed_from_space`,
`card_clicked`, `app_command`, `app_home`, and `submit_form`. Unsupported
authenticated types use `type: 'unknown'` and retain `interactionType`.

Every interaction includes its complete parsed provider value as `raw`.
Applicable variants expose the event time, normalized user, destination,
message fields, action parameters and form inputs, or app-command metadata.

## Workspace Events

`GoogleChatWorkspaceEvent` includes typed message, membership, reaction, space,
and subscription-lifecycle variants. Every event exposes:

```ts
interface GoogleChatWorkspaceEventEnvelope<TType extends string> {
  type: TType;
  eventType: string;
  attributes: GoogleChatCloudEventAttributes;
  pubsubMessageId: string;
  publishTime?: string;
  orderingKey?: string;
  destination?: GoogleChatConversationRef;
  data: unknown;
  raw: unknown;
}
```

`eventType` retains the provider CloudEvent type. `data` is the decoded JSON
resource payload. `destination` is absent for subscription lifecycle events.
Unsupported authenticated event types use `type: 'unknown'`.

## Identity

```ts
interface GoogleChatConversationRef {
  space: string;
  thread?: string;
  spaceType?: 'SPACE' | 'GROUP_CHAT' | 'DIRECT_MESSAGE' | 'UNKNOWN';
}

interface GoogleChatUserRef {
  name: string;
  displayName?: string;
  type?: string;
  domainId?: string;
}
```

Space names use `spaces/<id>`. Thread names use
`spaces/<id>/threads/<thread-id>`. Canonical conversation keys include only
the stable space and thread names; `spaceType` is descriptive metadata.

## Errors

- `InvalidGoogleChatConversationKeyError`
- `InvalidGoogleChatInputError`, with structured `field`

See [Google Chat setup](/docs/guide/channels/google-chat/) for the project-owned
service-account Fetch client and optional Workspace Events composition.
