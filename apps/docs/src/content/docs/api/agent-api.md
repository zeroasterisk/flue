---
title: Agent API
description: Define agents, tools, skills, MCP capabilities, and delegated specialist profiles with the core runtime API.
---

The agent-authoring API is exported from `@flue/runtime`. It describes reusable agent configuration and created-agent initializers, plus the capabilities an initialized harness can expose to its sessions.

For task-oriented guidance, see [Agents](/docs/concepts/agents/), [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), and [Subagents](/docs/guide/subagents/).

## Imports

```ts
import {
  Type,
  connectMcpServer,
  createAgent,
  defineAgentProfile,
  defineTool,
  type AgentCreateContext,
  type AgentHarnessOptions,
  type AgentProfile,
  type AgentRuntimeConfig,
  type CreatedAgent,
  type McpServerConnection,
  type McpServerOptions,
  type Skill,
  type SkillReference,
  type ToolDefinition,
} from '@flue/runtime';
```

## `defineAgentProfile(...)`

```ts
function defineAgentProfile(profile: AgentProfile): AgentProfile;
```

Defines reusable agent behavior. A profile may be used as the base configuration for a created agent or declared under `subagents` for delegated task work.

```ts
const reviewer = defineAgentProfile({
  name: 'reviewer',
  description: 'Reviews proposed changes for correctness risks.',
  model: 'anthropic/claude-sonnet-4-6',
  thinkingLevel: 'high',
  instructions: 'Report concrete failure scenarios and file evidence.',
  tools: [lookupPolicy],
  skills: [reviewChecklist],
});
```

### `AgentProfile`

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Optional profile name; required when a profile is selectable as a subagent. |
| `description` | `string` | Model-facing or application-facing description of the profile role. |
| `model` | `string \| false` | Default model selection intent. `false` deliberately supplies no default model. |
| `instructions` | `string` | Instructions prepended to discovered workspace context. |
| `skills` | `Skill[]` | Registered skill definitions or packaged skill references. |
| `tools` | `ToolDefinition[]` | Custom model-callable tools. |
| `subagents` | `AgentProfile[]` | Profiles available for nested delegated task selection. |
| `thinkingLevel` | `ThinkingLevel` | Default requested reasoning effort. |
| `compaction` | `false \| CompactionConfig` | Conversation compaction behavior. |

Profiles reject unknown fields, invalid reasoning levels, invalid tool/skill/subagent definitions, duplicate capability names within one array, and circular subagent definitions.

## `createAgent(...)`

```ts
function createAgent<TPayload = unknown, TEnv = Record<string, any>>(
  initialize: (context: AgentCreateContext<TPayload, TEnv>) =>
    AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): CreatedAgent<TPayload, TEnv>;
```

Creates a runtime initializer. Default-export it from an `agents/<name>.ts` module to define an addressable agent, or initialize it from a workflow with `ctx.init(agent)`.

```ts
export default createAgent(({ id, env }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: `Assist the authorized instance ${id}.`,
  tools: [lookupPolicy],
  persist: env.SESSION_STORE,
}));
```

### `AgentCreateContext`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Addressable agent instance ID for direct/dispatched agent processing; workflow `runId` when initialized within a workflow. |
| `env` | `TEnv` | Target environment bindings supplied by the runtime. |
| `payload` | `TPayload \| undefined` | Workflow payload or input initialization payload where available. |

### `AgentRuntimeConfig`

`AgentRuntimeConfig` includes every reusable profile field, plus environment-construction fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `profile` | `AgentProfile` | Reusable baseline whose scalar values can be replaced and arrays extended by created-agent configuration. |
| `cwd` | `string` | Working directory inside the selected sandbox. |
| `sandbox` | `false \| SandboxFactory \| BashFactory` | Filesystem and execution boundary for the initialized harness. |
| `persist` | `SessionStore` | Conversation-state store for sessions initialized from this agent. |

A created agent must establish model intent by returning `model`, `model: false`, or a profile with `model` specified. If no usable default model exists, a model-using operation must supply its own override.

### `CreatedAgent`

```ts
interface CreatedAgent<TPayload = unknown, TEnv = any> {
  readonly __flueCreatedAgent: true;
  readonly initialize: (
    context: AgentCreateContext<TPayload, TEnv>,
  ) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>;
}
```

Use the value with workflow `init(agent)` or with `dispatch(agent, request)` when it is the discovered default-exported created agent in the built application.

## `AgentHarnessOptions`

Workflow initialization can add capabilities or choose a harness name without changing sandbox or persistence construction:

```ts
const harness = await init(agent, {
  name: 'audit',
  tools: [lookupPolicy],
  skills: [reviewChecklist],
  subagents: [reviewer],
});
```

```ts
interface AgentHarnessOptions {
  name?: string;
  tools?: ToolDefinition[];
  skills?: Skill[];
  subagents?: AgentProfile[];
}
```

`init(...)` does not accept `cwd`, `sandbox`, or `persist`; those are returned by `createAgent(...)` because they determine the initialized environment and state boundary.

## Custom tools

### `defineTool(...)`

```ts
function defineTool<TParams extends ToolParameters>(
  tool: ToolDefinition<TParams>,
): ToolDefinition<TParams>;
```

`defineTool(...)` validates a custom model-callable tool and returns a shallow-frozen definition.

```ts
const lookupPolicy = defineTool({
  name: 'lookup_policy',
  description: 'Read one approved policy by topic.',
  parameters: Type.Object({ topic: Type.String() }),
  execute: async ({ topic }, signal) => {
    return readPolicy(String(topic), signal);
  },
});
```

### `ToolDefinition`

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Non-empty, model-visible tool identifier; must not collide with other active tools. |
| `description` | `string` | Non-empty model-facing tool guidance. |
| `parameters` | `ToolParameters` | JSON Schema-compatible argument shape, commonly built with `Type`. |
| `execute` | `(args: Record<string, any>, signal?: AbortSignal) => Promise<string>` | Trusted implementation; returned text is sent to the model. |

Tool definitions can be attached through a profile, a created agent, `init(agent, { tools })`, or one `prompt()`, `skill()`, or `task()` operation. Tools at narrower scopes are added rather than overriding matching names; duplicate names fail.

`Type` is re-exported from `@flue/runtime` for constructing JSON Schema-compatible parameters. Schema presentation to a model is not an authorization boundary; validate protected identifiers and allowed effects in `execute(...)`.

## Skills

A `Skill` is registered instruction metadata; an imported packaged skill is represented by `SkillReference`.

```ts
interface SkillReference {
  readonly __flueSkillReference: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

type Skill =
  | SkillReference
  | { name: string; description: string };
```

Register a statically imported packaged skill in an agent configuration:

```ts
import review from '../skills/review/SKILL.md' with { type: 'skill' };

const agent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  skills: [review],
}));
```

A harness also discovers workspace skill metadata from `<cwd>/.agents/skills/<name>/SKILL.md` inside its sandbox at initialization time. Declared and discovered skills share one catalog; duplicate names fail rather than selecting one implicitly.

Invoke skills from a session with `session.skill(nameOrReference, options)`. See [Skills](/docs/guide/skills/) for packaging rules, frontmatter validation, resources, and security exclusions.

## Subagents and delegated tasks

Declare named specialist profiles under `subagents`, then select one from `session.task(...)`:

```ts
const reviewer = defineAgentProfile({
  name: 'reviewer',
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Review only concrete correctness risks.',
});

const coordinator = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  subagents: [reviewer],
}));

const response = await session.task('Review the change.', {
  agent: 'reviewer',
});
```

A task creates a detached child session; it does not create a workflow run. The selected profile controls child defaults such as model, instructions, tools, skills, nested subagents, reasoning, and compaction where those fields are provided. See [Subagents](/docs/guide/subagents/) for precedence and task options.

## MCP-provided tools

### `connectMcpServer(...)`

```ts
function connectMcpServer(
  name: string,
  options: McpServerOptions,
): Promise<McpServerConnection>;
```

Connects to a remote MCP server and exposes the listed MCP tools as ordinary `ToolDefinition` values.

```ts
const inventory = await connectMcpServer('inventory', {
  url: env.INVENTORY_MCP_URL,
  headers: { Authorization: `Bearer ${env.INVENTORY_MCP_TOKEN}` },
});

try {
  const harness = await init(agent, { tools: inventory.tools });
  const session = await harness.session();
  return await session.prompt('Check available inventory.');
} finally {
  await inventory.close();
}
```

### `McpServerOptions`

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | `string \| URL` | MCP server endpoint. |
| `transport` | `'streamable-http' \| 'sse'` | Remote HTTP transport; defaults to `'streamable-http'`. |
| `headers` | `HeadersInit` | Headers merged into MCP transport requests. |
| `requestInit` | `RequestInit` | Additional request configuration. |
| `fetch` | `typeof fetch` | Optional custom fetch implementation. |
| `clientName` | `string` | MCP client name; defaults to `flue`. |
| `clientVersion` | `string` | MCP client version; defaults to `0.0.0`. |

### `McpServerConnection`

```ts
interface McpServerConnection {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}
```

MCP tools receive model-visible names in the form `mcp__<server>__<tool>`, with unsupported name characters sanitized. Duplicate MCP names after sanitizing fail. Close each connection when its tools are no longer needed.

## Related API pages

- [Harness API](/docs/api/harness-api/) covers session operations that use configured capabilities.
- [Application API](/docs/api/application-api/) covers mounted routes, provider configuration, dispatch, and observation.
- [Sandbox Connector API](/docs/api/sandbox-api/) covers execution environment adapters.
- [Data Persistence API](/docs/api/data-persistence-api/) covers custom conversation-state stores.
