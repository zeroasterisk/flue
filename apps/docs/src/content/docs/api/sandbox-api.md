---
title: Sandbox Connector API
description: Adapt external sandbox and workspace environments to Flue session execution.
---

The sandbox connector API is the public contract for supplying a Flue harness with an application-owned filesystem and command-execution boundary. Import these types and adapters from `@flue/runtime`.

For selecting a sandbox strategy, see [Sandboxes](/docs/guide/sandboxes/). For provider integrations, choose an entry from the Ecosystem **Sandboxes** section.

## Imports

```ts
import {
  createSandboxSessionEnv,
  type BashFactory,
  type BashLike,
  type FileStat,
  type SandboxApi,
  type SandboxFactory,
  type SessionEnv,
  type SessionToolFactory,
  type ShellResult,
} from '@flue/runtime';
```

## Configure an agent sandbox

Set `sandbox` in the configuration returned by `createAgent(...)`:

```ts
const agent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: provider(sandbox),
  cwd: '/workspace',
}));
```

`cwd` selects the working directory inside the resulting session environment. `init(...)` does not accept sandbox configuration; it initializes the environment already configured by the created agent.

## `SandboxFactory`

```ts
interface SandboxFactory {
  createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
  tools?: SessionToolFactory;
}
```

| Member | Meaning |
| --- | --- |
| `createSessionEnv({ id, cwd })` | Constructs the environment used by a harness/session. Your connector can use `id` and `cwd` when selecting provider context. |
| `tools` | Optional factory for connector-specific model-facing tools. When supplied, it replaces the framework's ordinary workspace tool set for that sandbox; Flue still supplies its framework-owned `task` tool. |

A connector adapts an environment. It does not implicitly create, retain, destroy, or authorize external provider resources; define those policies in application code.

## `SandboxApi`

Implement `SandboxApi` for a remote or provider-owned sandbox, then pass it through `createSandboxSessionEnv(...)`:

```ts
interface SandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult>;
}
```

### Filesystem methods

| Method | Required behavior |
| --- | --- |
| `readFile(path)` | Return UTF-8 content for one file. |
| `readFileBuffer(path)` | Return raw file bytes. |
| `writeFile(path, content)` | Write string or byte content. |
| `stat(path)` | Return file metadata using `FileStat`. |
| `readdir(path)` | Return immediate entry names rather than full paths. |
| `exists(path)` | Return whether a path exists. |
| `mkdir(path, options)` | Support directory creation and recursive creation when requested. |
| `rm(path, options)` | Support removal behavior expected by the requested flags. |

### `exec(...)`

`exec(...)` executes one command in the provider environment and resolves to:

```ts
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

| Option | Connector contract |
| --- | --- |
| `cwd` | Execute in the requested working directory when supplied. |
| `env` | Forward explicitly supplied environment values only according to provider policy. |
| `timeout` | Deadline hint in seconds. Forward it to a provider-native timeout where possible. This is the primary timeout path for model-selected shell commands. |
| `signal` | Mid-flight abort request. Forward it when the provider SDK supports cancellation. |

`createSandboxSessionEnv(...)` checks a supplied abort signal before and after a connector call. It cannot terminate provider work mid-flight unless the underlying connector/provider honors cancellation.

## `createSandboxSessionEnv(...)`

```ts
function createSandboxSessionEnv(api: SandboxApi, cwd: string): SessionEnv;
```

Wraps an implemented `SandboxApi` into Flue's normalized `SessionEnv`. It resolves relative filesystem paths below `cwd`, applies the default command working directory, and centralizes pre/post abort handling.

```ts
export function provider(api: SandboxApi): SandboxFactory {
  return {
    async createSessionEnv({ cwd }) {
      return createSandboxSessionEnv(api, cwd ?? '/workspace');
    },
  };
}
```

## `SessionEnv`

`SessionEnv` is the normalized environment Flue uses internally and exposes through harness/session filesystem and shell surfaces:

```ts
interface SessionEnv {
  exec(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<ShellResult>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cwd: string;
  resolvePath(path: string): string;
}
```

Connector authors normally return it from `createSandboxSessionEnv(...)` rather than implementing this interface directly. A connector with platform-specific semantics, such as a Workspace connector that does not provide ordinary command execution, may implement `SessionEnv` and connector tools deliberately.

## `FileStat`

```ts
interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date;
}
```

## Bash factories

For lightweight in-process shell environments, a created agent can instead accept a `BashFactory`:

```ts
type BashFactory = () => BashLike | Promise<BashLike>;
```

A `BashLike` value provides `exec(...)`, `getCwd()`, and its filesystem methods. Return a new instance from the factory when mutable files must not be shared across harness initializations.

## Connector-specific tools

A `SandboxFactory` may supply `tools?: SessionToolFactory` when its model-facing interface differs from the ordinary file/shell tools:

```ts
type SessionToolFactory = (
  env: SessionEnv,
  options: { subagents: Record<string, AgentProfile> },
) => AgentTool<any>[];
```

Use this capability intentionally. A tool factory replaces the default `read`, `write`, `edit`, `bash`, `grep`, and `glob` tools for that sandbox. It must not return a tool named `task`, which remains reserved for Flue delegation.

## Security and lifecycle requirements

- Keep provider credentials in trusted application configuration, not in prompts or model-selected file contents.
- Define provider-resource creation, reuse, retention, and cleanup in application code.
- Treat a shared sandbox as shared mutable state; do not reuse it across tenants unless the application explicitly authorizes that design.
- Choose network egress and command capabilities deliberately.
- Configure conversation persistence independently through `SessionStore`; a sandbox connector controls files and commands, not session history.
