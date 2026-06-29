/**
 * A2A protocol types for the HTTP+JSON/REST binding.
 * Field names use camelCase per the A2A JSON serialization convention.
 * Enum values use SCREAMING_SNAKE_CASE per ProtoJSON.
 *
 * @see https://a2a-protocol.org/v1.0.0/specification/
 */

// ---------------------------------------------------------------------------
// Parts, Messages, Artifacts
// ---------------------------------------------------------------------------

/** Common fields shared by all Part variants. */
interface A2APartBase {
	/** Optional metadata for this part. */
	metadata?: Record<string, unknown>;
	/** Optional filename. */
	filename?: string;
	/** MIME type of the part content. */
	mediaType?: string;
}

/**
 * The smallest unit of content within a Message or Artifact.
 *
 * Exactly one of `text`, `raw`, `url`, or `data` must be present
 * (mirrors the proto `oneof content` field).
 */
export type A2APart = A2APartBase &
	(
		| { text: string; raw?: never; url?: never; data?: never }
		| { text?: never; raw: string; url?: never; data?: never }
		| { text?: never; raw?: never; url: string; data?: never }
		| { text?: never; raw?: never; url?: never; data: unknown }
	);

/** Sender role. */
export type A2ARole = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

/** One unit of communication between client and server. */
export interface A2AMessage {
	/** Unique identifier for the message (client-generated). */
	messageId: string;
	/** Context ID for grouping related interactions. */
	contextId?: string;
	/** Task ID this message is associated with. */
	taskId?: string;
	/** Sender role. */
	role: A2ARole;
	/** Content parts. */
	parts: A2APart[];
	/** Optional metadata. */
	metadata?: Record<string, unknown>;
	/** Extension URIs present in this message. */
	extensions?: string[];
	/** Task IDs referenced for additional context. */
	referenceTaskIds?: string[];
}

/** Task output artifact. */
export interface A2AArtifact {
	/** Unique identifier within a task. */
	artifactId: string;
	/** Human-readable name. */
	name?: string;
	/** Human-readable description. */
	description?: string;
	/** Content parts. */
	parts: A2APart[];
	/** Optional metadata. */
	metadata?: Record<string, unknown>;
	/** Extension URIs. */
	extensions?: string[];
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** Task lifecycle states. */
export type A2ATaskState =
	| 'TASK_STATE_UNSPECIFIED'
	| 'TASK_STATE_SUBMITTED'
	| 'TASK_STATE_WORKING'
	| 'TASK_STATE_COMPLETED'
	| 'TASK_STATE_FAILED'
	| 'TASK_STATE_CANCELED'
	| 'TASK_STATE_INPUT_REQUIRED'
	| 'TASK_STATE_REJECTED'
	| 'TASK_STATE_AUTH_REQUIRED';

/** Terminal states that cannot accept further messages. */
export const TERMINAL_TASK_STATES: ReadonlySet<A2ATaskState> = new Set([
	'TASK_STATE_COMPLETED',
	'TASK_STATE_FAILED',
	'TASK_STATE_CANCELED',
	'TASK_STATE_REJECTED',
]);

/** Task status container. */
export interface A2ATaskStatus {
	/** Current state. */
	state: A2ATaskState;
	/** Optional status message. */
	message?: A2AMessage;
	/** ISO 8601 timestamp. */
	timestamp?: string;
}

/** The core unit of work in A2A. */
export interface A2ATask {
	/** Server-generated unique identifier. */
	id: string;
	/** Context identifier for grouping interactions. */
	contextId?: string;
	/** Current status. */
	status: A2ATaskStatus;
	/** Output artifacts. */
	artifacts?: A2AArtifact[];
	/** Interaction history. */
	history?: A2AMessage[];
	/** Custom metadata. */
	metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Requests / Responses
// ---------------------------------------------------------------------------

/** Configuration for a SendMessage request. */
export interface A2ASendMessageConfiguration {
	/** Media types the client accepts for response parts. */
	acceptedOutputModes?: string[];
	/** Maximum history messages to return. */
	historyLength?: number;
	/** If true, return immediately without waiting for completion. */
	returnImmediately?: boolean;
}

/** SendMessage request body. */
export interface A2ASendMessageRequest {
	/** Optional tenant routing identifier. */
	tenant?: string;
	/** The message to send. */
	message: A2AMessage;
	/** Request configuration. */
	configuration?: A2ASendMessageConfiguration;
	/** Additional metadata. */
	metadata?: Record<string, unknown>;
}

/** SendMessage response body — contains either a task or a message. */
export interface A2ASendMessageResponse {
	/** Task created or updated by the message. */
	task?: A2ATask;
	/** Direct message response. */
	message?: A2AMessage;
}

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

/** Agent interface (binding endpoint). */
export interface A2AAgentInterface {
	/** URL for this interface. */
	url: string;
	/** Protocol binding: "JSONRPC", "GRPC", "HTTP+JSON". */
	protocolBinding: string;
	/** Optional tenant routing identifier. */
	tenant?: string;
	/** A2A protocol version. */
	protocolVersion: string;
}

/** Agent capabilities. */
export interface A2AAgentCapabilities {
	/** Supports streaming responses. */
	streaming?: boolean;
	/** Supports push notifications. */
	pushNotifications?: boolean;
	/** Supports extended agent card. */
	extendedAgentCard?: boolean;
}

/** Agent skill descriptor. */
export interface A2AAgentSkill {
	/** Unique skill identifier. */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Skill description. */
	description: string;
	/** Keywords describing capabilities. */
	tags: string[];
	/** Example prompts or scenarios. */
	examples?: string[];
	/** Supported input media types (overrides agent defaults). */
	inputModes?: string[];
	/** Supported output media types (overrides agent defaults). */
	outputModes?: string[];
}

/** Agent provider information. */
export interface A2AAgentProvider {
	/** Provider URL. */
	url: string;
	/** Organization name. */
	organization: string;
}

/** Self-describing agent manifest served at /.well-known/agent-card.json. */
export interface A2AAgentCard {
	/** Human-readable agent name. */
	name: string;
	/** Agent description. */
	description: string;
	/** Ordered list of supported interfaces. */
	supportedInterfaces: A2AAgentInterface[];
	/** Service provider. */
	provider?: A2AAgentProvider;
	/** Agent version. */
	version: string;
	/** Documentation URL. */
	documentationUrl?: string;
	/** Supported capabilities. */
	capabilities: A2AAgentCapabilities;
	/** Default accepted input media types. */
	defaultInputModes: string[];
	/** Default output media types. */
	defaultOutputModes: string[];
	/** Agent skills. */
	skills: A2AAgentSkill[];
	/** Icon URL. */
	iconUrl?: string;
}

// ---------------------------------------------------------------------------
// Error codes (A2A-specific)
// ---------------------------------------------------------------------------

/** google.rpc.ErrorInfo detail entry used in A2A error responses. */
export interface A2ARpcErrorDetail {
	'@type': string;
	reason: string;
	domain: string;
}

/**
 * Error response envelope using the `google.rpc.Status` JSON
 * representation required by the A2A HTTP+JSON binding (Section 11.6).
 */
export interface A2ARpcStatus {
	error: {
		/** HTTP status code. */
		code: number;
		/** Canonical gRPC/Google-API status name (e.g. `"NOT_FOUND"`). */
		status: string;
		/** Human-readable error message. */
		message: string;
		/** Structured error details. */
		details: A2ARpcErrorDetail[];
	};
}

/**
 * A2A error reason codes per Section 11.6.
 *
 * These are used as `reason` values inside `google.rpc.ErrorInfo`
 * details — not as URIs.
 */
export const A2A_ERROR_REASONS = {
	TASK_NOT_FOUND: 'TASK_NOT_FOUND',
	TASK_NOT_CANCELABLE: 'TASK_NOT_CANCELABLE',
	UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
	CONTENT_TYPE_NOT_SUPPORTED: 'CONTENT_TYPE_NOT_SUPPORTED',
	VERSION_NOT_SUPPORTED: 'VERSION_NOT_SUPPORTED',
} as const;
