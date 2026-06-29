import type { Context, Env, Handler } from 'hono';
import type {
	A2AAgentCard,
	A2AMessage,
	A2AMessageHandlerInput,
	A2AMessageHandlerResult,
	A2ASendMessageRequest,
	A2ASendMessageResponse,
	A2ATask,
	A2ATaskState,
} from './index.ts';
import { A2A_ERROR_REASONS } from './types.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MiB
const A2A_CONTENT_TYPE = 'application/a2a+json';
const JSON_CONTENT_TYPE = 'application/json';

interface AgentCardHandlerOptions {
	agentCard: A2AAgentCard;
}

export function createAgentCardHandler<E extends Env>(
	options: AgentCardHandlerOptions,
): Handler<E> {
	const cardJson = JSON.stringify(options.agentCard);
	const headers = {
		'Content-Type': JSON_CONTENT_TYPE,
		'Cache-Control': 'public, max-age=3600',
	} as const;

	return (c) => {
		return c.newResponse(cardJson, { status: 200, headers });
	};
}

interface SendMessageHandlerOptions<E extends Env> {
	bodyLimit?: number;
	onMessage(input: A2AMessageHandlerInput<E>): A2AMessageHandlerResult;
}

export function createSendMessageHandler<E extends Env>(
	options: SendMessageHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('A2A sendMessage bodyLimit must be a positive integer.');
	}

	return async (c) => {
		const request = c.req.raw;

		// Validate content type — accept both application/a2a+json and application/json
		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== A2A_CONTENT_TYPE && mediaType !== JSON_CONTENT_TYPE) {
			return new Response(null, { status: 415 });
		}

		// Check content length
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return new Response(null, { status: 400 });
			if (Number(contentLength) > bodyLimit) return new Response(null, { status: 413 });
		}

		// Read and parse body
		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return new Response(null, { status: 400 });
		}
		if (!body) return new Response(null, { status: 413 });

		const parsed = parseJson(body);
		if (!isRecord(parsed)) return a2aErrorResponse(400, 'Invalid JSON body.');

		// Validate as SendMessageRequest
		const sendRequest = parsed as unknown as A2ASendMessageRequest;
		if (!sendRequest.message || !isRecord(sendRequest.message)) {
			return a2aErrorResponse(400, 'Missing or invalid "message" field.');
		}

		const message = sendRequest.message as A2AMessage;
		if (!message.messageId || typeof message.messageId !== 'string') {
			return a2aErrorResponse(400, 'Missing or invalid "message.messageId".');
		}
		if (!message.role || typeof message.role !== 'string') {
			return a2aErrorResponse(400, 'Missing or invalid "message.role".');
		}
		if (!Array.isArray(message.parts) || message.parts.length === 0) {
			return a2aErrorResponse(400, 'Missing or empty "message.parts".');
		}

		// Terminal-state validation for taskId (spec Section 3.1.1: sending to
		// a terminal task MUST return UnsupportedOperationError) is delegated
		// to the onMessage callback, which owns task-state lookups.
		const taskId = message.taskId;
		const contextId = message.contextId;

		// Invoke the application callback
		try {
			const result = await options.onMessage({
				c: c as Context<E>,
				message,
				taskId,
				contextId,
				configuration: sendRequest.configuration,
				metadata: sendRequest.metadata,
			});

			return serializeResponse(result);
		} catch (error) {
			if (error instanceof A2AProtocolError) {
				return a2aErrorResponse(error.statusCode, error.message, error.reason);
			}
			return a2aErrorResponse(500, 'Internal server error.');
		}
	};
}

interface GetTaskHandlerOptions<E extends Env> {
	onGetTask(input: {
		c: Context<E>;
		taskId: string;
		historyLength?: number;
	}): Promise<A2ATask | null> | A2ATask | null;
}

export function createGetTaskHandler<E extends Env>(
	options: GetTaskHandlerOptions<E>,
): Handler<E> {
	return async (c) => {
		const taskId = c.req.param('taskId');
		if (!taskId) return a2aErrorResponse(400, 'Missing task ID.');

		const historyLengthParam = c.req.query('historyLength');
		const historyLength =
			historyLengthParam !== undefined ? parseHistoryLength(historyLengthParam) : undefined;

		try {
			const task = await options.onGetTask({
				c: c as Context<E>,
				taskId,
				historyLength,
			});
			if (!task) {
				return a2aErrorResponse(
					404,
					`Task ${taskId} not found.`,
					A2A_ERROR_REASONS.TASK_NOT_FOUND,
				);
			}
			return Response.json(task, {
				status: 200,
				headers: { 'Content-Type': A2A_CONTENT_TYPE },
			});
		} catch {
			return a2aErrorResponse(500, 'Internal server error.');
		}
	};
}

interface CancelTaskHandlerOptions<E extends Env> {
	onCancelTask(input: {
		c: Context<E>;
		taskId: string;
		metadata?: Record<string, unknown>;
	}): Promise<A2ATask | null> | A2ATask | null;
}

/**
 * The Hono route for cancel uses `/tasks/:taskIdAction` where the
 * URL looks like `/tasks/{id}:cancel` (Google API custom-method
 * convention). The handler parses the `:cancel` suffix from the
 * captured parameter.
 */
export function createCancelTaskHandler<E extends Env>(
	options: CancelTaskHandlerOptions<E>,
): Handler<E> {
	return async (c) => {
		const raw = c.req.param('taskIdAction') ?? '';
		if (!raw.endsWith(':cancel')) {
			return a2aErrorResponse(404, 'Not found.');
		}
		const taskId = raw.slice(0, -':cancel'.length);
		if (!taskId) return a2aErrorResponse(400, 'Missing task ID.');

		let metadata: Record<string, unknown> | undefined;
		const mediaType = c.req.raw.headers
			.get('content-type')
			?.split(';', 1)[0]
			?.trim()
			.toLowerCase();
		if (mediaType === JSON_CONTENT_TYPE || mediaType === A2A_CONTENT_TYPE) {
			try {
				const body = await c.req.raw.text();
				if (body) {
					const parsed = JSON.parse(body) as Record<string, unknown>;
					metadata = (parsed.metadata ?? undefined) as Record<string, unknown> | undefined;
				}
			} catch {
				// No body or invalid JSON is acceptable for cancel
			}
		}

		try {
			// State validation (is the task cancelable?) is the responsibility
			// of the onCancelTask callback. If the task cannot be canceled, the
			// callback should throw A2AProtocolError with reason
			// TASK_NOT_CANCELABLE and status 400.
			const task = await options.onCancelTask({
				c: c as Context<E>,
				taskId,
				metadata,
			});
			if (!task) {
				return a2aErrorResponse(
					404,
					`Task ${taskId} not found.`,
					A2A_ERROR_REASONS.TASK_NOT_FOUND,
				);
			}
			return Response.json(task, {
				status: 200,
				headers: { 'Content-Type': A2A_CONTENT_TYPE },
			});
		} catch (error) {
			if (error instanceof A2AProtocolError) {
				return a2aErrorResponse(error.statusCode, error.message, error.reason);
			}
			return a2aErrorResponse(500, 'Internal server error.');
		}
	};
}

// ---------------------------------------------------------------------------
// A2AProtocolError — throwable from application callbacks
// ---------------------------------------------------------------------------

export class A2AProtocolError extends Error {
	/** A2A error reason code (e.g. `"TASK_NOT_FOUND"`). */
	readonly reason: string;
	/** HTTP status code. */
	readonly statusCode: number;

	constructor(options: { status: number; reason: string; message?: string }) {
		super(options.message ?? options.reason);
		this.name = 'A2AProtocolError';
		this.reason = options.reason;
		this.statusCode = options.status;
	}
}

/** Returns UnsupportedOperationError for unimplemented spec endpoints. */
export function createUnsupportedHandler<E extends Env>(
	operation: string,
): Handler<E> {
	return () => {
		return a2aErrorResponse(
			400,
			`${operation} is not supported by this agent.`,
			A2A_ERROR_REASONS.UNSUPPORTED_OPERATION,
		);
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeResponse(value: A2ASendMessageResponse | undefined | Response): Response {
	if (value === undefined) return new Response(null, { status: 200 });
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value, {
		status: 200,
		headers: { 'Content-Type': A2A_CONTENT_TYPE },
	});
}

/** Maps HTTP status codes to canonical google.rpc status names. */
function httpStatusName(status: number): string {
	switch (status) {
		case 400:
			return 'INVALID_ARGUMENT';
		case 401:
			return 'UNAUTHENTICATED';
		case 403:
			return 'PERMISSION_DENIED';
		case 404:
			return 'NOT_FOUND';
		case 409:
			return 'ABORTED';
		case 413:
			return 'RESOURCE_EXHAUSTED';
		case 415:
			return 'INVALID_ARGUMENT';
		case 500:
			return 'INTERNAL';
		default:
			return 'UNKNOWN';
	}
}

/**
 * Builds a `google.rpc.Status` JSON error response per A2A spec
 * Section 11.6.
 */
function a2aErrorResponse(
	httpStatus: number,
	message: string,
	reason?: string,
): Response {
	const body = {
		error: {
			code: httpStatus,
			status: httpStatusName(httpStatus),
			message,
			details: reason
				? [
						{
							'@type': 'type.googleapis.com/google.rpc.ErrorInfo',
							reason,
							domain: 'a2a-protocol.org',
						},
					]
				: [],
		},
	};
	return Response.json(body, {
		status: httpStatus,
		headers: { 'Content-Type': A2A_CONTENT_TYPE },
	});
}

async function readBody(request: Request, bodyLimit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > bodyLimit) {
				void reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

/**
 * Parses a historyLength query parameter. The A2A spec (Section 3.2.4)
 * allows negative values to mean "last N messages", so both positive
 * and negative integers are accepted.
 */
function parseHistoryLength(value: string): number | undefined {
	if (!/^-?\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
