# @flue/ard — Agentic Resource Discovery

## Overview

This package integrates the ARD (Agentic Resource Discovery) protocol with the Flue agent framework. It enables Flue agents to:

1. **Self-publish** — Generate and serve `/.well-known/ai-catalog.json` from an agent definition
2. **Discover** — Search ARD-compatible registries for agents, tools, and skills
3. **Look up** — Resolve specific agents by URN identifier or URL

## Architecture

The package follows the Flue channel/package pattern (like `@flue/a2a`):

```
@flue/ard
├── src/
│   ├── index.ts      # Public API: routes, tools, re-exports
│   ├── types.ts      # AI Catalog + Agent Finder types
│   ├── catalog.ts    # Catalog generation from agent config
│   └── search.ts     # Search/discovery HTTP client
├── package.json
├── tsconfig.json
└── DESIGN.md
```

### Dependencies

- **hono** — Route handlers follow the Flue `ChannelRoute` structural pattern
- **valibot** — Input schemas for tools, matching the Flue `ToolDefinition` type

No dependency on `@flue/runtime` — tool definitions are structurally compatible with `ToolDefinition` without importing the type. This keeps the package lightweight and decoupled.

## Design Decisions

### Structural typing for tools

Rather than depending on `@flue/runtime` for `defineTool()`, the package creates tool objects that are structurally compatible with Flue's `ToolDefinition` interface. This:

- Avoids a circular or heavyweight dependency on the runtime
- Matches the pattern used by channel packages (which are decoupled from runtime)
- Still composes seamlessly: tools can be passed to `defineAgent({ tools: [...] })`

### Catalog generation strategy

The catalog generator maps Flue agent properties to AI Catalog entries:

| Flue Concept | AI Catalog Mapping |
|---|---|
| Agent name + publisher | URN identifier: `urn:ai:<publisher>:<namespace>:<name>` |
| Agent description | Entry `description` |
| Agent version | Entry `version` |
| Agent skills | Nested catalog entries with type `text/markdown; profile=ai-skill` |
| Agent tools | Nested catalog entries with type `application/mcp-server+json` |

When an agent has skills or tools, the primary entry becomes a nested catalog (`application/ai-catalog+json`) containing:
- The agent endpoint entry
- Individual entries for each skill/tool

When an agent has no sub-capabilities, it's a flat entry pointing directly at the agent URL.

### URN format

Follows the Agent Finder convention:

```
urn:ai:<publisher>:<namespace>:<name>
```

- `publisher` — domain name of the organization (e.g., `acme.com`)
- `namespace` — optional hierarchical segments (e.g., `finance:trading`)
- `name` — agent/skill/tool identifier

### Route pattern

Routes follow the existing Flue channel structural contract:

```ts
interface ArdRoute<E extends Env = Env> {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler<E>;
}
```

The well-known endpoint serves the catalog as `application/ai-catalog+json` with a 5-minute cache header.

### Search client

The search client implements the Agent Finder POST /search protocol:

- **Single registry**: `searchRegistry(url, options)`
- **Multi-registry**: `searchRegistries(urls, options)` — parallel fetch, deduplicate, merge, sort by score
- **Lookup by URN**: Extracts publisher domain, fetches well-known catalog, finds entry
- **Lookup by URL**: Direct fetch, detects catalog vs. raw artifact

All HTTP operations use `AbortSignal` for cancellation and configurable timeouts.

## Usage Examples

### Self-publishing

```ts
import { createArdRoutes } from '@flue/ard';

const ard = createArdRoutes({
  publisher: 'acme.com',
  name: 'assistant',
  displayName: 'Acme Assistant',
  description: 'General-purpose corporate assistant',
  url: 'https://api.acme.com/agents/assistant',
  version: '1.0.0',
  tags: ['assistant', 'corporate'],
  skills: [
    {
      id: 'email-drafting',
      name: 'Email Drafting',
      description: 'Draft professional emails',
      tags: ['email', 'writing'],
    },
  ],
});

// Mount on a Hono app
for (const route of ard.routes) {
  app.on(route.method, route.path, route.handler);
}
```

### Discovery tools

```ts
import { defineAgent } from '@flue/runtime';
import { createArdTools } from '@flue/ard';

const { searchTool, lookupTool } = createArdTools({
  registries: ['https://registry.example.com/api/v1'],
});

export default defineAgent(() => ({
  tools: [searchTool, lookupTool],
  instructions: 'You can discover and learn about other AI agents using the ard_search and ard_lookup tools.',
}));
```

### Programmatic search

```ts
import { searchRegistry, lookupAgent } from '@flue/ard';

// Search for agents
const results = await searchRegistry('https://registry.example.com/api/v1', {
  text: 'flight booking agent',
  types: ['application/a2a-agent-card+json'],
});

// Look up by URN
const agent = await lookupAgent('urn:ai:acme.com:travel:concierge');
```

## Spec Conformance

- **AI Catalog spec v1.0** — generates Level 2 (Discoverable) catalogs with optional Level 3 (Trusted) trust manifests
- **Agent Finder v0.5** — implements POST /search client with federation support
- **URN format** — `urn:ai:<publisher>:<namespace>:<name>` per Agent Finder §4.2.1
