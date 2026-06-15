---
title: flue add
description: Reference for discovering and applying Flue connector installation recipes.
lastReviewedAt: 2026-06-14
---

## Synopsis

```bash
flue add
flue add <category> <name-or-url> [--print]
```

## Description

`flue add` fetches Markdown installation instructions for a coding agent. It does not install packages or write project files itself.

With no arguments, the command lists known connectors. With a category and known connector name, it fetches that connector's recipe. With a category and absolute URL, it fetches the generic category recipe and uses the URL as the coding agent's research starting point. Paths are not accepted.

## Arguments

| Argument        | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| `<category>`    | Connector category: `sandbox`, `channel`, or `database`.                             |
| `<name-or-url>` | Known connector slug or alias, or an absolute URL used as a research starting point. |

## Options

| Option    | Description                                                               |
| --------- | ------------------------------------------------------------------------- |
| `--print` | Write raw recipe Markdown to stdout regardless of coding-agent detection. |

## Connector categories

| Category   | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `sandbox`  | Build a sandbox connector from provider documentation or source.   |
| `channel`  | Add verified provider ingress, an SDK client, and app-owned tools. |
| `database` | Add a database-backed persistence adapter.                         |

Run `flue add` without arguments to list the currently known connector recipes.

## Examples

```bash
flue add
flue add sandbox daytona --print
flue add sandbox daytona --print | claude
flue add channel github --print | codex
flue add channel stripe --print | codex
flue add channel notion --print | codex
flue add channel resend --print | codex
flue add channel shopify --print | codex
flue add channel intercom --print | codex
flue add channel zendesk --print | codex
flue add channel salesforce-marketing-cloud --print | codex
flue add channel slack --print | codex
flue add channel discord --print | codex
flue add channel teams --print | codex
flue add channel google-chat --print | codex
flue add channel linear --print | codex
flue add channel telegram --print | codex
flue add channel whatsapp --print | codex
flue add channel twilio --print | codex
flue add channel messenger --print | codex
flue add sandbox @cloudflare/shell --print | opencode
flue add database postgres --print | codex
flue add sandbox https://e2b.dev --print | claude
flue add channel https://provider.example/webhooks --print | codex
flue add database https://database.example/docs --print | codex
```

See [Sandboxes](/docs/guide/sandboxes/), [Channels](/docs/guide/channels/), and
the [Ecosystem](/docs/ecosystem/) for connector guidance.
