/**
 * @flue/ard — Agentic Resource Discovery integration for Flue.
 *
 * Provides:
 * - Self-publishing: serve `/.well-known/ai-catalog.json` from an agent definition
 * - Discovery tools: `ard_search` and `ard_lookup` for federated agent search
 *
 * ## Usage
 *
 * ### Self-publishing (route)
 *
 * ```ts
 * import { createArdRoutes } from '@flue/ard';
 *
 * const ard = createArdRoutes({
 *   publisher: 'acme.com',
 *   name: 'assistant',
 *   displayName: 'Acme Assistant',
 *   description: 'General-purpose corporate assistant',
 *   url: 'https://api.acme.com/agents/assistant',
 *   version: '1.0.0',
 *   tags: ['assistant', 'corporate'],
 * });
 * // Mount ard.routes on your Hono app.
 * ```
 *
 * ### Discovery tools (for agent use)
 *
 * ```ts
 * import { createArdTools } from '@flue/ard';
 *
 * const tools = createArdTools({
 *   registries: ['https://registry.example.com/api/v1'],
 * });
 * // Pass tools.searchTool and tools.lookupTool to defineAgent({ tools: [...] })
 * ```
 */

import type { Context, Env, Handler } from 'hono';
import * as v from 'valibot';

import { generateCatalog, generateCatalogEntry, generateUrn } from './catalog.ts';
import {
	type LookupOptions,
	type SearchOptions,
	fetchCatalog,
	fetchWellKnownCatalog,
	lookupAgent,
	searchRegistries,
	searchRegistry,
} from './search.ts';
import type {
	AICatalog,
	ArdPublishConfig,
	ArdRouteConfig,
	ArdToolsConfig,
	CatalogEntry,
} from './types.ts';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { ArdFetchError } from './search.ts';
export { generateCatalog, generateCatalogEntry, generateUrn } from './catalog.ts';
export {
	fetchCatalog,
	fetchWellKnownCatalog,
	lookupAgent,
	searchRegistries,
	searchRegistry,
} from './search.ts';
export type {
	AICatalog,
	ArdPublishConfig,
	ArdRouteConfig,
	ArdSkillEntry,
	ArdToolEntry,
	ArdToolsConfig,
	Attestation,
	CatalogEntry,
	FederationMode,
	HostInfo,
	ProvenanceLink,
	Publisher,
	SearchFilter,
	SearchQuery,
	SearchReferral,
	SearchRequest,
	SearchResponse,
	SearchResultEntry,
	TrustManifest,
	TrustSchema,
} from './types.ts';
export type { SearchOptions, LookupOptions } from './search.ts';

// ---------------------------------------------------------------------------
// Route types (following the Flue channel pattern)
// ---------------------------------------------------------------------------

/** A single route definition, matching the Flue channel pattern. */
export interface ArdRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Routes returned by `createArdRoutes`. */
export interface ArdRoutes<E extends Env = Env> {
	/** Hono route handlers to mount on the application. */
	readonly routes: readonly ArdRoute<E>[];
	/** The generated AI Catalog document. */
	readonly catalog: AICatalog;
}

// ---------------------------------------------------------------------------
// Route creation
// ---------------------------------------------------------------------------

/**
 * Creates Hono route handlers for serving the agent's AI Catalog.
 *
 * Generates a `/.well-known/ai-catalog.json` endpoint that serves a
 * spec-compliant AI Catalog derived from the agent configuration.
 *
 * ```ts
 * const ard = createArdRoutes({
 *   publisher: 'acme.com',
 *   name: 'assistant',
 *   displayName: 'Acme Assistant',
 *   description: 'General-purpose corporate assistant',
 *   url: 'https://api.acme.com/agents/assistant',
 * });
 *
 * // Mount routes on a Hono app
 * for (const route of ard.routes) {
 *   app.on(route.method, route.path, route.handler);
 * }
 * ```
 */
export function createArdRoutes<E extends Env = Env>(config: ArdRouteConfig): ArdRoutes<E> {
	const catalog = generateCatalog(config);

	// Merge additional entries if provided.
	if (config.additionalEntries && config.additionalEntries.length > 0) {
		catalog.entries.push(...config.additionalEntries);
	}

	const catalogJson = JSON.stringify(catalog);

	const routes: ArdRoute<E>[] = [
		{
			method: 'GET',
			path: '/.well-known/ai-catalog.json',
			handler: ((_c: Context<E>) => {
				return new Response(catalogJson, {
					status: 200,
					headers: {
						'Content-Type': 'application/ai-catalog+json',
						'Cache-Control': 'public, max-age=300',
					},
				});
			}) as Handler<E>,
		},
	];

	return { routes, catalog };
}

// ---------------------------------------------------------------------------
// Tool types (structurally compatible with Flue ToolDefinition)
// ---------------------------------------------------------------------------

/**
 * A tool definition object structurally compatible with Flue's
 * `ToolDefinition` interface. Can be passed directly to
 * `defineAgent({ tools: [...] })`.
 */
export interface ArdToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly input: v.GenericSchema;
	readonly output: undefined;
	run(context: { input: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>;
}

/** Tools returned by `createArdTools`. */
export interface ArdTools {
	/** Search ARD-compatible registries for agents/tools/skills. */
	readonly searchTool: ArdToolDefinition;
	/** Look up a specific agent by URN or URL. */
	readonly lookupTool: ArdToolDefinition;
}

// ---------------------------------------------------------------------------
// Tool input/output schemas (Valibot)
// ---------------------------------------------------------------------------

const ArdSearchInput = v.object({
	query: v.pipe(v.string(), v.minLength(1, 'Query text is required.')),
	types: v.optional(v.array(v.string())),
	tags: v.optional(v.array(v.string())),
	publishers: v.optional(v.array(v.string())),
	registries: v.optional(v.array(v.string())),
	federation: v.optional(v.picklist(['auto', 'referrals', 'none'])),
	pageSize: v.optional(v.number()),
});

const ArdLookupInput = v.object({
	identifier: v.pipe(
		v.string(),
		v.minLength(1, 'An agent URN or URL is required.'),
	),
});

// ---------------------------------------------------------------------------
// Tool creation
// ---------------------------------------------------------------------------

/**
 * Creates Flue-compatible tool definitions for ARD discovery.
 *
 * Returns two tools:
 * - `searchTool` (`ard_search`): Searches ARD registries for agents/tools/skills.
 * - `lookupTool` (`ard_lookup`): Looks up a specific agent by URN or URL.
 *
 * Both tools are structurally compatible with Flue's `ToolDefinition` and
 * can be passed directly to `defineAgent({ tools: [...] })`.
 *
 * ```ts
 * import { createArdTools } from '@flue/ard';
 *
 * const { searchTool, lookupTool } = createArdTools({
 *   registries: ['https://registry.example.com/api/v1'],
 * });
 *
 * export default defineAgent(() => ({
 *   tools: [searchTool, lookupTool],
 * }));
 * ```
 */
export function createArdTools(config?: ArdToolsConfig): ArdTools {
	const defaultRegistries = config?.registries ?? [];
	const defaultFederation = config?.federation ?? 'auto';
	const defaultPageSize = config?.pageSize ?? 10;
	const defaultTimeout = config?.timeoutMs ?? 10_000;

	const searchTool: ArdToolDefinition = {
		name: 'ard_search',
		description:
			'Search ARD-compatible registries for AI agents, tools, and skills. ' +
			'Uses the Agent Finder federated search protocol to discover capabilities ' +
			'across registries. Returns ranked results with relevance scores.',
		input: ArdSearchInput,
		output: undefined,
		async run({ input: rawInput, signal }) {
			const input = rawInput as v.InferOutput<typeof ArdSearchInput>;
			const registries =
				input.registries && input.registries.length > 0 ? input.registries : defaultRegistries;

			if (registries.length === 0) {
				return {
					error: 'No registries configured. Provide registry URLs in the input or tool config.',
					results: [],
				};
			}

			const searchOpts: SearchOptions = {
				text: input.query,
				types: input.types,
				tags: input.tags,
				publishers: input.publishers,
				federation: input.federation ?? defaultFederation,
				pageSize: input.pageSize ?? defaultPageSize,
				timeoutMs: defaultTimeout,
				signal,
			};

			try {
				const response = await searchRegistries(registries, searchOpts);
				return {
					results: response.results.map(formatSearchResult),
					referrals: response.referrals ?? [],
					resultCount: response.results.length,
				};
			} catch (error) {
				return {
					error: error instanceof Error ? error.message : 'Search failed',
					results: [],
				};
			}
		},
	};

	const lookupTool: ArdToolDefinition = {
		name: 'ard_lookup',
		description:
			'Look up a specific AI agent, tool, or skill by its URN identifier or URL. ' +
			'For URNs (e.g., "urn:ai:acme.com:agent:assistant"), resolves the publisher ' +
			"domain and fetches their ai-catalog.json. For URLs, fetches the artifact directly.",
		input: ArdLookupInput,
		output: undefined,
		async run({ input: rawInput, signal }) {
			const input = rawInput as v.InferOutput<typeof ArdLookupInput>;
			try {
				const entry = await lookupAgent(input.identifier, {
					timeoutMs: defaultTimeout,
					signal,
				});

				if (!entry) {
					return {
						found: false,
						identifier: input.identifier,
						message: 'No matching agent found.',
					};
				}

				return {
					found: true,
					entry: formatCatalogEntry(entry),
				};
			} catch (error) {
				return {
					found: false,
					identifier: input.identifier,
					error: error instanceof Error ? error.message : 'Lookup failed',
				};
			}
		},
	};

	return Object.freeze({ searchTool, lookupTool });
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

interface FormattedSearchResult {
	identifier: string;
	displayName: string;
	type: string;
	description?: string;
	url?: string;
	score?: number;
	source?: string;
	version?: string;
	tags?: string[];
}

function formatSearchResult(entry: CatalogEntry & { score?: number; source?: string }): FormattedSearchResult {
	const result: FormattedSearchResult = {
		identifier: entry.identifier,
		displayName: entry.displayName,
		type: entry.type,
	};

	if (entry.description) result.description = entry.description;
	if (entry.url) result.url = entry.url;
	if (entry.score !== undefined) result.score = entry.score;
	if (entry.source) result.source = entry.source;
	if (entry.version) result.version = entry.version;
	if (entry.tags && entry.tags.length > 0) result.tags = entry.tags;

	return result;
}

interface FormattedCatalogEntry {
	identifier: string;
	displayName: string;
	type: string;
	description?: string;
	url?: string;
	version?: string;
	tags?: string[];
	publisher?: { identifier: string; displayName: string };
	updatedAt?: string;
}

function formatCatalogEntry(entry: CatalogEntry): FormattedCatalogEntry {
	const result: FormattedCatalogEntry = {
		identifier: entry.identifier,
		displayName: entry.displayName,
		type: entry.type,
	};

	if (entry.description) result.description = entry.description;
	if (entry.url) result.url = entry.url;
	if (entry.version) result.version = entry.version;
	if (entry.tags && entry.tags.length > 0) result.tags = entry.tags;
	if (entry.publisher) {
		result.publisher = {
			identifier: entry.publisher.identifier,
			displayName: entry.publisher.displayName,
		};
	}
	if (entry.updatedAt) result.updatedAt = entry.updatedAt;

	return result;
}
