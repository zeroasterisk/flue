/**
 * TypeScript types for the AI Catalog specification (ai-catalog.json)
 * and the Agent Finder federated search protocol.
 *
 * @see https://github.com/Agent-Card/ai-catalog
 * @see https://agenticresourcediscovery.io
 */

// ---------------------------------------------------------------------------
// AI Catalog — Core types
// ---------------------------------------------------------------------------

/** Top-level AI Catalog document (`application/ai-catalog+json`). */
export interface AICatalog {
	/** Specification version in "Major.Minor" format (e.g., "1.0"). */
	specVersion: string;
	/** Catalog entries. */
	entries: CatalogEntry[];
	/** Optional host info identifying the catalog operator. */
	host?: HostInfo;
	/** Open metadata map for custom/non-standard data. */
	metadata?: Record<string, unknown>;
}

/** Identifies the operator of the catalog. */
export interface HostInfo {
	/** Human-readable name of the host. */
	displayName: string;
	/** Verifiable identifier (DID, domain, etc.). */
	identifier?: string;
	/** URL to the host's documentation. */
	documentationUrl?: string;
	/** URL to the host's logo. */
	logoUrl?: string;
	/** Trust metadata for the host. */
	trustManifest?: TrustManifest;
}

/** A single artifact in the catalog. */
export interface CatalogEntry {
	/** Globally unique identifier — SHOULD be a URN or URI. */
	identifier: string;
	/** Human-readable name. */
	displayName: string;
	/**
	 * Artifact type. Known types include:
	 * - `application/ai-catalog+json` — nested catalog
	 * - `application/a2a-agent-card+json` — A2A Agent Card
	 * - `application/mcp-server+json` — MCP Server Card
	 * - `application/ai-skills+zip` — AI Skill bundle (ZIP)
	 * - `application/ai-skills+gzip` — AI Skill bundle (gzip)
	 * - `text/markdown; profile=ai-skill` — AI Skill (Markdown)
	 */
	type: string;
	/** URL to retrieve the full artifact document. Mutually exclusive with `data`. */
	url?: string;
	/** Inline artifact document. Mutually exclusive with `url`. */
	data?: unknown;
	/** Short description. */
	description?: string;
	/** Keywords for filtering and discovery. */
	tags?: string[];
	/** Artifact version. Semantic Versioning recommended. */
	version?: string;
	/** ISO 8601 timestamp of last modification. */
	updatedAt?: string;
	/** Open metadata map. */
	metadata?: Record<string, unknown>;
	/** Publisher identity. */
	publisher?: Publisher;
	/** Trust metadata. */
	trustManifest?: TrustManifest;
}

/** Identifies the publisher of an artifact. */
export interface Publisher {
	/** Verifiable identifier for the publisher. */
	identifier: string;
	/** Human-readable name. */
	displayName: string;
	/** Type hint for the identifier (e.g., "did", "dns"). */
	identityType?: string;
}

// ---------------------------------------------------------------------------
// Trust Manifest
// ---------------------------------------------------------------------------

/** Verifiable identity, attestation, and provenance metadata. */
export interface TrustManifest {
	/** Globally unique URI — primary subject identifier. */
	identity: string;
	/** Type hint for the identity URI. */
	identityType?: string;
	/** Trust framework metadata. */
	trustSchema?: TrustSchema;
	/** Verifiable claims. */
	attestations?: Attestation[];
	/** Lineage information. */
	provenance?: ProvenanceLink[];
	/** Privacy policy URL. */
	privacyPolicyUrl?: string;
	/** Terms of service URL. */
	termsOfServiceUrl?: string;
	/** Detached JWS signature over the Trust Manifest content. */
	signature?: string;
	/** Open metadata map. */
	metadata?: Record<string, unknown>;
}

/** Trust framework descriptor. */
export interface TrustSchema {
	/** Trust schema identifier. */
	identifier: string;
	/** Schema version. */
	version: string;
	/** URI to the governance policy document. */
	governanceUri?: string;
	/** Supported verification methods (e.g., "did", "x509"). */
	verificationMethods?: string[];
}

/** Verifiable proof of a claim. */
export interface Attestation {
	/** Attestation type (e.g., "SOC2-Type2", "HIPAA-Audit"). */
	type: string;
	/** Location of the attestation document. */
	uri: string;
	/** Media type of the document. */
	mediaType: string;
	/** Cryptographic hash for integrity verification. */
	digest?: string;
	/** Size in bytes. */
	size?: number;
	/** Human-readable label. */
	description?: string;
}

/** Provenance lineage link. */
export interface ProvenanceLink {
	/** Relationship type (e.g., "publishedFrom", "derivedFrom"). */
	relation: string;
	/** Source artifact or data identifier. */
	sourceId: string;
	/** Digest of the source for verification. */
	sourceDigest?: string;
	/** URI of the registry holding the source. */
	registryUri?: string;
	/** URI of a provenance statement document. */
	statementUri?: string;
	/** Key reference used to sign the provenance statement. */
	signatureRef?: string;
}

// ---------------------------------------------------------------------------
// Agent Finder — Search protocol types
// ---------------------------------------------------------------------------

/** Structured filter constraints for search/explore queries. */
export interface SearchFilter {
	/** Filter by artifact type(s). */
	type?: string[];
	/** Filter by tags. */
	tags?: string[];
	/** Filter by publisher domain(s). */
	publisher?: string[];
	/** Any additional field-path filters (e.g., "trustManifest.attestations.type"). */
	[fieldPath: string]: string[] | undefined;
}

/** Query object used by POST /search and POST /explore. */
export interface SearchQuery {
	/** Natural-language description of the need. Required for /search. */
	text?: string;
	/** Structured filter constraints. */
	filter?: SearchFilter;
}

/** Federation mode for search requests. */
export type FederationMode = 'auto' | 'referrals' | 'none';

/** POST /search request body. */
export interface SearchRequest {
	/** Query object. `text` is required for search. */
	query: SearchQuery & { text: string };
	/** Federation mode. Defaults to "auto". */
	federation?: FederationMode;
	/** Maximum results. */
	pageSize?: number;
	/** Pagination token from a previous response. */
	pageToken?: string;
}

/** A search result entry — catalog entry with relevance score and source. */
export interface SearchResultEntry extends CatalogEntry {
	/** Semantic relevance score (0–100). Informational only. */
	score?: number;
	/** Source registry URL that returned this result. */
	source?: string;
}

/** Referral to another registry the client may query. */
export interface SearchReferral {
	/** Registry identifier. */
	identifier: string;
	/** Human-readable name. */
	displayName: string;
	/** Registry type. */
	type: string;
	/** Search endpoint URL. */
	url: string;
}

/** POST /search response body. */
export interface SearchResponse {
	/** Ranked result entries. */
	results: SearchResultEntry[];
	/** Optional referrals to other registries. */
	referrals?: SearchReferral[];
	/** Pagination token for the next page. */
	pageToken?: string;
}

// ---------------------------------------------------------------------------
// ARD Skill configuration
// ---------------------------------------------------------------------------

/** Describes a skill or capability for catalog generation. */
export interface ArdSkillEntry {
	/** Skill identifier (e.g., "code-review"). */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Skill description. */
	description: string;
	/** Keywords. */
	tags?: string[];
	/** Example queries. */
	examples?: string[];
}

/** Describes a tool for catalog generation. */
export interface ArdToolEntry {
	/** Tool name. */
	name: string;
	/** Tool description. */
	description: string;
}

/** Configuration for self-publishing an agent as an AI Catalog entry. */
export interface ArdPublishConfig {
	/** Publisher domain name (e.g., "acme.com"). Used in URN generation. */
	publisher: string;
	/** Agent identifier name (used as the terminal URN segment). */
	name: string;
	/** Human-readable display name. */
	displayName: string;
	/** Agent description. */
	description: string;
	/** Base URL where the agent is deployed. */
	url: string;
	/** Agent version (semantic versioning recommended). */
	version?: string;
	/** Tags for discovery. */
	tags?: string[];
	/**
	 * Artifact type for the main agent entry.
	 * Defaults to `"application/a2a-agent-card+json"`.
	 */
	type?: string;
	/** URN namespace segments between publisher and name (e.g., "finance:trading"). */
	namespace?: string;
	/** Skills the agent offers. */
	skills?: ArdSkillEntry[];
	/** Tools the agent provides. */
	tools?: ArdToolEntry[];
	/** Publisher identity info. */
	publisherInfo?: Publisher;
	/** Host info for the catalog. */
	host?: HostInfo;
	/** Representative queries for search indexing. */
	representativeQueries?: string[];
	/** Optional trust manifest for the agent entry. */
	trustManifest?: TrustManifest;
}

/** Configuration for the ARD route handler. */
export interface ArdRouteConfig extends ArdPublishConfig {
	/** Additional catalog entries to include alongside the agent entry. */
	additionalEntries?: CatalogEntry[];
}

/** Configuration for the ARD search/lookup tools. */
export interface ArdToolsConfig {
	/** Default registry URLs to search. */
	registries?: string[];
	/** Default federation mode for searches. */
	federation?: FederationMode;
	/** Default maximum results per search. */
	pageSize?: number;
	/** Request timeout in milliseconds. Defaults to 10000. */
	timeoutMs?: number;
}
