---
title: createFlueClient(...)
description: Configure an SDK client for a deployed Flue application.
lastReviewedAt: 2026-06-02
---

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://example.com/api',
  token: process.env.FLUE_TOKEN,
});
```

## `createFlueClient(...)`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for the public and read-only admin routes of a deployed Flue application.

## `CreateFlueClientOptions`

| Field           | Type                    | Default                        | Description                                                                                                |
| --------------- | ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | `string`                | —                              | URL where the public `flue()` sub-app is mounted, including any pathname.                                  |
| `fetch`         | `typeof fetch`          | global `fetch`                 | Custom HTTP implementation.                                                                                |
| `headers`       | `RequestHeaders`        | —                              | Headers merged into each HTTP request.                                                                     |
| `token`         | `string`                | —                              | Bearer token added to HTTP requests.                                                                       |
| `adminBasePath` | `string`                | `'/admin'`                     | Origin-relative mount path for read-only admin routes.                                                     |
| `websocket`     | `WebSocketFactory`      | global `WebSocket` constructor | Custom WebSocket implementation.                                                                           |
| `websocketUrl`  | `WebSocketUrlTransform` | —                              | Transforms each WebSocket URL after HTTP protocol conversion, for example to add handshake authentication. |

## `RequestHeaders`

```ts
type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
```

Use a function to resolve headers separately for each HTTP request.
