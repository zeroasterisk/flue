# GEAP Code Execution Sandbox Adapter for Flue

## Overview

This adapter wraps Google's Gemini Enterprise Agent Platform (GEAP) Code
Execution Sandbox into Flue's `SandboxApi` interface. GEAP provides managed,
isolated sandbox environments for running Python and JavaScript code via a
REST API on Vertex AI (`aiplatform.googleapis.com`).

Unlike typical sandbox adapters that wrap a provider SDK (E2B, Daytona, Modal),
this adapter talks directly to the GEAP REST API using `fetch` because the
`@google/genai` JS SDK does not yet support sandbox operations (see
[googleapis/js-genai#1281](https://github.com/googleapis/js-genai/issues/1281)).

---

## API Mapping: GEAP -> Flue SandboxApi

### Core challenge

GEAP's sandbox is a **code execution** environment, not a **shell** environment.
It accepts code (Python/JavaScript) and returns stdout/stderr/files. There is no
direct bash/shell access. Every `SandboxApi` method must be implemented through
code execution calls.

### Method mapping

| Flue SandboxApi     | GEAP implementation                                              |
|---------------------|------------------------------------------------------------------|
| `exec(command)`     | Execute Python: `subprocess.run(command, shell=True, ...)`       |
| `readFile(path)`    | Execute Python: `open(path).read()` or use output files          |
| `readFileBuffer(p)` | Execute Python: `open(path, 'rb').read()` + base64 encode        |
| `writeFile(p, c)`   | Execute Python: `open(path, 'w').write(content)`                 |
| `stat(path)`        | Execute Python: `os.stat(path)` + `os.path.islink(path)`        |
| `readdir(path)`     | Execute Python: `os.listdir(path)`                               |
| `exists(path)`      | Execute Python: `os.path.exists(path)`                           |
| `mkdir(path, opts)` | Execute Python: `os.makedirs(path)` or `os.mkdir(path)`         |
| `rm(path, opts)`    | Execute Python: `os.remove(path)` or `shutil.rmtree(path)`      |

All filesystem operations use Python code execution rather than shell commands
for reliability and structured output parsing. Python is chosen over JavaScript
because `subprocess.run` provides direct shell command execution for `exec()`.

### Output protocol

Each code execution call wraps its result in a JSON envelope printed to stdout:

```python
import json, sys
try:
    result = <operation>
    print(json.dumps({"ok": True, "data": result}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
```

This gives the adapter structured, parseable responses for every operation.

---

## Authentication

GEAP uses Google Cloud IAM authentication. The adapter supports:

1. **Application Default Credentials (ADC)**: The recommended approach. Works
   automatically in GCP environments (Cloud Run, GKE, Compute Engine) and
   locally after `gcloud auth application-default login`.

2. **Service Account Key**: Via `GOOGLE_APPLICATION_CREDENTIALS` environment
   variable pointing to a JSON key file.

3. **Access Token**: Direct bearer token via configuration option, for
   environments that manage token refresh externally.

The adapter obtains access tokens using the `google-auth-library` package (if
available) or accepts a token-provider function in the configuration.

Required IAM role: `roles/aiplatform.user` on the project.

---

## Configuration

```typescript
interface GeapSandboxOptions {
  /** GCP project ID. Required. */
  projectId: string;

  /** GCP region. Defaults to 'us-central1' (only supported region). */
  region?: string;

  /**
   * Reasoning Engine ID. If not provided, one is created automatically
   * and cached for the lifetime of the adapter.
   */
  reasoningEngineId?: string;

  /** Programming language for the sandbox. Defaults to 'LANGUAGE_PYTHON'. */
  language?: 'LANGUAGE_PYTHON' | 'LANGUAGE_JAVASCRIPT';

  /** Machine configuration. Defaults to 2 vCPU / 1.5 GB RAM. */
  machineConfig?: 'MACHINE_CONFIG_DEFAULT' | 'MACHINE_CONFIG_VCPU4_RAM4GIB';

  /** Sandbox TTL in seconds. Max 14 days (1,209,600s). */
  ttlSeconds?: number;

  /** Display name for created sandboxes. */
  displayName?: string;

  /**
   * Provide a Google Cloud access token. Called before each API request.
   * If not provided, the adapter uses ADC via google-auth-library.
   */
  accessToken?: string | (() => string | Promise<string>);

  /** Default working directory inside the sandbox. Defaults to '/home/user'. */
  cwd?: string;
}
```

---

## Session Lifecycle

### Creation flow

```
geap(options)                           → SandboxFactory
  └─ createSessionEnv({ id })          → SessionEnv
       ├─ Resolve access token (ADC or provided)
       ├─ Create reasoning engine (if reasoningEngineId not provided)
       │    POST /v1/projects/{p}/locations/{l}/reasoningEngines
       ├─ Create sandbox environment
       │    POST /v1/.../reasoningEngines/{re}/sandboxEnvironments
       │    Body: { spec: { codeExecutionEnvironment: { language, machineConfig } } }
       │    → Returns Operation → poll until sandbox is ACTIVE
       └─ Return GeapSandboxApi wrapping the sandbox resource name
```

### Execution flow (per SandboxApi method call)

```
api.exec(command) / api.readFile(path) / ...
  ├─ Build Python code snippet for the operation
  ├─ POST /v1/.../sandboxEnvironments/{se}:executeCode
  │    Body: { code, inputFiles? }
  │    → { stdout, stderr, outputFiles? }
  ├─ Parse structured JSON from stdout
  └─ Return result or throw error
```

### Destruction

Sandboxes auto-expire based on TTL (default: sandbox default, max 14 days).
The adapter does not explicitly delete sandboxes — GEAP handles cleanup. If
the caller wants eager cleanup, they can call the GEAP delete endpoint
directly using the sandbox resource name exposed on the adapter.

---

## File System Mapping

GEAP sandboxes have a limited POSIX filesystem. Files persist within the
sandbox's lifetime (up to 14 days). The filesystem is isolated — no network
access, no access to host resources.

### writeFile with input files

For `writeFile` operations, the adapter writes content via code execution
rather than the input files API, because:
- Input files have a 100MB aggregate limit per request
- Code execution writes are simpler and avoid base64 encoding overhead
- The sandbox maintains state across calls, so written files persist

### readFileBuffer and binary content

For binary file reads, the adapter uses base64 encoding through Python's
`base64` module, since stdout is text-only. The encoded string is decoded
back to `Uint8Array` on the adapter side.

---

## Network Isolation

GEAP sandboxes have **no network access by default**. Code running inside the
sandbox cannot:
- Make HTTP requests
- Connect to databases
- Access external services
- Resolve DNS

This is a hard constraint of the platform, not a configuration option. This
makes GEAP sandboxes well-suited for untrusted code execution but limits use
cases that require downloading packages or accessing APIs.

---

## REST API Endpoints Used

All endpoints use base URL:
`https://{region}-aiplatform.googleapis.com/v1`

| Operation              | Method | Path                                                                          |
|------------------------|--------|-------------------------------------------------------------------------------|
| Create reasoning engine| POST   | `/projects/{p}/locations/{l}/reasoningEngines`                                |
| Create sandbox         | POST   | `/projects/{p}/locations/{l}/reasoningEngines/{re}/sandboxEnvironments`        |
| Execute code           | POST   | `/.../sandboxEnvironments/{se}:executeCode`                                   |
| Get sandbox            | GET    | `/.../sandboxEnvironments/{se}`                                               |
| Delete sandbox         | DELETE | `/.../sandboxEnvironments/{se}`                                               |
| Get operation          | GET    | `/projects/{p}/locations/{l}/operations/{op}`                                 |

Authentication: `Authorization: Bearer {access_token}` header on every request.

---

## Limitations

1. **No direct shell access**: All commands run through Python's `subprocess`.
2. **No custom packages**: Cannot `pip install` or `npm install` in the sandbox.
3. **Single region**: Only `us-central1` is supported.
4. **Code execution timeout**: 300 seconds per execution.
5. **File size limit**: 100MB aggregate per request/response.
6. **No JS SDK**: Must use REST API directly (fetch).
7. **Languages**: Only Python and JavaScript sandbox runtimes available.
