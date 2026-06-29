import type { Context, Env, Handler } from 'hono';

export type {
	AgentMsgAckRequest,
	AgentMsgAckResponse,
	AgentMsgAgentCard,
	AgentMsgCatalogEntry,
	AgentMsgCatalogResponse,
	AgentMsgEnvelope,
	AgentMsgMailboxEntry,
	AgentMsgMessage,
	AgentMsgMetadata,
	AgentMsgParams,
	AgentMsgParsedMessage,
	AgentMsgPart,
	AgentMsgRegisterRequest,
	AgentMsgRegisterResponse,
	AgentMsgSendResponse,
} from './types.ts';

import type {
	AgentMsgEnvelope,
	AgentMsgMailboxEntry,
	AgentMsgParsedMessage,
	AgentMsgSendResponse,
} from './types.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidAgentMsgConversationKeyError extends Error {
	constructor() {
		super('Invalid AgentMsg conversation key.');
		this.name = 'InvalidAgentMsgConversationKeyError';
	}
}

export class InvalidAgentMsgInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid AgentMsg ${field}.`);
		this.name = 'InvalidAgentMsgInputError';
		this.field = field;
	}
}

export class AgentMsgRelayError extends Error {
	readonly statusCode: number | undefined;
	readonly body: unknown;

	constructor(message: string, statusCode?: number, body?: unknown) {
		super(message);
		this.name = 'AgentMsgRelayError';
		this.statusCode = statusCode;
		this.body = body;
	}
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

/** Canonical AgentMsg conversation reference. */
export interface AgentMsgRef {
	agentId: string;
}

/** Input provided to the onMessage callback. */
export interface AgentMsgMessageHandlerInput<E extends Env = Env> {
	/** Hono context (present for webhook-pushed messages, undefined for polled). */
	c?: Context<E>;
	/** Parsed message from the mailbox. */
	message: AgentMsgParsedMessage;
	/** The sender agent ID (convenience alias for message.senderAgentId). */
	senderAgentId: string;
}

type AgentMsgHandlerValue = undefined | JsonValue | Response;

export type AgentMsgHandlerResult =
	| AgentMsgHandlerValue
	| Promise<AgentMsgHandlerValue>;

/** Options for creating an AgentMsg channel. */
export interface AgentMsgChannelOptions<E extends Env = Env> {
	/** Base URL of the AgentMsg relay (e.g. "https://agentmsg-relay.example.com"). */
	relayUrl: string;
	/** This agent's unique ID on the relay. */
	agentId: string;
	/** Human-readable display name for registration. */
	displayName: string;
	/**
	 * Receives each inbound message from the mailbox (polled or pushed).
	 * Called once per message with the parsed content.
	 */
	onMessage(input: AgentMsgMessageHandlerInput<E>): AgentMsgHandlerResult;
	/** Poll interval in milliseconds. Defaults to 30000 (30s). */
	pollIntervalMs?: number;
	/** Extra fields merged into the agent card during registration. */
	agentCard?: Record<string, unknown>;
	/**
	 * Custom fetch implementation. Defaults to globalThis.fetch.
	 * Useful for testing or environments with custom HTTP handling.
	 */
	fetch?: typeof globalThis.fetch;
}

/** The AgentMsg channel instance with polling lifecycle. */
export interface AgentMsgChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced conversation key. */
	conversationKey(ref: AgentMsgRef): string;
	/** Parses a canonical key produced by `conversationKey()`. */
	parseConversationKey(id: string): AgentMsgRef;
	/**
	 * Registers the agent on the relay and starts the poll loop.
	 * Call this once at application startup.
	 */
	start(): Promise<void>;
	/**
	 * Stops the poll loop. Does not unregister the agent from the relay.
	 */
	stop(): void;
	/**
	 * Send a text message to another agent via the relay.
	 * Convenience method — equivalent to what the agentmsg_send tool does.
	 */
	send(
		toAgentId: string,
		text: string,
		options?: { contextId?: string; taskId?: string },
	): Promise<string>;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function relayFetch(
	fetchFn: typeof globalThis.fetch,
	method: string,
	url: string,
	body?: unknown,
): Promise<{ status: number; data: unknown }> {
	const headers: Record<string, string> = { accept: 'application/json' };
	let reqBody: string | undefined;
	if (body !== undefined) {
		reqBody = JSON.stringify(body);
		headers['content-type'] = 'application/json';
	}
	const resp = await fetchFn(url, {
		method,
		headers,
		body: reqBody,
	});
	const text = await resp.text();
	let data: unknown;
	try {
		data = text.trim() ? JSON.parse(text) : null;
	} catch {
		data = text.slice(0, 500);
	}
	return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

function parseMailboxEntry(entry: AgentMsgMailboxEntry): AgentMsgParsedMessage {
	const payload = entry.a2a_payload || ({} as AgentMsgEnvelope);
	const params = payload.params || ({} as AgentMsgEnvelope['params']);
	const msg = params.message || ({} as AgentMsgEnvelope['params']['message']);
	const meta = params.metadata || ({} as AgentMsgEnvelope['params']['metadata']);
	const parts = msg.parts || [];

	let text: string | null = null;
	for (const p of parts) {
		if (p && typeof p === 'object' && typeof p.text === 'string' && text === null) {
			text = p.text;
		}
	}

	return {
		id: String(entry.id ?? ''),
		senderAgentId: meta.sender_agent_id ?? '',
		text,
		contextId: msg.contextId ?? null,
		taskId: msg.taskId ?? null,
		status: entry.status ?? null,
		raw: payload,
	};
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

function buildEnvelope(
	fromAgentId: string,
	toAgentId: string,
	text: string,
	contextId?: string,
	taskId?: string,
): AgentMsgEnvelope {
	const ctx = contextId ?? `ctx-${randomHex()}`;
	return {
		jsonrpc: '2.0',
		id: `req-${randomHex()}`,
		method: 'message/send',
		params: {
			metadata: {
				relay_target_agent_id: toAgentId,
				sender_agent_id: fromAgentId,
			},
			message: {
				role: 'user',
				messageId: `msg-${randomHex()}`,
				contextId: ctx,
				...(taskId ? { taskId } : {}),
				parts: [{ kind: 'text', text }],
			},
		},
	};
}

function randomHex(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

/**
 * Creates an AgentMsg relay channel.
 *
 * AgentMsg is a poll-based store-and-forward relay for agent-to-agent
 * messaging. Unlike the direct A2A channel that requires a public HTTP
 * endpoint, AgentMsg works for agents behind NAT by polling a mailbox.
 *
 * The channel:
 * 1. Registers the Flue agent on the relay at startup (`start()`)
 * 2. Polls the mailbox at a configurable interval (default 30s)
 * 3. Routes incoming messages to the `onMessage` callback
 * 4. Provides a `send()` method for outbound messages
 * 5. Uses sender agent_id as the conversation key
 *
 * An optional `/webhook` route is included for relay push delivery
 * (if the relay supports callback URLs).
 */
export function createAgentMsgChannel<E extends Env = Env>(
	options: AgentMsgChannelOptions<E>,
): AgentMsgChannel<E> {
	validateOptions(options);

	const relayUrl = options.relayUrl.replace(/\/+$/, '');
	const agentId = options.agentId;
	const displayName = options.displayName;
	const pollIntervalMs = options.pollIntervalMs ?? 30_000;
	const fetchFn = options.fetch ?? globalThis.fetch;
	const onMessage = options.onMessage;
	const extraCard = options.agentCard ?? {};

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let polling = false;

	// ---- Registration ---------------------------------------------------

	async function register(): Promise<void> {
		const card = {
			name: displayName,
			url: `${relayUrl}/a2a`,
			description: `Flue agent ${agentId}`,
			...extraCard,
		};
		const { status, data } = await relayFetch(fetchFn, 'POST', `${relayUrl}/api/agents`, {
			agent_id: agentId,
			display_name: displayName,
			agent_card: card,
		});
		if (status !== 200 && status !== 201) {
			throw new AgentMsgRelayError(
				`AgentMsg registration failed (${status})`,
				status,
				data,
			);
		}
	}

	// ---- Polling ---------------------------------------------------------

	async function pollMailbox(): Promise<void> {
		if (polling) return; // guard against overlapping polls
		polling = true;
		try {
			const { status, data } = await relayFetch(
				fetchFn,
				'GET',
				`${relayUrl}/mailbox/${encodeURIComponent(agentId)}`,
			);
			if (status !== 200) {
				// Non-fatal: log but don't crash the poll loop
				return;
			}
			if (!Array.isArray(data) || data.length === 0) return;

			const ackIds: string[] = [];
			for (const entry of data) {
				if (!entry || typeof entry !== 'object') continue;
				const parsed = parseMailboxEntry(entry as AgentMsgMailboxEntry);
				if (!parsed.senderAgentId) continue;
				try {
					await onMessage({ message: parsed, senderAgentId: parsed.senderAgentId });
				} catch {
					// Handler errors don't crash the poll loop.
					// The message is still acked to prevent infinite redelivery.
				}
				if (parsed.id) {
					ackIds.push(parsed.id);
				}
			}

			// Acknowledge processed messages
			if (ackIds.length > 0) {
				await relayFetch(
					fetchFn,
					'POST',
					`${relayUrl}/mailbox/${encodeURIComponent(agentId)}/ack`,
					{ message_ids: ackIds },
				).catch(async () => {
					// Retry once — un-acked messages WILL reappear on the next
					// poll (the relay returns both PENDING and DELIVERED messages).
					await relayFetch(
						fetchFn,
						'POST',
						`${relayUrl}/mailbox/${encodeURIComponent(agentId)}/ack`,
						{ message_ids: ackIds },
					).catch(() => {});
				});
			}
		} finally {
			polling = false;
		}
	}

	// ---- Send -----------------------------------------------------------

	async function send(
		toAgentId: string,
		text: string,
		opts?: { contextId?: string; taskId?: string },
	): Promise<string> {
		const envelope = buildEnvelope(
			agentId,
			toAgentId,
			text,
			opts?.contextId,
			opts?.taskId,
		);
		const { status, data } = await relayFetch(fetchFn, 'POST', `${relayUrl}/a2a`, envelope);
		if (status !== 200) {
			throw new AgentMsgRelayError(`AgentMsg send failed (${status})`, status, data);
		}
		const resp = data as AgentMsgSendResponse | null;
		return resp?.result?.id ? String(resp.result.id) : '';
	}

	// ---- Webhook handler (push delivery) --------------------------------

	const webhookHandler: Handler<E> = async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		// The relay may push a single envelope or an array
		const envelopes: unknown[] = Array.isArray(body) ? body : [body];
		const ackIds: string[] = [];

		for (const raw of envelopes) {
			if (!raw || typeof raw !== 'object') continue;
			// The webhook payload may be a mailbox entry (with a2a_payload)
			// or a raw envelope (params.metadata). Handle both.
			const entry = raw as Record<string, unknown>;
			let parsed: AgentMsgParsedMessage;
			if (entry.a2a_payload && typeof entry.a2a_payload === 'object') {
				parsed = parseMailboxEntry(entry as AgentMsgMailboxEntry);
			} else if (
				entry.params &&
				typeof entry.params === 'object'
			) {
				// Raw envelope pushed directly
				parsed = parseMailboxEntry({
					id: (entry as Record<string, unknown>).id as string ?? '',
					a2a_payload: entry as unknown as AgentMsgEnvelope,
				} as AgentMsgMailboxEntry);
			} else {
				continue;
			}

			if (!parsed.senderAgentId) continue;
			try {
				await onMessage({
					c: c as Context<E>,
					message: parsed,
					senderAgentId: parsed.senderAgentId,
				});
			} catch {
				// Handler errors don't reject the webhook
			}
			if (parsed.id) {
				ackIds.push(parsed.id);
			}
		}

		// Ack pushed messages (retry once on failure — un-acked messages reappear)
		if (ackIds.length > 0) {
			const ackUrl = `${relayUrl}/mailbox/${encodeURIComponent(agentId)}/ack`;
			const ackBody = { message_ids: ackIds };
			relayFetch(fetchFn, 'POST', ackUrl, ackBody).catch(async () => {
				await relayFetch(fetchFn, 'POST', ackUrl, ackBody).catch(() => {});
			});
		}

		return c.json({ ok: true }, 200);
	};

	// ---- Build channel --------------------------------------------------

	const routes: ChannelRoute<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: webhookHandler,
		},
	];

	const channel: AgentMsgChannel<E> = {
		routes,

		conversationKey(ref) {
			assertRef(ref);
			return `agentmsg:v1:${encodeURIComponent(ref.agentId)}`;
		},

		parseConversationKey(id) {
			try {
				const match = /^agentmsg:v1:([^:]+)$/.exec(id);
				const rawAgentId = match?.[1];
				if (!rawAgentId) throw new InvalidAgentMsgConversationKeyError();
				const ref = { agentId: decodeURIComponent(rawAgentId) };
				assertRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidAgentMsgConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidAgentMsgConversationKeyError) throw error;
				throw new InvalidAgentMsgConversationKeyError();
			}
		},

		async start() {
			await register();
			// Immediately poll once, then set up interval
			pollMailbox().catch(() => {});
			if (pollIntervalMs > 0) {
				pollTimer = setInterval(() => {
					pollMailbox().catch(() => {});
				}, pollIntervalMs);
			}
		},

		stop() {
			if (pollTimer !== null) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
		},

		send,
	};

	return channel;
}

// ---------------------------------------------------------------------------
// Send tool factory
// ---------------------------------------------------------------------------

/** Options for creating the agentmsg_send tool. */
export interface AgentMsgSendToolOptions {
	/** Base URL of the AgentMsg relay. */
	relayUrl: string;
	/** This agent's ID on the relay (used as sender_agent_id). */
	agentId: string;
	/**
	 * Custom fetch implementation. Defaults to globalThis.fetch.
	 */
	fetch?: typeof globalThis.fetch;
}

/**
 * Tool definition shape compatible with `@flue/runtime`'s ToolDefinition.
 *
 * This is a plain-object tool descriptor that can be passed directly to
 * `defineAgent({ tools: [...] })`. It does not import from `@flue/runtime`
 * to avoid a hard dependency — the runtime accepts any object matching
 * this shape.
 */
export interface AgentMsgSendToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly input: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required: string[];
	};
	run(context: {
		input: { to: string; message: string; context_id?: string };
		signal?: AbortSignal;
	}): Promise<{ relay_id: string; status: string }>;
}

/**
 * Creates an `agentmsg_send` tool that agents can use to send messages
 * to other agents via the AgentMsg relay.
 *
 * Usage with defineAgent:
 * ```ts
 * import { createAgentMsgSendTool } from '@flue/agentmsg';
 *
 * defineAgent(() => ({
 *   tools: [
 *     createAgentMsgSendTool({
 *       relayUrl: process.env.AGENTMSG_RELAY_URL!,
 *       agentId: 'my-agent',
 *     }),
 *   ],
 * }));
 * ```
 *
 * Note: This returns a plain tool descriptor object. If you need Valibot
 * schema validation, wrap it with `defineTool()` from `@flue/runtime`.
 */
export function createAgentMsgSendTool(
	options: AgentMsgSendToolOptions,
): AgentMsgSendToolDefinition {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createAgentMsgSendTool() requires an options object.');
	}
	if (typeof options.relayUrl !== 'string' || options.relayUrl.length === 0) {
		throw new TypeError('createAgentMsgSendTool() requires a non-empty relayUrl.');
	}
	if (typeof options.agentId !== 'string' || options.agentId.length === 0) {
		throw new TypeError('createAgentMsgSendTool() requires a non-empty agentId.');
	}

	const relayUrl = options.relayUrl.replace(/\/+$/, '');
	const agentId = options.agentId;
	const fetchFn = options.fetch ?? globalThis.fetch;

	return {
		name: 'agentmsg_send',
		description:
			'Send a message to another agent via the AgentMsg relay. ' +
			'Provide the target agent ID and message text.',
		input: {
			type: 'object',
			properties: {
				to: {
					type: 'string',
					description: 'The agent_id of the recipient agent on the AgentMsg relay.',
				},
				message: {
					type: 'string',
					description: 'The text message to send.',
				},
				context_id: {
					type: 'string',
					description:
						'Optional context ID for grouping related messages into a conversation thread.',
				},
			},
			required: ['to', 'message'],
		},
		async run(context) {
			const { to, message, context_id } = context.input;
			const envelope = buildEnvelope(agentId, to, message, context_id);
			const { status, data } = await relayFetch(
				fetchFn,
				'POST',
				`${relayUrl}/a2a`,
				envelope,
			);
			if (status !== 200) {
				throw new AgentMsgRelayError(`Send failed (${status})`, status, data);
			}
			const resp = data as AgentMsgSendResponse | null;
			return {
				relay_id: resp?.result?.id ? String(resp.result.id) : '',
				status: 'sent',
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Catalog helper
// ---------------------------------------------------------------------------

/**
 * List agents registered on the AgentMsg relay.
 *
 * This is a standalone utility — it doesn't require a channel instance.
 */
export async function listAgentMsgAgents(
	relayUrl: string,
	fetchFn?: typeof globalThis.fetch,
): Promise<Array<{ agent_id: string; display_name?: string; [key: string]: unknown }>> {
	const url = relayUrl.replace(/\/+$/, '');
	const fn = fetchFn ?? globalThis.fetch;
	const { status, data } = await relayFetch(fn, 'GET', `${url}/agents`);
	if (status !== 200) {
		throw new AgentMsgRelayError(`Catalog fetch failed (${status})`, status, data);
	}
	if (data && typeof data === 'object' && 'agents' in data && Array.isArray((data as Record<string, unknown>).agents)) {
		return (data as { agents: Array<{ agent_id: string; [key: string]: unknown }> }).agents;
	}
	if (Array.isArray(data)) {
		return data as Array<{ agent_id: string; [key: string]: unknown }>;
	}
	return [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOptions<E extends Env>(options: AgentMsgChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createAgentMsgChannel() requires an options object.');
	}
	assertOption(options.relayUrl, 'relayUrl');
	assertOption(options.agentId, 'agentId');
	assertOption(options.displayName, 'displayName');
	if (typeof options.onMessage !== 'function') {
		throw new TypeError('createAgentMsgChannel() requires an onMessage handler.');
	}
	if (
		options.pollIntervalMs !== undefined &&
		(typeof options.pollIntervalMs !== 'number' || options.pollIntervalMs < 0)
	) {
		throw new TypeError('pollIntervalMs must be a non-negative number.');
	}
}

function assertOption(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`createAgentMsgChannel() requires a non-empty ${field}.`);
	}
}

function assertRef(ref: AgentMsgRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidAgentMsgInputError('ref');
	assertIdentifier(ref.agentId, 'agentId');
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidAgentMsgInputError(field);
	}
}
