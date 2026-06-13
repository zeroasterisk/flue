# Google Chat channel example

This example shows a verified Google Chat interaction route, a project-owned
Fetch client that authenticates with a service account, and an application-owned
message tool.

Required environment variables:

```sh
GOOGLE_CHAT_APP_URL=https://example.com/channels/google-chat/interactions
GOOGLE_CHAT_CLIENT_EMAIL=chat-app@example-project.iam.gserviceaccount.com
GOOGLE_CHAT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n'
```

The direct interaction route is:

```txt
POST /channels/google-chat/interactions
```

The optional authenticated Pub/Sub route for Google Workspace Events is:

```txt
POST /channels/google-chat/events
```
