import type { Context, Env, Handler } from 'hono';
import {
	createInteractionTokenVerifier,
	createPubSubTokenVerifier,
	type GoogleChatInteractionAuthentication,
	type GoogleChatPubSubAuthentication,
} from './auth.ts';
import type {
	GoogleChatActionPayload,
	GoogleChatConversationRef,
	GoogleChatHandlerResult,
	GoogleChatInteraction,
	GoogleChatMessagePayload,
	GoogleChatUserRef,
	GoogleChatWorkspaceEvent,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 25_000;
const MAX_HANDLER_TIMEOUT_MS = 30_000;

interface GoogleChatInteractionsHandlerOptions<E extends Env> {
	authentication: GoogleChatInteractionAuthentication;
	handler(input: { c: Context<E>; event: GoogleChatInteraction }): GoogleChatHandlerResult;
	fetch?: typeof globalThis.fetch;
	bodyLimit?: number;
	handlerTimeoutMs?: number;
}

interface GoogleChatWorkspaceEventsHandlerOptions<E extends Env> {
	authentication: GoogleChatPubSubAuthentication;
	handler(input: { c: Context<E>; event: GoogleChatWorkspaceEvent }): GoogleChatHandlerResult;
	fetch?: typeof globalThis.fetch;
	bodyLimit?: number;
}

export function createGoogleChatInteractionsHandler<E extends Env>(
	options: GoogleChatInteractionsHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = validateBodyLimit(options.bodyLimit);
	const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(handlerTimeoutMs) ||
		handlerTimeoutMs <= 0 ||
		handlerTimeoutMs > MAX_HANDLER_TIMEOUT_MS
	) {
		throw new TypeError('Google Chat handlerTimeoutMs must be between 1 and 30000.');
	}
	const verifyToken = createInteractionTokenVerifier(options.authentication, options);

	return async (c) => {
		if (!isJsonRequest(c.req.raw)) return response(415);
		const raw = await readRequestJson(c.req.raw, bodyLimit);
		if (raw.type === 'too-large') return response(413);
		if (raw.type === 'invalid') return response(400);
		try {
			await verifyToken(c.req.header('authorization') ?? null);
		} catch {
			return response(401);
		}
		const event = normalizeInteraction(raw.value);
		if (!event) return response(400);
		return handleApplicationResult(
			await runHandler(() => options.handler({ c, event }), handlerTimeoutMs),
		);
	};
}

export function createGoogleChatWorkspaceEventsHandler<E extends Env>(
	options: GoogleChatWorkspaceEventsHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = validateBodyLimit(options.bodyLimit);
	const verifyToken = createPubSubTokenVerifier(options.authentication, options);

	return async (c) => {
		if (!isJsonRequest(c.req.raw)) return response(415);
		const raw = await readRequestJson(c.req.raw, bodyLimit);
		if (raw.type === 'too-large') return response(413);
		if (raw.type === 'invalid') return response(400);
		try {
			await verifyToken(c.req.header('authorization') ?? null);
		} catch {
			return response(401);
		}
		const event = normalizeWorkspaceEvent(raw.value);
		if (!event) return response(400);
		if (raw.value.subscription !== options.authentication.subscription) {
			return response(403);
		}
		return handleApplicationResult(await runHandler(() => options.handler({ c, event })));
	};
}

function normalizeInteraction(raw: Record<string, unknown>): GoogleChatInteraction | undefined {
	const interactionType = readString(raw, 'type');
	if (!interactionType) return undefined;
	const destination = normalizeConversation(raw);
	const user = normalizeUser(readRecord(raw, 'user'));
	const eventTime = readOptionalString(raw, 'eventTime');
	const common = {
		...(eventTime === undefined ? {} : { eventTime }),
		...(destination === undefined ? {} : { destination }),
		...(user === undefined ? {} : { user }),
		raw,
	};
	if (interactionType === 'MESSAGE') {
		const payload = normalizeMessage(readRecord(raw, 'message'));
		if (!payload) return undefined;
		return { ...common, type: 'message', payload };
	}
	if (interactionType === 'ADDED_TO_SPACE') {
		const payload = normalizeMessage(readRecord(raw, 'message')) ?? emptyMessagePayload();
		return { ...common, type: 'added_to_space', payload };
	}
	if (interactionType === 'REMOVED_FROM_SPACE') {
		return { ...common, type: 'removed_from_space', payload: {} };
	}
	if (interactionType === 'CARD_CLICKED') {
		return { ...common, type: 'card_clicked', payload: normalizeAction(raw) };
	}
	if (interactionType === 'APP_COMMAND') {
		const metadata = readRecord(raw, 'appCommandMetadata');
		const commandId = metadata && readOptionalString(metadata, 'appCommandId');
		const commandType = metadata && readOptionalString(metadata, 'appCommandType');
		return {
			...common,
			type: 'app_command',
			payload: {
				...(commandId ? { commandId } : {}),
				...(commandType ? { commandType } : {}),
			},
		};
	}
	if (interactionType === 'APP_HOME') {
		return { ...common, type: 'app_home', payload: normalizeAction(raw) };
	}
	if (interactionType === 'SUBMIT_FORM') {
		return { ...common, type: 'submit_form', payload: normalizeAction(raw) };
	}
	return { ...common, type: 'unknown', interactionType };
}

function normalizeWorkspaceEvent(
	raw: Record<string, unknown>,
): GoogleChatWorkspaceEvent | undefined {
	const message = readRecord(raw, 'message');
	if (!message) return undefined;
	const attributes = readRecord(message, 'attributes');
	const dataEncoded = readString(message, 'data');
	const pubsubMessageId = readString(message, 'messageId');
	if (!attributes || !dataEncoded || !pubsubMessageId) return undefined;
	const id = readString(attributes, 'ce-id');
	const source = readString(attributes, 'ce-source');
	const specVersion = readString(attributes, 'ce-specversion');
	const subject = readString(attributes, 'ce-subject');
	const eventType = readString(attributes, 'ce-type');
	const dataContentType = readString(attributes, 'ce-datacontenttype');
	if (!id || !source || !subject || !eventType) return undefined;
	if (
		!source.startsWith('//workspaceevents.googleapis.com/subscriptions/') ||
		specVersion !== '1.0' ||
		dataContentType !== 'application/json'
	) {
		return undefined;
	}
	const data = decodeBase64Json(dataEncoded);
	if (data === undefined) return undefined;
	const lifecycleEvent = eventType.startsWith('google.workspace.events.subscription.v1.');
	let destination: GoogleChatConversationRef | undefined;
	if (lifecycleEvent) {
		if (subject !== source) return undefined;
	} else {
		if (!subject.startsWith('//chat.googleapis.com/spaces/')) return undefined;
		const subjectSpace = subject.slice('//chat.googleapis.com/'.length);
		if (!/^spaces\/[^/]+$/.test(subjectSpace)) return undefined;
		destination =
			normalizeConversation(data) ??
			({
				space: subjectSpace,
				spaceType: 'UNKNOWN',
			} satisfies GoogleChatConversationRef);
		if (destination.space !== subjectSpace) return undefined;
	}
	return {
		type: normalizeWorkspaceEventType(eventType),
		eventType,
		attributes: {
			id,
			source,
			specVersion,
			subject,
			...(readOptionalString(attributes, 'ce-time') === undefined
				? {}
				: { time: readOptionalString(attributes, 'ce-time') }),
			dataContentType,
		},
		pubsubMessageId,
		...(readOptionalString(message, 'publishTime') === undefined
			? {}
			: { publishTime: readOptionalString(message, 'publishTime') }),
		...(readOptionalString(message, 'orderingKey') === undefined
			? {}
			: { orderingKey: readOptionalString(message, 'orderingKey') }),
		...(destination === undefined ? {} : { destination }),
		data,
		raw,
	};
}

function normalizeWorkspaceEventType(eventType: string): GoogleChatWorkspaceEvent['type'] {
	const known: Record<string, GoogleChatWorkspaceEvent['type']> = {
		'google.workspace.chat.message.v1.created': 'message_created',
		'google.workspace.chat.message.v1.updated': 'message_updated',
		'google.workspace.chat.message.v1.deleted': 'message_deleted',
		'google.workspace.chat.message.v1.batchCreated': 'message_batch_created',
		'google.workspace.chat.message.v1.batchUpdated': 'message_batch_updated',
		'google.workspace.chat.message.v1.batchDeleted': 'message_batch_deleted',
		'google.workspace.chat.membership.v1.created': 'membership_created',
		'google.workspace.chat.membership.v1.updated': 'membership_updated',
		'google.workspace.chat.membership.v1.deleted': 'membership_deleted',
		'google.workspace.chat.membership.v1.batchCreated': 'membership_batch_created',
		'google.workspace.chat.membership.v1.batchUpdated': 'membership_batch_updated',
		'google.workspace.chat.membership.v1.batchDeleted': 'membership_batch_deleted',
		'google.workspace.chat.reaction.v1.created': 'reaction_created',
		'google.workspace.chat.reaction.v1.deleted': 'reaction_deleted',
		'google.workspace.chat.reaction.v1.batchCreated': 'reaction_batch_created',
		'google.workspace.chat.reaction.v1.batchDeleted': 'reaction_batch_deleted',
		'google.workspace.chat.space.v1.updated': 'space_updated',
		'google.workspace.chat.space.v1.batchUpdated': 'space_batch_updated',
		'google.workspace.events.subscription.v1.suspended': 'subscription_suspended',
		'google.workspace.events.subscription.v1.expirationReminder':
			'subscription_expiration_reminder',
		'google.workspace.events.subscription.v1.expired': 'subscription_expired',
	};
	return known[eventType] ?? 'unknown';
}

function normalizeConversation(
	raw: Record<string, unknown>,
): GoogleChatConversationRef | undefined {
	const directSpace = readRecord(raw, 'space');
	const message = readRecord(raw, 'message');
	const space =
		(directSpace && readOptionalString(directSpace, 'name')) ??
		(message && readOptionalString(readRecord(message, 'space'), 'name'));
	if (!space || !/^spaces\/[^/]+$/.test(space)) return undefined;
	const threadRecord =
		readRecord(raw, 'thread') ??
		(message && readRecord(message, 'thread'));
	const thread = threadRecord && readOptionalString(threadRecord, 'name');
	const type =
		(directSpace && readOptionalString(directSpace, 'type')) ??
		(message && readOptionalString(readRecord(message, 'space'), 'type'));
	return {
		space,
		...(thread && /^spaces\/[^/]+\/threads\/[^/]+$/.test(thread) ? { thread } : {}),
		spaceType: normalizeSpaceType(type),
	};
}

function normalizeSpaceType(value: string | undefined): GoogleChatConversationRef['spaceType'] {
	if (value === 'SPACE' || value === 'GROUP_CHAT' || value === 'DIRECT_MESSAGE') return value;
	return 'UNKNOWN';
}

function normalizeUser(value: Record<string, unknown> | undefined): GoogleChatUserRef | undefined {
	if (!value) return undefined;
	const name = readString(value, 'name');
	if (!name || !/^users\/[^/]+$/.test(name)) return undefined;
	return {
		name,
		...(readOptionalString(value, 'displayName') === undefined
			? {}
			: { displayName: readOptionalString(value, 'displayName') }),
		...(readOptionalString(value, 'type') === undefined
			? {}
			: { type: readOptionalString(value, 'type') }),
		...(readOptionalString(value, 'domainId') === undefined
			? {}
			: { domainId: readOptionalString(value, 'domainId') }),
	};
}

function normalizeMessage(
	value: Record<string, unknown> | undefined,
): GoogleChatMessagePayload | undefined {
	if (!value) return undefined;
	const attachments = value.attachment ?? value.attachments;
	const annotations = value.annotations;
	if (
		(attachments !== undefined && !Array.isArray(attachments)) ||
		(annotations !== undefined && !Array.isArray(annotations))
	) {
		return undefined;
	}
	return {
		...(readOptionalString(value, 'name') === undefined
			? {}
			: { name: readOptionalString(value, 'name') }),
		...(readOptionalString(value, 'text') === undefined
			? {}
			: { text: readOptionalString(value, 'text') }),
		...(readOptionalString(value, 'argumentText') === undefined
			? {}
			: { argumentText: readOptionalString(value, 'argumentText') }),
		...(readOptionalString(value, 'formattedText') === undefined
			? {}
			: { formattedText: readOptionalString(value, 'formattedText') }),
		attachments: Array.isArray(attachments) ? attachments : [],
		annotations: Array.isArray(annotations) ? annotations : [],
	};
}

function emptyMessagePayload(): GoogleChatMessagePayload {
	return { attachments: [], annotations: [] };
}

function normalizeAction(raw: Record<string, unknown>): GoogleChatActionPayload {
	const action = readRecord(raw, 'action');
	const common = readRecord(raw, 'common');
	const stringParameters: Record<string, string> = {};
	const parameters = action?.parameters;
	if (Array.isArray(parameters)) {
		for (const parameter of parameters) {
			if (!isRecord(parameter)) continue;
			const key = readString(parameter, 'key');
			const value = parameter.value;
			if (key && typeof value === 'string') stringParameters[key] = value;
		}
	}
	const actionMethodName = action && readOptionalString(action, 'actionMethodName');
	return {
		...(actionMethodName ? { actionMethodName } : {}),
		parameters: stringParameters,
		...(common?.formInputs === undefined ? {} : { formInputs: common.formInputs }),
		...(readOptionalString(raw, 'dialogEventType') === undefined
			? {}
			: { dialogEventType: readOptionalString(raw, 'dialogEventType') }),
		...(typeof raw.isDialogEvent === 'boolean' ? { isDialogEvent: raw.isDialogEvent } : {}),
	};
}

function handleApplicationResult(
	outcome: { type: 'success'; value: Awaited<GoogleChatHandlerResult> } | { type: 'failure' },
): Response {
	if (outcome.type === 'failure') return response(500);
	if (outcome.value instanceof Response) return outcome.value;
	if (outcome.value === undefined) return response(200);
	if (!isJsonValue(outcome.value)) return response(500);
	return Response.json(outcome.value);
}

async function runHandler<T>(
	handler: () => Promise<T> | T,
	timeoutMs?: number,
): Promise<{ type: 'success'; value: T } | { type: 'failure' }> {
	try {
		if (timeoutMs === undefined) return { type: 'success', value: await handler() };
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const value = await Promise.race([
				Promise.resolve().then(handler),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error('Handler timeout.')), timeoutMs);
				}),
			]);
			return { type: 'success', value };
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	} catch {
		return { type: 'failure' };
	}
}

function validateBodyLimit(value: number | undefined): number {
	const bodyLimit = value ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Google Chat bodyLimit must be a positive integer.');
	}
	return bodyLimit;
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

async function readRequestJson(
	request: Request,
	limit: number,
): Promise<
	{ type: 'success'; value: Record<string, unknown> } | { type: 'invalid' } | { type: 'too-large' }
> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null) {
		if (!/^\d+$/.test(contentLength)) return { type: 'invalid' };
		if (Number(contentLength) > limit) return { type: 'too-large' };
	}
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await request.arrayBuffer());
	} catch {
		return { type: 'invalid' };
	}
	if (bytes.byteLength > limit) return { type: 'too-large' };
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(value) ? { type: 'success', value } : { type: 'invalid' };
	} catch {
		return { type: 'invalid' };
	}
}

function decodeBase64Json(value: string): Record<string, unknown> | undefined {
	try {
		const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function readRecord(
	record: Record<string, unknown> | undefined,
	field: string,
): Record<string, unknown> | undefined {
	const value = record?.[field];
	return isRecord(value) ? value : undefined;
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalString(
	record: Record<string, unknown> | undefined,
	field: string,
): string | undefined {
	const value = record?.[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	) {
		return true;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
}

function response(status: number): Response {
	return new Response(null, { status });
}
