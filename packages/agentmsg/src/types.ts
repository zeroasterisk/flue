/**
 * AgentMsg relay protocol types.
 *
 * AgentMsg is a store-and-forward message relay for A2A communication.
 * Agents register, send JSON-RPC `message/send` envelopes, and poll
 * their mailbox for incoming messages.
 *
 * @see https://agentmsg.net
 */

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Agent card published to the relay during registration. */
export interface AgentMsgAgentCard {
	name: string;
	url: string;
	description: string;
	[key: string]: unknown;
}

/** POST /api/agents request body. */
export interface AgentMsgRegisterRequest {
	agent_id: string;
	display_name: string;
	agent_card: AgentMsgAgentCard;
	callback_url?: string;
}

/** POST /api/agents response body. */
export interface AgentMsgRegisterResponse {
	agent_id: string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Message Envelope (JSON-RPC message/send)
// ---------------------------------------------------------------------------

/** A message part within the A2A envelope. */
export interface AgentMsgPart {
	kind?: string;
	text?: string;
	[key: string]: unknown;
}

/** The message payload within the JSON-RPC params. */
export interface AgentMsgMessage {
	role: string;
	messageId: string;
	contextId?: string;
	taskId?: string;
	parts: AgentMsgPart[];
}

/** Routing metadata within the JSON-RPC params. */
export interface AgentMsgMetadata {
	relay_target_agent_id: string;
	sender_agent_id: string;
	[key: string]: unknown;
}

/** JSON-RPC params for message/send. */
export interface AgentMsgParams {
	metadata: AgentMsgMetadata;
	message: AgentMsgMessage;
}

/** Full JSON-RPC message/send envelope. */
export interface AgentMsgEnvelope {
	jsonrpc: '2.0';
	id: string;
	method: 'message/send';
	params: AgentMsgParams;
}

/** POST /a2a response body. */
export interface AgentMsgSendResponse {
	result?: {
		id?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

/** A single entry returned from GET /mailbox/{agent_id}. */
export interface AgentMsgMailboxEntry {
	/** Mailbox entry ID — use this to ack, NOT the send-side relay id. */
	id: string;
	/** Message status on the relay (e.g. "PENDING", "DELIVERED"). */
	status?: string;
	/** The complete JSON-RPC envelope stored opaquely by the relay. */
	a2a_payload: AgentMsgEnvelope;
	[key: string]: unknown;
}

/** POST /mailbox/{agent_id}/ack request body. */
export interface AgentMsgAckRequest {
	message_ids: string[];
}

/** POST /mailbox/{agent_id}/ack response body. */
export interface AgentMsgAckResponse {
	acknowledged: number;
}

// ---------------------------------------------------------------------------
// Parsed Message (convenience type for handler callbacks)
// ---------------------------------------------------------------------------

/** A parsed message extracted from a mailbox entry for handler consumption. */
export interface AgentMsgParsedMessage {
	/** Mailbox entry ID (use for acking). */
	id: string;
	/** Agent ID of the sender. */
	senderAgentId: string;
	/** Extracted text content (first text part), or null if none. */
	text: string | null;
	/** Context ID from the message envelope. */
	contextId: string | null;
	/** Task ID from the message envelope. */
	taskId: string | null;
	/** Relay delivery status. */
	status: string | null;
	/** The full A2A envelope for advanced use. */
	raw: AgentMsgEnvelope;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** An agent entry from GET /agents. */
export interface AgentMsgCatalogEntry {
	agent_id: string;
	display_name?: string;
	slug?: string;
	agent_card?: AgentMsgAgentCard;
	[key: string]: unknown;
}

/** GET /agents response body. */
export interface AgentMsgCatalogResponse {
	agents: AgentMsgCatalogEntry[];
}
