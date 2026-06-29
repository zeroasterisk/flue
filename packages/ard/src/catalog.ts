/**
 * AI Catalog generation from a Flue agent configuration.
 *
 * Produces a spec-compliant `application/ai-catalog+json` document suitable
 * for serving at `/.well-known/ai-catalog.json`.
 */

import type {
	AICatalog,
	ArdPublishConfig,
	ArdSkillEntry,
	ArdToolEntry,
	CatalogEntry,
	HostInfo,
} from './types.ts';

/** Current spec version emitted by this generator. */
const SPEC_VERSION = '1.0';

/**
 * Generates a URN identifier following the Agent Finder convention:
 *
 *     urn:ai:<publisher>:<namespace>:<name>
 *
 * When `namespace` is omitted, the format becomes `urn:ai:<publisher>:<name>`.
 */
export function generateUrn(publisher: string, name: string, namespace?: string): string {
	const segments = ['urn', 'ai', publisher];
	if (namespace) {
		segments.push(...namespace.split(':').filter(Boolean));
	}
	segments.push(name);
	return segments.join(':');
}

/**
 * Generates a complete AI Catalog document from an agent publish configuration.
 *
 * The returned catalog includes:
 * - A primary entry for the agent itself
 * - Nested entries for each declared skill (if any)
 * - Nested entries for each declared tool  (if any)
 *
 * When the agent declares both skills and tools, they are bundled into a nested
 * catalog under the primary entry to keep the top-level catalog clean.
 */
export function generateCatalog(config: ArdPublishConfig): AICatalog {
	validateConfig(config);

	const agentUrn = generateUrn(config.publisher, config.name, config.namespace);
	const agentEntry = buildAgentEntry(config, agentUrn);
	const entries: CatalogEntry[] = [agentEntry];

	const host: HostInfo | undefined = config.host ?? {
		displayName: config.publisherInfo?.displayName ?? config.publisher,
		identifier: config.publisherInfo?.identifier,
	};

	return {
		specVersion: SPEC_VERSION,
		entries,
		...(host ? { host } : {}),
	};
}

/**
 * Generates only the primary catalog entry for an agent, without the
 * wrapping catalog envelope. Useful when adding an agent to an existing catalog.
 */
export function generateCatalogEntry(config: ArdPublishConfig): CatalogEntry {
	validateConfig(config);
	const agentUrn = generateUrn(config.publisher, config.name, config.namespace);
	return buildAgentEntry(config, agentUrn);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildAgentEntry(config: ArdPublishConfig, agentUrn: string): CatalogEntry {
	const hasChildren =
		(config.skills && config.skills.length > 0) || (config.tools && config.tools.length > 0);

	// When the agent has sub-capabilities, the main entry is a nested catalog.
	// Otherwise it's a direct artifact entry.
	if (hasChildren) {
		return buildNestedAgentEntry(config, agentUrn);
	}

	return buildFlatAgentEntry(config, agentUrn);
}

function buildFlatAgentEntry(config: ArdPublishConfig, agentUrn: string): CatalogEntry {
	const entry: CatalogEntry = {
		identifier: agentUrn,
		displayName: config.displayName,
		type: config.type ?? 'application/a2a-agent-card+json',
		url: config.url,
	};

	applyCommonFields(entry, config);
	return entry;
}

function buildNestedAgentEntry(config: ArdPublishConfig, agentUrn: string): CatalogEntry {
	const childEntries: CatalogEntry[] = [];

	// Primary agent endpoint entry inside the nested catalog.
	childEntries.push({
		identifier: `${agentUrn}:endpoint`,
		displayName: config.displayName,
		type: config.type ?? 'application/a2a-agent-card+json',
		url: config.url,
	});

	// Skill entries.
	if (config.skills) {
		for (const skill of config.skills) {
			childEntries.push(buildSkillEntry(skill, config.publisher, config.namespace));
		}
	}

	// Tool entries (as MCP-style capabilities).
	if (config.tools) {
		for (const tool of config.tools) {
			childEntries.push(buildToolEntry(tool, config.publisher, config.namespace));
		}
	}

	const entry: CatalogEntry = {
		identifier: agentUrn,
		displayName: config.displayName,
		type: 'application/ai-catalog+json',
		data: {
			specVersion: SPEC_VERSION,
			entries: childEntries,
		} satisfies AICatalog,
	};

	applyCommonFields(entry, config);
	return entry;
}

function buildSkillEntry(
	skill: ArdSkillEntry,
	publisher: string,
	namespace?: string,
): CatalogEntry {
	const entry: CatalogEntry = {
		identifier: generateUrn(publisher, skill.id, namespace ? `${namespace}:skill` : 'skill'),
		displayName: skill.name,
		type: 'text/markdown; profile=ai-skill',
		data: skill.description, // Inline the description as the artifact content.
		description: skill.description,
	};

	if (skill.tags && skill.tags.length > 0) {
		entry.tags = skill.tags;
	}

	if (skill.examples && skill.examples.length > 0) {
		entry.metadata = { representativeQueries: skill.examples };
	}

	return entry;
}

function buildToolEntry(
	tool: ArdToolEntry,
	publisher: string,
	namespace?: string,
): CatalogEntry {
	return {
		identifier: generateUrn(publisher, tool.name, namespace ? `${namespace}:tool` : 'tool'),
		displayName: tool.name,
		type: 'application/mcp-server+json',
		data: { name: tool.name, description: tool.description }, // Inline tool descriptor.
		description: tool.description,
	};
}

function applyCommonFields(entry: CatalogEntry, config: ArdPublishConfig): void {
	if (config.description) {
		entry.description = config.description;
	}
	if (config.version) {
		entry.version = config.version;
	}
	if (config.tags && config.tags.length > 0) {
		entry.tags = config.tags;
	}
	if (config.publisherInfo) {
		entry.publisher = config.publisherInfo;
	}
	if (config.trustManifest) {
		entry.trustManifest = config.trustManifest;
	}

	const meta: Record<string, unknown> = {};
	if (config.representativeQueries && config.representativeQueries.length > 0) {
		meta.representativeQueries = config.representativeQueries;
	}
	if (Object.keys(meta).length > 0) {
		entry.metadata = { ...entry.metadata, ...meta };
	}

	entry.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config: ArdPublishConfig): void {
	if (!config || typeof config !== 'object') {
		throw new TypeError('@flue/ard: publish config must be an object.');
	}
	assertNonEmpty(config.publisher, 'publisher');
	assertNonEmpty(config.name, 'name');
	assertNonEmpty(config.displayName, 'displayName');
	assertNonEmpty(config.description, 'description');
	assertNonEmpty(config.url, 'url');

	if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(config.publisher)) {
		throw new TypeError(
			'@flue/ard: publisher must be a valid domain name (lowercase, alphanumeric, dots, hyphens).',
		);
	}
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`@flue/ard: ${field} must be a non-empty string.`);
	}
}
