/**
 * ARD search and discovery client.
 *
 * Provides HTTP client functions for:
 * - Searching ARD-compatible registries via POST /search
 * - Looking up agents by URN or URL
 * - Fetching ai-catalog.json from well-known locations
 */

import type {
	AICatalog,
	CatalogEntry,
	FederationMode,
	SearchRequest,
	SearchResponse,
	SearchResultEntry,
} from './types.ts';

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Maximum catalog nesting depth to prevent circular references. */
const MAX_NESTING_DEPTH = 4;

/** Well-known path for ai-catalog.json. */
const WELL_KNOWN_PATH = '/.well-known/ai-catalog.json';

/** Maximum allowed response body size (5 MB). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Regex matching hostnames that resolve to private/internal network addresses.
 * Covers localhost, IPv4 private ranges (RFC 1918), link-local, loopback, and IPv6 loopback.
 */
const BLOCKED_HOSTS =
	/^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/** Regex for a valid domain name (no ports, paths, or special characters). */
const VALID_DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Validates that a URL is safe to fetch — blocks private/internal addresses
 * and non-HTTP(S) protocols to prevent SSRF attacks.
 */
function validateFetchUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ArdFetchError(`Invalid URL: ${url}`, url, 0);
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new ArdFetchError(`Unsupported protocol: ${parsed.protocol}`, url, 0);
	}

	if (BLOCKED_HOSTS.test(parsed.hostname)) {
		throw new ArdFetchError('Fetching private/internal addresses is not allowed', url, 0);
	}
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Options for searching an ARD registry. */
export interface SearchOptions {
	/** Natural-language query text. Required. */
	text: string;
	/** Filter by artifact type(s). */
	types?: string[];
	/** Filter by tags. */
	tags?: string[];
	/** Filter by publisher domain(s). */
	publishers?: string[];
	/** Additional field-path filters. */
	filters?: Record<string, string[]>;
	/** Federation mode. Defaults to "auto". */
	federation?: FederationMode;
	/** Maximum results per page. */
	pageSize?: number;
	/** Pagination token from a previous response. */
	pageToken?: string;
	/** Request timeout in milliseconds. */
	timeoutMs?: number;
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
}

/**
 * Searches an ARD-compatible registry for agents, tools, and skills.
 *
 * Sends a `POST /search` request to the given registry URL following
 * the Agent Finder specification.
 */
export async function searchRegistry(
	registryUrl: string,
	options: SearchOptions,
): Promise<SearchResponse> {
	const url = normalizeRegistryUrl(registryUrl, '/search');

	const body: SearchRequest = {
		query: {
			text: options.text,
			filter: buildFilter(options),
		},
	};

	if (options.federation) body.federation = options.federation;
	if (options.pageSize) body.pageSize = options.pageSize;
	if (options.pageToken) body.pageToken = options.pageToken;

	const response = await fetchJson<SearchResponse>(url, {
		method: 'POST',
		body,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});

	return response;
}

/**
 * Searches multiple registries in parallel and merges results.
 *
 * Entries from all registries are combined, deduplicated by identifier,
 * and sorted by relevance score (highest first).
 */
export async function searchRegistries(
	registryUrls: string[],
	options: SearchOptions,
): Promise<SearchResponse> {
	if (registryUrls.length === 0) {
		return { results: [] };
	}
	if (registryUrls.length === 1) {
		return searchRegistry(registryUrls[0]!, options);
	}

	const responses = await Promise.allSettled(
		registryUrls.map((url) => searchRegistry(url, options)),
	);

	const allResults: SearchResultEntry[] = [];
	const allReferrals: SearchResponse['referrals'] = [];
	const seenIdentifiers = new Set<string>();

	for (const result of responses) {
		if (result.status !== 'fulfilled') continue;
		const response = result.value;

		for (const entry of response.results) {
			// Deduplicate by identifier + version.
			const key = entry.version ? `${entry.identifier}@${entry.version}` : entry.identifier;
			if (!seenIdentifiers.has(key)) {
				seenIdentifiers.add(key);
				allResults.push(entry);
			}
		}

		if (response.referrals) {
			for (const referral of response.referrals) {
				if (!seenIdentifiers.has(referral.identifier)) {
					seenIdentifiers.add(referral.identifier);
					allReferrals.push(referral);
				}
			}
		}
	}

	// Sort by score descending, entries without score go last.
	allResults.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

	return {
		results: allResults,
		...(allReferrals.length > 0 ? { referrals: allReferrals } : {}),
	};
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Options for looking up a specific agent. */
export interface LookupOptions {
	/** Request timeout in milliseconds. */
	timeoutMs?: number;
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
}

/**
 * Looks up a specific agent by URL or URN.
 *
 * - **URL**: Fetches the URL directly. If it returns a catalog, searches
 *   entries for the matching identifier. If it returns a single artifact,
 *   wraps it in a CatalogEntry.
 * - **URN** (`urn:ai:<publisher>:...`): Extracts the publisher domain,
 *   fetches `https://<publisher>/.well-known/ai-catalog.json`, and finds
 *   the entry matching the full URN.
 */
export async function lookupAgent(
	identifier: string,
	options?: LookupOptions,
): Promise<CatalogEntry | null> {
	if (identifier.startsWith('urn:ai:')) {
		return lookupByUrn(identifier, options);
	}

	// Treat as a direct URL.
	return lookupByUrl(identifier, options);
}

async function lookupByUrn(
	urn: string,
	options?: LookupOptions,
): Promise<CatalogEntry | null> {
	const publisher = extractPublisherFromUrn(urn);
	if (!publisher) return null;

	// Validate the publisher looks like a real domain — prevents SSRF via
	// crafted URNs like urn:ai:169.254.169.254:agent:foo.
	if (!VALID_DOMAIN.test(publisher) || BLOCKED_HOSTS.test(publisher)) {
		return null;
	}

	const catalogUrl = `https://${publisher}${WELL_KNOWN_PATH}`;
	const catalog = await fetchCatalog(catalogUrl, options);
	if (!catalog) return null;

	return findEntryByIdentifier(catalog, urn);
}

async function lookupByUrl(
	url: string,
	options?: LookupOptions,
): Promise<CatalogEntry | null> {
	const data = await fetchJson<unknown>(url, {
		method: 'GET',
		timeoutMs: options?.timeoutMs,
		signal: options?.signal,
	});

	// Check if it's a catalog.
	if (isAICatalog(data)) {
		// Return the first entry, or null if empty.
		return data.entries[0] ?? null;
	}

	// Wrap raw artifact data as a catalog entry.
	return {
		identifier: url,
		displayName: extractDisplayName(data) ?? url,
		type: 'application/json',
		url,
	};
}

// ---------------------------------------------------------------------------
// Catalog fetching
// ---------------------------------------------------------------------------

/**
 * Fetches an AI Catalog from a URL.
 *
 * If the URL does not include a path, the well-known path is appended.
 */
export async function fetchCatalog(
	url: string,
	options?: LookupOptions,
): Promise<AICatalog | null> {
	try {
		const data = await fetchJson<unknown>(url, {
			method: 'GET',
			timeoutMs: options?.timeoutMs,
			signal: options?.signal,
		});

		if (isAICatalog(data)) return data;
		return null;
	} catch {
		return null;
	}
}

/**
 * Fetches a catalog from a domain's well-known URL.
 */
export async function fetchWellKnownCatalog(
	domain: string,
	options?: LookupOptions,
): Promise<AICatalog | null> {
	if (!VALID_DOMAIN.test(domain)) {
		return null;
	}
	return fetchCatalog(`https://${domain}${WELL_KNOWN_PATH}`, options);
}

// ---------------------------------------------------------------------------
// Catalog traversal
// ---------------------------------------------------------------------------

/**
 * Recursively finds an entry by identifier, traversing nested catalogs
 * up to MAX_NESTING_DEPTH.
 */
function findEntryByIdentifier(
	catalog: AICatalog,
	identifier: string,
	depth = 0,
): CatalogEntry | null {
	if (depth > MAX_NESTING_DEPTH) return null;

	for (const entry of catalog.entries) {
		if (entry.identifier === identifier) return entry;

		// Recurse into nested catalogs.
		if (entry.type === 'application/ai-catalog+json' && entry.data && isAICatalog(entry.data)) {
			const found = findEntryByIdentifier(entry.data, identifier, depth + 1);
			if (found) return found;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isAICatalog(value: unknown): value is AICatalog {
	return (
		typeof value === 'object' &&
		value !== null &&
		'specVersion' in value &&
		'entries' in value &&
		Array.isArray((value as AICatalog).entries)
	);
}

function extractPublisherFromUrn(urn: string): string | null {
	// urn:ai:<publisher>:<...>
	const parts = urn.split(':');
	if (parts.length < 4 || parts[0] !== 'urn' || parts[1] !== 'ai') return null;
	return parts[2] ?? null;
}

function extractDisplayName(data: unknown): string | null {
	if (typeof data === 'object' && data !== null) {
		const record = data as Record<string, unknown>;
		if (typeof record.name === 'string') return record.name;
		if (typeof record.displayName === 'string') return record.displayName;
		if (typeof record.title === 'string') return record.title;
	}
	return null;
}

function normalizeRegistryUrl(base: string, path: string): string {
	const trimmed = base.replace(/\/+$/, '');
	return `${trimmed}${path}`;
}

function buildFilter(options: SearchOptions): Record<string, string[]> | undefined {
	const filter: Record<string, string[]> = {};
	let hasFilter = false;

	if (options.types && options.types.length > 0) {
		filter.type = options.types;
		hasFilter = true;
	}
	if (options.tags && options.tags.length > 0) {
		filter.tags = options.tags;
		hasFilter = true;
	}
	if (options.publishers && options.publishers.length > 0) {
		filter.publisher = options.publishers;
		hasFilter = true;
	}
	if (options.filters) {
		for (const [key, values] of Object.entries(options.filters)) {
			if (values && values.length > 0) {
				filter[key] = values;
				hasFilter = true;
			}
		}
	}

	return hasFilter ? filter : undefined;
}

interface FetchJsonOptions {
	method: 'GET' | 'POST';
	body?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}

async function fetchJson<T>(url: string, options: FetchJsonOptions): Promise<T> {
	// SSRF: validate before any network access.
	validateFetchUrl(url);

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Compose timeout + optional external signal via AbortSignal.any()
	// (available in Node 20+; required engine is >=22.19.0).
	const signal = options.signal
		? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
		: AbortSignal.timeout(timeoutMs);

	const headers: Record<string, string> = {
		Accept: 'application/json, application/ai-catalog+json',
	};
	const init: RequestInit = { method: options.method, headers, signal };

	if (options.body) {
		headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(options.body);
	}

	const response = await fetch(url, init);

	if (!response.ok) {
		throw new ArdFetchError(
			`ARD request failed: ${response.status} ${response.statusText}`,
			url,
			response.status,
		);
	}

	// Guard against excessively large responses (OOM/DoS).
	const contentLength = response.headers.get('content-length');
	if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
		throw new ArdFetchError(
			`Response too large: ${contentLength} bytes (limit ${MAX_RESPONSE_BYTES})`,
			url,
			413,
		);
	}

	const text = await response.text();
	if (text.length > MAX_RESPONSE_BYTES) {
		throw new ArdFetchError(
			`Response body too large: ${text.length} bytes (limit ${MAX_RESPONSE_BYTES})`,
			url,
			413,
		);
	}

	return JSON.parse(text) as T;
}

/** Error thrown when an ARD HTTP request fails. */
export class ArdFetchError extends Error {
	readonly url: string;
	readonly statusCode: number;

	constructor(message: string, url: string, statusCode: number) {
		super(message);
		this.name = 'ArdFetchError';
		this.url = url;
		this.statusCode = statusCode;
	}
}
