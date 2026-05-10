/**
 * Internal runtime helpers consumed by the generated server entry point.
 *
 * This subpath is NOT part of the public API. It exists solely so the build
 * plugins (Node, Cloudflare) can emit stable bare-specifier imports that
 * resolve through normal package-exports resolution at both build time and
 * runtime, for both workspace-linked and published-npm installs.
 *
 * User agent code should never import from here.
 */
import { getModel, type Api, type KnownProvider, type Model } from '@mariozechner/pi-ai';
import {
	CLOUDFLARE_AI_BINDING_API,
	CLOUDFLARE_AI_BINDING_PROVIDER,
} from './cloudflare-model.ts';
import type { FlueModelDefinition } from './config.ts';
import type { ModelConfig, ProviderSettings, ProvidersConfig } from './types.ts';

export { createFlueContext } from './client.ts';
export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { InMemorySessionStore } from './session.ts';
export { bashFactoryToSessionEnv } from './sandbox.ts';

// Runtime modules consumed by the generated server entries.
//
//   - `handleAgentRequest` is the per-agent dispatcher (webhook / SSE /
//     sync). Used directly by the Cloudflare entry's `dispatchAgent`
//     wrapper to layer in DO-specific keepalive / fiber handling. The
//     Node target reaches the same dispatcher through `flue()`.
//
//   - `configureFlueRuntime` seeds the module-scoped config that
//     `flue()` reads at request time. Called once per generated entry,
//     before the listener (Node) or `default.fetch` (Cloudflare) takes
//     traffic.
//
//   - `createDefaultFlueApp` is the no-`app.ts` fallback. Lives in the
//     SDK so the generated entry doesn't have to import `hono` (which
//     keeps user projects from needing it as a direct dep when they
//     don't author their own `app.ts`).
//
// The user-facing `flue()` itself is re-exported from `@flue/sdk/app`,
// not here. Error helpers (`toHttpResponse`, the FlueError subclasses)
// are not re-exported either — generated entries no longer need them
// directly; everything error-shaped flows through `flue()` /
// `createDefaultFlueApp` and their `onError` handlers.
export { handleAgentRequest } from './runtime/handle-agent.ts';
export type {
	AgentHandler,
	CreateContextFn,
	HandleAgentOptions,
	RunHandlerFn,
	StartWebhookFn,
} from './runtime/handle-agent.ts';
export { configureFlueRuntime, createDefaultFlueApp } from './runtime/flue-app.ts';
export type { FlueRuntime } from './runtime/flue-app.ts';

/**
 * Resolve a `provider/model-id` string into a pi-ai `Model` object.
 * Lives here (rather than in the generated entry point) so that user
 * projects don't have to declare `@mariozechner/pi-ai` as a direct
 * dependency — wrangler's bundler resolves bare specifiers from the entry
 * file's location, which on pnpm-isolated installs doesn't see Flue's
 * transitive deps. Centralizing the resolver here keeps `_entry.ts`
 * dependency-free apart from `@flue/sdk/*`.
 *
 * Resolution order (highest priority first):
 *
 *   1. User-defined `models` from `flue.config.ts`. Keyed by bare provider
 *      name (the part of the model string before the first `/`). On the
 *      Cloudflare target, the build plugin auto-injects a `cloudflare:`
 *      entry of kind `'cloudflare-ai-binding'` so `cloudflare/...` routes
 *      to the Workers AI binding via this same path.
 *   2. pi-ai's static catalog via `getModel`.
 *
 * `userModels` is undefined for legacy callers (e.g. older generated
 * server entries that haven't been re-bundled); those fall straight through
 * to pi-ai. After a rebuild the user-models map is always present (`{}` if
 * the user didn't define any).
 */
export function resolveModel(
	model: ModelConfig | undefined,
	providers?: ProvidersConfig,
	userModels?: Record<string, FlueModelDefinition>,
): Model<Api> | undefined {
	if (model === false || model === undefined) return undefined;

	const modelString = model;

	const slash = modelString.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model "${modelString}". ` +
				`Use the "provider/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const provider = modelString.slice(0, slash);
	const modelId = modelString.slice(slash + 1);

	// 1. User-defined models from flue.config.ts (and build-injected built-ins
	//    like the Cloudflare AI binding entry). Consulted before pi-ai so
	//    users can shadow built-ins — matches pi-ai's last-write-wins
	//    behavior on its own provider registry.
	const userDef = userModels?.[provider];
	if (userDef) {
		if (!modelId) {
			throw new Error(
				`[flue] Invalid model "${modelString}". ` +
					`The "${provider}/" prefix is registered in flue.config.ts, but no model id ` +
					`was given. Use "${provider}/<model-id>".`,
			);
		}
		// `buildUserModel` decides the final `provider` per-kind (some
		// honor `def.provider`, some hardcode it). Read the override key
		// off the constructed model so it always matches what surfaces on
		// AssistantMessage records — `init({ providers: { ... } })` keys
		// off the same field.
		const built = buildUserModel(userDef, provider, modelId);
		return applyProviderSettings(built, providers?.[built.provider]);
	}

	// 2. pi-ai catalog. `getModel` is overloaded on literal provider/modelId;
	//    we cast through runtime strings and rely on the null-return check
	//    below for unknowns.
	const resolved = getModel(provider as KnownProvider, modelId as never);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model "${modelString}". ` +
				`Provider "${provider}" / model id "${modelId}" ` +
				`is not registered with @mariozechner/pi-ai.`,
		);
	}
	return applyProviderSettings(resolved, providers?.[provider]);
}

/**
 * Construct a pi-ai `Model` literal from a user-supplied `FlueModelDefinition`,
 * the map key the entry was registered under, and the suffix of the model
 * string (everything after the first `/`).
 *
 * Each `kind` case decides how to compute the final `provider` field — some
 * honor an explicit `def.provider` override (with `mapKey` as the fallback);
 * others hardcode it (the runtime API the binding/handler is registered as
 * doesn't necessarily match the URL-side prefix users type).
 *
 * Cost / context-window fields are zeroed because no static catalog exists
 * for user-defined providers; Flue features that read those (cost display,
 * overflow detection) degrade gracefully.
 */
function buildUserModel(
	def: FlueModelDefinition,
	mapKey: string,
	modelId: string,
): Model<Api> {
	switch (def.kind) {
		case 'openai-completions': {
			return {
				id: modelId,
				name: modelId,
				api: 'openai-completions',
				provider: def.provider ?? mapKey,
				baseUrl: def.baseUrl,
				reasoning: false,
				input: ['text'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
				headers: def.headers,
			};
		}
		case 'cloudflare-ai-binding': {
			// `mapKey` (typically `'cloudflare'`) is intentionally ignored:
			// every Workers AI binding model surfaces as `provider: 'workers-ai'`
			// on AssistantMessage records, matching pi-ai's catalog convention.
			// `baseUrl` is empty because the API handler dispatches through
			// `env.AI.run()` (binding), not HTTP. See workers-ai-provider.ts.
			return {
				id: modelId,
				name: modelId,
				api: CLOUDFLARE_AI_BINDING_API,
				provider: CLOUDFLARE_AI_BINDING_PROVIDER,
				baseUrl: '',
				reasoning: false,
				input: ['text'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			};
		}
		default: {
			// Exhaustive check. Adding a new `kind` to the union without a
			// matching case here is a type error.
			const _exhaustive: never = def;
			throw new Error(
				`[flue] Unknown user model kind: ${String((_exhaustive as { kind: string }).kind)}`,
			);
		}
	}
}

function applyProviderSettings<TApi extends Api>(
	model: Model<TApi>,
	providerSettings: ProviderSettings | undefined,
): Model<TApi> {
	if (!providerSettings) return model;

	const hasBaseUrl = providerSettings.baseUrl !== undefined;
	const hasHeaders = providerSettings.headers !== undefined;
	if (!hasBaseUrl && !hasHeaders) return model;

	return {
		...model,
		baseUrl: providerSettings.baseUrl ?? model.baseUrl,
		headers: hasHeaders ? { ...(model.headers ?? {}), ...providerSettings.headers } : model.headers,
	};
}
