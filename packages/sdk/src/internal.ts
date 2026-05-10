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
import { getProviderConfiguration, resolveRegisteredModel } from './runtime/providers.ts';
import type { ModelConfig, ProviderSettings } from './types.ts';

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
 *   1. The runtime provider registry written by `registerProvider(...)`
 *      calls in user `app.ts` files (and by Flue's own internal
 *      bootstrap, e.g. the Cloudflare AI binding entry registered at the
 *      top of the generated `_entry.ts`). Keyed by URL prefix — the part
 *      of the model string before the first `/`.
 *   2. pi-ai's static catalog via `getModel`.
 *
 * After resolution, `configureProvider()` overrides (keyed by the resolved
 * Model's pi-ai provider slug) are applied to patch transport-level
 * settings like `baseUrl` and `headers`. Read from
 * {@link getProviderConfiguration}; apiKey and storeResponses live on the
 * same registry but flow through `session.ts:getProviderApiKey` and
 * `session.ts:applyProviderPayloadOverrides` respectively.
 */
export function resolveModel(model: ModelConfig | undefined): Model<Api> | undefined {
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

	// 1. Runtime registry (registerProvider). Consulted before pi-ai so
	//    users can shadow pi-ai built-ins — matches pi-ai's own
	//    last-write-wins semantics on its API provider registry.
	const built = resolveRegisteredModel(provider, modelId);
	if (built) {
		if (modelId === '') {
			throw new Error(
				`[flue] Invalid model "${modelString}". ` +
					`The "${provider}/" prefix is registered via registerProvider(), but no model id ` +
					`was given. Use "${provider}/<model-id>".`,
			);
		}
		// `resolveRegisteredModel` decides the final `provider` slug per
		// registration shape (binding entries hardcode `'workers-ai'`,
		// HTTP entries default to the registry name unless overridden).
		// Apply configureProvider() overrides keyed by that resolved slug
		// so the override key matches the field that surfaces on
		// AssistantMessage records.
		return applyProviderSettings(built, getProviderConfiguration(built.provider));
	}

	// 2. pi-ai catalog. `getModel` is overloaded on literal provider/modelId;
	//    we cast through runtime strings and rely on the null-return check
	//    below for unknowns.
	const resolved = getModel(provider as KnownProvider, modelId as never);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model "${modelString}". ` +
				`Provider "${provider}" / model id "${modelId}" ` +
				`is not registered with @mariozechner/pi-ai or via registerProvider().`,
		);
	}
	return applyProviderSettings(resolved, getProviderConfiguration(provider));
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
