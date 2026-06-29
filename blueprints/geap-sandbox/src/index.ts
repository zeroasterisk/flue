// flue-blueprint: sandbox/geap@1
/**
 * GEAP (Gemini Enterprise Agent Platform) Code Execution Sandbox adapter for Flue.
 *
 * Wraps GEAP's Code Execution REST API into Flue's SandboxFactory interface.
 * Unlike other sandbox adapters that wrap a provider SDK, this adapter talks
 * directly to the Vertex AI REST API using fetch because the @google/genai
 * JS SDK does not yet support sandbox operations.
 *
 * GEAP sandboxes execute Python or JavaScript code in isolated environments.
 * This adapter implements Flue's SandboxApi by generating Python code snippets
 * for each operation (exec, readFile, writeFile, stat, etc.) and executing them
 * via the GEAP executeCode endpoint.
 *
 * @example
 * ```typescript
 * import { geap } from './sandboxes/geap';
 *
 * const agent = defineAgent(({ env }) => ({
 *   sandbox: geap({
 *     projectId: env.GOOGLE_CLOUD_PROJECT,
 *     accessToken: env.GOOGLE_ACCESS_TOKEN,
 *   }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * }));
 * export default defineWorkflow({ agent, async run({ harness }) {
 *   return await (await harness.session()).prompt('Inspect the workspace.');
 * }});
 * ```
 */
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';

// ─── Configuration ─────────────────────────────────────────────────────────

export interface GeapSandboxOptions {
	/** GCP project ID. Required. */
	projectId: string;

	/**
	 * GCP region. Defaults to 'us-central1'.
	 * Currently, Code Execution is only supported in us-central1.
	 */
	region?: string;

	/**
	 * Reasoning Engine resource ID. If not provided, one is created
	 * automatically during sandbox creation.
	 */
	reasoningEngineId?: string;

	/**
	 * Programming language for the sandbox runtime.
	 * Defaults to 'LANGUAGE_PYTHON'. Python is recommended because `exec()`
	 * is implemented via Python's `subprocess.run()`.
	 */
	language?: 'LANGUAGE_PYTHON' | 'LANGUAGE_JAVASCRIPT';

	/**
	 * Machine configuration for the sandbox.
	 * - Default (omitted): 2 vCPU, 1.5 GB RAM
	 * - 'MACHINE_CONFIG_VCPU4_RAM4GIB': 4 vCPU, 4 GB RAM
	 */
	machineConfig?: 'MACHINE_CONFIG_VCPU4_RAM4GIB';

	/** Sandbox display name. Defaults to 'flue-sandbox'. */
	displayName?: string;

	/**
	 * Google Cloud access token or a function that returns one.
	 * Called before each API request to allow token refresh.
	 *
	 * If not provided, the adapter reads `GOOGLE_ACCESS_TOKEN` from the
	 * environment. For production, provide a refresh function that calls
	 * `gcloud auth print-access-token` or uses a service account.
	 */
	accessToken: string | (() => string | Promise<string>);

	/**
	 * Default working directory inside the sandbox.
	 * Defaults to '/home/user'.
	 */
	cwd?: string;
}

// ─── GEAP REST API client ──────────────────────────────────────────────────

/** Response envelope from the GEAP executeCode endpoint. */
interface ExecuteCodeResponse {
	stdout?: string;
	stderr?: string;
	outputFiles?: Array<{ name: string; contents: string }>;
	executionError?: { errorMessage?: string; errorType?: string };
}

/** Long-running operation response from GEAP. */
interface Operation {
	name: string;
	done?: boolean;
	error?: { code?: number; message?: string };
	response?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

/** Sandbox environment resource from GEAP. */
interface SandboxEnvironmentResource {
	name: string;
	displayName?: string;
	state?: string;
	spec?: Record<string, unknown>;
}

class GeapClient {
	private readonly baseUrl: string;
	private readonly projectId: string;
	private readonly region: string;
	private readonly getToken: () => Promise<string>;

	constructor(options: GeapSandboxOptions) {
		this.projectId = options.projectId;
		this.region = options.region ?? 'us-central1';
		this.baseUrl = `https://${this.region}-aiplatform.googleapis.com/v1`;

		const tokenSource = options.accessToken;
		if (typeof tokenSource === 'function') {
			this.getToken = async () => tokenSource();
		} else {
			this.getToken = async () => tokenSource;
		}
	}

	private get projectPath(): string {
		return `projects/${this.projectId}/locations/${this.region}`;
	}

	/** Make an authenticated request to the GEAP API. */
	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 30_000,
	): Promise<T> {
		const token = await this.getToken();
		const url = `${this.baseUrl}/${path}`;

		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`[flue:geap] ${method} ${path} failed (${response.status}): ${text}`,
			);
		}

		return (await response.json()) as T;
	}

	/**
	 * Create a Reasoning Engine instance. Required as a parent resource
	 * for sandbox environments.
	 */
	async createReasoningEngine(displayName: string): Promise<string> {
		const op = await this.request<Operation>(
			'POST',
			`${this.projectPath}/reasoningEngines`,
			{ displayName },
		);
		const resolved = await this.pollOperation(op.name);
		// Extract the reasoning engine resource name from the operation response.
		const name = (resolved.response as Record<string, unknown> | undefined)?.name;
		if (typeof name !== 'string') {
			throw new Error(
				'[flue:geap] Failed to extract reasoning engine name from operation response.',
			);
		}
		return name;
	}

	/** Create a sandbox environment under a reasoning engine. */
	async createSandboxEnvironment(
		reasoningEngineName: string,
		options: {
			displayName?: string;
			language?: string;
			machineConfig?: string;
		},
	): Promise<SandboxEnvironmentResource> {
		const spec: Record<string, unknown> = {
			codeExecutionEnvironment: {
				...(options.language ? { language: options.language } : {}),
				...(options.machineConfig
					? { machineConfig: options.machineConfig }
					: {}),
			},
		};

		const op = await this.request<Operation>(
			'POST',
			`${reasoningEngineName}/sandboxEnvironments`,
			{
				displayName: options.displayName ?? 'flue-sandbox',
				spec,
			},
		);

		const resolved = await this.pollOperation(op.name);
		const resource = resolved.response as Record<string, unknown> | undefined;
		const name = resource?.name;
		if (typeof name !== 'string') {
			throw new Error(
				'[flue:geap] Failed to extract sandbox environment name from operation response.',
			);
		}
		return { ...resource, name } as SandboxEnvironmentResource;
	}

	/** Execute code in a sandbox environment. */
	async executeCode(
		sandboxName: string,
		code: string,
		inputFiles?: Array<{ name: string; contents: string }>,
	): Promise<ExecuteCodeResponse> {
		const body: Record<string, unknown> = { code };
		if (inputFiles && inputFiles.length > 0) {
			body.inputFiles = inputFiles;
		}
		// Allow generous HTTP timeout since code execution can take up to 300s.
		return this.request<ExecuteCodeResponse>(
			'POST',
			`${sandboxName}:executeCode`,
			body,
			330_000,
		);
	}

	/** Delete a sandbox environment. */
	async deleteSandbox(sandboxName: string): Promise<void> {
		await this.request<Operation>('DELETE', sandboxName);
	}

	/** Poll a long-running operation until it completes. */
	private async pollOperation(
		operationName: string,
		initialIntervalMs = 500,
		maxWaitMs = 300_000,
	): Promise<Operation> {
		const start = Date.now();
		let interval = initialIntervalMs;
		while (Date.now() - start < maxWaitMs) {
			const op = await this.request<Operation>('GET', operationName);
			if (op.done) {
				if (op.error) {
					throw new Error(
						`[flue:geap] Operation failed: ${op.error.message ?? 'unknown error'} (code ${op.error.code})`,
					);
				}
				return op;
			}
			await new Promise((resolve) => setTimeout(resolve, interval));
			interval = Math.min(interval * 1.5, 5000); // Cap at 5s
		}
		throw new Error(
			`[flue:geap] Operation ${operationName} timed out after ${Date.now() - start}ms.`,
		);
	}
}

// ─── Structured output protocol ────────────────────────────────────────────

/**
 * Parse the structured JSON envelope from code execution stdout.
 * All Python code snippets print `{"ok": true, "data": ...}` or
 * `{"ok": false, "error": "..."}` as their last line of output.
 */
function parseCodeResult<T>(response: ExecuteCodeResponse): T {
	if (response.executionError) {
		throw new Error(
			`[flue:geap] Code execution error: ${response.executionError.errorMessage ?? 'unknown'}`,
		);
	}

	const stdout = response.stdout ?? '';
	// The JSON envelope is the last non-empty line of stdout.
	const lines = stdout.trimEnd().split('\n');
	const lastLine = lines[lines.length - 1] ?? '';

	let parsed: { ok: boolean; data?: T; error?: string };
	try {
		parsed = JSON.parse(lastLine);
	} catch {
		throw new Error(
			`[flue:geap] Failed to parse code result. stdout: ${stdout}, stderr: ${response.stderr ?? ''}`,
		);
	}

	if (!parsed.ok) {
		throw new Error(`[flue:geap] ${parsed.error ?? 'unknown error'}`);
	}

	return parsed.data as T;
}

// ─── Python code generators ────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in a Python string literal.
 * Uses repr-style escaping to handle quotes, backslashes, and newlines.
 */
function pyStr(value: string): string {
	return JSON.stringify(value);
}

function pyExec(command: string, cwd?: string, env?: Record<string, string>, timeoutMs?: number): string {
	const envDict = env
		? `{**__import__('os').environ, ${Object.entries(env).map(([k, v]) => `${pyStr(k)}: ${pyStr(v)}`).join(', ')}}`
		: 'None';
	const timeoutSec = typeof timeoutMs === 'number' ? Math.ceil(timeoutMs / 1000) : 300;
	return `
import json, subprocess, sys
try:
    r = subprocess.run(
        ${pyStr(command)},
        shell=True,
        capture_output=True,
        text=True,
        cwd=${cwd ? pyStr(cwd) : 'None'},
        env=${envDict},
        timeout=${timeoutSec},
    )
    print(json.dumps({"ok": True, "data": {"stdout": r.stdout, "stderr": r.stderr, "exitCode": r.returncode}}))
except subprocess.TimeoutExpired as e:
    print(json.dumps({"ok": True, "data": {"stdout": e.stdout or "", "stderr": (e.stderr or "") + "\\nCommand timed out", "exitCode": 124}}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyReadFile(path: string): string {
	return `
import json, sys
try:
    with open(${pyStr(path)}, 'r', encoding='utf-8') as f:
        data = f.read()
    print(json.dumps({"ok": True, "data": data}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyReadFileBuffer(path: string): string {
	return `
import json, base64, sys
try:
    with open(${pyStr(path)}, 'rb') as f:
        data = base64.b64encode(f.read()).decode('ascii')
    print(json.dumps({"ok": True, "data": data}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyWriteFile(path: string, content: string): string {
	return `
import json, os, sys
try:
    with open(${pyStr(path)}, 'w', encoding='utf-8') as f:
        f.write(${pyStr(content)})
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyWriteFileBinary(path: string, base64Content: string): string {
	return `
import json, base64, sys
try:
    with open(${pyStr(path)}, 'wb') as f:
        f.write(base64.b64decode(${pyStr(base64Content)}))
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyStat(path: string): string {
	return `
import json, os, sys
try:
    s = os.stat(${pyStr(path)}, follow_symlinks=True)
    is_link = os.path.islink(${pyStr(path)})
    import stat as st
    print(json.dumps({"ok": True, "data": {
        "isFile": st.S_ISREG(s.st_mode),
        "isDirectory": st.S_ISDIR(s.st_mode),
        "isSymbolicLink": is_link,
        "size": s.st_size,
        "mtimeMs": int(s.st_mtime * 1000),
    }}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyReaddir(path: string): string {
	return `
import json, os, sys
try:
    entries = os.listdir(${pyStr(path)})
    print(json.dumps({"ok": True, "data": entries}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyExists(path: string): string {
	return `
import json, os, sys
try:
    print(json.dumps({"ok": True, "data": os.path.exists(${pyStr(path)})}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyMkdir(path: string, recursive: boolean): string {
	const fn = recursive ? 'os.makedirs' : 'os.mkdir';
	const existOk = recursive ? ', exist_ok=True' : '';
	return `
import json, os, sys
try:
    ${fn}(${pyStr(path)}${existOk})
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

function pyRm(path: string, recursive: boolean, force: boolean): string {
	let body: string;
	if (recursive) {
		if (force) {
			body = `
    import shutil
    try:
        shutil.rmtree(${pyStr(path)})
    except FileNotFoundError:
        pass`;
		} else {
			body = `
    import shutil
    shutil.rmtree(${pyStr(path)})`;
		}
	} else if (force) {
		body = `
    try:
        os.remove(${pyStr(path)})
    except FileNotFoundError:
        pass`;
	} else {
		body = `
    os.remove(${pyStr(path)})`;
	}

	return `
import json, os, sys
try:${body}
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`.trim();
}

// ─── SandboxApi implementation ─────────────────────────────────────────────

/**
 * Implements SandboxApi by wrapping GEAP's Code Execution REST API.
 *
 * Every operation generates a Python code snippet that performs the
 * requested action and prints a structured JSON result to stdout. The
 * adapter parses this JSON to extract the return value.
 *
 * The sandbox maintains state across executeCode calls, so files written
 * in one call are visible in subsequent calls. This enables the standard
 * Flue session workflow where the agent writes files, runs commands, and
 * reads results across multiple turns.
 */
class GeapSandboxApi implements SandboxApi {
	constructor(
		private client: GeapClient,
		private sandboxName: string,
	) {}

	/** Execute a Python code snippet and return the parsed result. */
	private async run<T>(code: string): Promise<T> {
		const response = await this.client.executeCode(this.sandboxName, code);
		return parseCodeResult<T>(response);
	}

	async readFile(path: string): Promise<string> {
		return this.run<string>(pyReadFile(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const base64Data = await this.run<string>(pyReadFileBuffer(path));
		// Decode base64 to Uint8Array.
		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		if (typeof content === 'string') {
			if (content.length < 1_000_000) {
				// Small content: embed directly in code.
				await this.run<null>(pyWriteFile(path, content));
			} else {
				// Large content: use inputFiles to avoid bloating the code payload.
				const code = `
import json, shutil, sys
try:
    shutil.copy('/input/upload', ${pyStr(path)})
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)`.trim();
				const response = await this.client.executeCode(
					this.sandboxName, code,
					[{ name: '/input/upload', contents: content }],
				);
				parseCodeResult<null>(response);
			}
		} else {
			// Encode binary content as base64 for transport through code execution.
			const binary = Array.from(content, (byte) =>
				String.fromCharCode(byte),
			).join('');
			const base64Content = btoa(binary);
			if (base64Content.length < 1_000_000) {
				await this.run<null>(pyWriteFileBinary(path, base64Content));
			} else {
				// Large binary: use inputFiles with base64, decode on the sandbox side.
				const code = `
import json, base64, sys
try:
    with open('/input/upload', 'r') as f:
        data = base64.b64decode(f.read())
    with open(${pyStr(path)}, 'wb') as f:
        f.write(data)
    print(json.dumps({"ok": True, "data": None}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)`.trim();
				const response = await this.client.executeCode(
					this.sandboxName, code,
					[{ name: '/input/upload', contents: base64Content }],
				);
				parseCodeResult<null>(response);
			}
		}
	}

	async stat(path: string): Promise<FileStat> {
		const raw = await this.run<{
			isFile: boolean;
			isDirectory: boolean;
			isSymbolicLink: boolean;
			size: number;
			mtimeMs: number;
		}>(pyStat(path));
		return {
			isFile: raw.isFile,
			isDirectory: raw.isDirectory,
			isSymbolicLink: raw.isSymbolicLink,
			size: raw.size,
			mtime: new Date(raw.mtimeMs),
		};
	}

	async readdir(path: string): Promise<string[]> {
		return this.run<string[]>(pyReaddir(path));
	}

	async exists(path: string): Promise<boolean> {
		return this.run<boolean>(pyExists(path));
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.run<null>(pyMkdir(path, options?.recursive ?? false));
	}

	async rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		await this.run<null>(
			pyRm(path, options?.recursive ?? false, options?.force ?? false),
		);
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.run<{ stdout: string; stderr: string; exitCode: number }>(
			pyExec(command, options?.cwd, options?.env, options?.timeoutMs),
		);
	}
}

// ─── SandboxFactory ────────────────────────────────────────────────────────

/**
 * Create a Flue sandbox factory backed by GEAP Code Execution.
 *
 * The factory creates a new GEAP sandbox environment for each agent session.
 * If no `reasoningEngineId` is provided, the factory creates one on the first
 * call and reuses it for subsequent sessions.
 *
 * @example
 * ```typescript
 * import { geap } from './sandboxes/geap';
 *
 * const agent = defineAgent(({ env }) => ({
 *   sandbox: geap({
 *     projectId: env.GOOGLE_CLOUD_PROJECT,
 *     accessToken: env.GOOGLE_ACCESS_TOKEN,
 *   }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * }));
 * ```
 */
export function geap(options: GeapSandboxOptions): SandboxFactory {
	const client = new GeapClient(options);
	const region = options.region ?? 'us-central1';

	// Cache the reasoning engine resource name across sessions.
	let reasoningEngineNamePromise: Promise<string> | undefined;

	async function getReasoningEngineName(): Promise<string> {
		if (options.reasoningEngineId) {
			return `projects/${options.projectId}/locations/${region}/reasoningEngines/${options.reasoningEngineId}`;
		}
		if (!reasoningEngineNamePromise) {
			reasoningEngineNamePromise = client.createReasoningEngine(
				options.displayName ?? 'flue-geap-sandbox',
			).catch((err) => {
				// Clear cached promise on failure so the next caller retries.
				reasoningEngineNamePromise = undefined;
				throw err;
			});
		}
		return reasoningEngineNamePromise;
	}

	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const reasoningEngineName = await getReasoningEngineName();

			const sandbox = await client.createSandboxEnvironment(
				reasoningEngineName,
				{
					displayName: options.displayName ?? 'flue-sandbox',
					language: options.language ?? 'LANGUAGE_PYTHON',
					machineConfig: options.machineConfig,
				},
			);

			const sandboxCwd = options.cwd ?? '/home/user';
			const api = new GeapSandboxApi(client, sandbox.name);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
