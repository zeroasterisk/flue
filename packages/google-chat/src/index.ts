import type { Context, Env, Handler } from 'hono';
import type {
	GoogleChatInteractionAuthentication,
	GoogleChatPubSubAuthentication,
} from './auth.ts';
import { InvalidGoogleChatConversationKeyError, InvalidGoogleChatInputError } from './errors.ts';
import {
	createGoogleChatInteractionsHandler,
	createGoogleChatWorkspaceEventsHandler,
} from './routes.ts';

export type {
	GoogleChatInteractionAuthentication,
	GoogleChatPubSubAuthentication,
} from './auth.ts';
export { InvalidGoogleChatConversationKeyError, InvalidGoogleChatInputError } from './errors.ts';

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

export interface GoogleChatChannelOptions<E extends Env = Env> {
	/** Direct Google Chat request authentication and callback. */
	interactions?: {
		authentication: GoogleChatInteractionAuthentication;
		handler(input: GoogleChatInteractionHandlerInput<E>): GoogleChatHandlerResult;
	};
	/** Optional authenticated Pub/Sub push surface for Google Workspace Events. */
	workspaceEvents?: {
		authentication: GoogleChatPubSubAuthentication;
		handler(input: GoogleChatWorkspaceEventHandlerInput<E>): GoogleChatHandlerResult;
	};
	/** Fetch implementation used only for Google signing-key discovery. */
	fetch?: typeof globalThis.fetch;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Direct interaction handler deadline. Defaults to 25 seconds; maximum 30 seconds. */
	handlerTimeoutMs?: number;
}

export interface GoogleChatUserRef {
	name: string;
	displayName?: string;
	type?: string;
	domainId?: string;
}

export interface GoogleChatConversationRef {
	/** Google Chat space resource name in `spaces/<id>` form. */
	space: string;
	/** Optional thread resource name in `spaces/<id>/threads/<id>` form. */
	thread?: string;
	spaceType?: 'SPACE' | 'GROUP_CHAT' | 'DIRECT_MESSAGE' | 'UNKNOWN';
}

export interface GoogleChatMessagePayload {
	name?: string;
	text?: string;
	argumentText?: string;
	formattedText?: string;
	attachments: readonly unknown[];
	annotations: readonly unknown[];
}

export interface GoogleChatActionPayload {
	actionMethodName?: string;
	parameters: Readonly<Record<string, string>>;
	formInputs?: unknown;
	dialogEventType?: string;
	isDialogEvent?: boolean;
}

export interface GoogleChatAppCommandPayload {
	commandId?: string;
	commandType?: string;
}

export interface GoogleChatInteractionEnvelope<TType extends string, TPayload> {
	type: TType;
	eventTime?: string;
	destination?: GoogleChatConversationRef;
	user?: GoogleChatUserRef;
	payload: TPayload;
	/** Complete parsed interaction after request authentication. */
	raw: unknown;
}

export type GoogleChatMessageInteraction = GoogleChatInteractionEnvelope<
	'message',
	GoogleChatMessagePayload
>;
export type GoogleChatAddedToSpaceInteraction = GoogleChatInteractionEnvelope<
	'added_to_space',
	GoogleChatMessagePayload
>;
export type GoogleChatRemovedFromSpaceInteraction = GoogleChatInteractionEnvelope<
	'removed_from_space',
	Record<string, never>
>;
export type GoogleChatCardClickedInteraction = GoogleChatInteractionEnvelope<
	'card_clicked',
	GoogleChatActionPayload
>;
export type GoogleChatAppCommandInteraction = GoogleChatInteractionEnvelope<
	'app_command',
	GoogleChatAppCommandPayload
>;
export type GoogleChatAppHomeInteraction = GoogleChatInteractionEnvelope<
	'app_home',
	GoogleChatActionPayload
>;
export type GoogleChatSubmitFormInteraction = GoogleChatInteractionEnvelope<
	'submit_form',
	GoogleChatActionPayload
>;
export interface GoogleChatUnknownInteraction extends Omit<
	GoogleChatInteractionEnvelope<'unknown', never>,
	'payload'
> {
	interactionType: string;
}

export type GoogleChatInteraction =
	| GoogleChatMessageInteraction
	| GoogleChatAddedToSpaceInteraction
	| GoogleChatRemovedFromSpaceInteraction
	| GoogleChatCardClickedInteraction
	| GoogleChatAppCommandInteraction
	| GoogleChatAppHomeInteraction
	| GoogleChatSubmitFormInteraction
	| GoogleChatUnknownInteraction;

export interface GoogleChatCloudEventAttributes {
	id: string;
	source: string;
	specVersion: '1.0';
	subject: string;
	time?: string;
	dataContentType: 'application/json';
}

export interface GoogleChatWorkspaceEventEnvelope<TType extends string> {
	type: TType;
	eventType: string;
	attributes: GoogleChatCloudEventAttributes;
	pubsubMessageId: string;
	publishTime?: string;
	orderingKey?: string;
	/** Chat destination. Absent for subscription lifecycle events. */
	destination?: GoogleChatConversationRef;
	/** Decoded CloudEvent JSON data. */
	data: unknown;
	/** Complete parsed Pub/Sub push body after request authentication. */
	raw: unknown;
}

export type GoogleChatWorkspaceEvent =
	| GoogleChatWorkspaceEventEnvelope<'message_created'>
	| GoogleChatWorkspaceEventEnvelope<'message_updated'>
	| GoogleChatWorkspaceEventEnvelope<'message_deleted'>
	| GoogleChatWorkspaceEventEnvelope<'message_batch_created'>
	| GoogleChatWorkspaceEventEnvelope<'message_batch_updated'>
	| GoogleChatWorkspaceEventEnvelope<'message_batch_deleted'>
	| GoogleChatWorkspaceEventEnvelope<'membership_created'>
	| GoogleChatWorkspaceEventEnvelope<'membership_updated'>
	| GoogleChatWorkspaceEventEnvelope<'membership_deleted'>
	| GoogleChatWorkspaceEventEnvelope<'membership_batch_created'>
	| GoogleChatWorkspaceEventEnvelope<'membership_batch_updated'>
	| GoogleChatWorkspaceEventEnvelope<'membership_batch_deleted'>
	| GoogleChatWorkspaceEventEnvelope<'reaction_created'>
	| GoogleChatWorkspaceEventEnvelope<'reaction_deleted'>
	| GoogleChatWorkspaceEventEnvelope<'reaction_batch_created'>
	| GoogleChatWorkspaceEventEnvelope<'reaction_batch_deleted'>
	| GoogleChatWorkspaceEventEnvelope<'space_updated'>
	| GoogleChatWorkspaceEventEnvelope<'space_batch_updated'>
	| GoogleChatWorkspaceEventEnvelope<'subscription_suspended'>
	| GoogleChatWorkspaceEventEnvelope<'subscription_expiration_reminder'>
	| GoogleChatWorkspaceEventEnvelope<'subscription_expired'>
	| GoogleChatWorkspaceEventEnvelope<'unknown'>;

type GoogleChatHandlerValue = undefined | JsonValue | Response;

export type GoogleChatHandlerResult = GoogleChatHandlerValue | Promise<GoogleChatHandlerValue>;

export interface GoogleChatInteractionHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: GoogleChatInteraction;
}

export interface GoogleChatWorkspaceEventHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: GoogleChatWorkspaceEvent;
}

export interface GoogleChatChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: GoogleChatConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): GoogleChatConversationRef;
}

/**
 * Creates verified Google Chat interaction and optional Workspace Event routes.
 *
 * At least one surface is required. Omitted surfaces do not publish routes.
 */
export function createGoogleChatChannel<E extends Env = Env>(
	options: GoogleChatChannelOptions<E>,
): GoogleChatChannel<E> {
	validateOptions(options);
	const routes: ChannelRoute<E>[] = [];
	if (options.interactions) {
		routes.push({
			method: 'POST',
			path: '/interactions',
			handler: createGoogleChatInteractionsHandler({
				authentication: options.interactions.authentication,
				handler: options.interactions.handler,
				fetch: options.fetch,
				bodyLimit: options.bodyLimit,
				handlerTimeoutMs: options.handlerTimeoutMs,
			}),
		});
	}
	if (options.workspaceEvents) {
		routes.push({
			method: 'POST',
			path: '/events',
			handler: createGoogleChatWorkspaceEventsHandler({
				authentication: options.workspaceEvents.authentication,
				handler: options.workspaceEvents.handler,
				fetch: options.fetch,
				bodyLimit: options.bodyLimit,
			}),
		});
	}

	const channel: GoogleChatChannel<E> = {
		routes,
		conversationKey(ref) {
			assertConversationRef(ref);
			return [
				'google-chat',
				'v1',
				encodeURIComponent(ref.space),
				encodeURIComponent(ref.thread ?? ''),
			].join(':');
		},
		parseConversationKey(id) {
			try {
				const parts = id.split(':');
				if (parts.length !== 4 || parts[0] !== 'google-chat' || parts[1] !== 'v1') {
					throw new InvalidGoogleChatConversationKeyError();
				}
				const ref: GoogleChatConversationRef = {
					space: decodeURIComponent(requiredPart(parts[2])),
					...(parts[3] ? { thread: decodeURIComponent(parts[3]) } : {}),
				};
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidGoogleChatConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidGoogleChatConversationKeyError) throw error;
				throw new InvalidGoogleChatConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: GoogleChatChannelOptions<E>): void {
	if (!options || typeof options !== 'object') throw new InvalidGoogleChatInputError('options');
	if (!options.interactions && !options.workspaceEvents) {
		throw new InvalidGoogleChatInputError('interactions or workspaceEvents');
	}
	if (options.fetch !== undefined && typeof options.fetch !== 'function') {
		throw new InvalidGoogleChatInputError('fetch');
	}
	if (options.interactions) {
		validateInteractionAuthentication(options.interactions.authentication);
		if (typeof options.interactions.handler !== 'function') {
			throw new InvalidGoogleChatInputError('interactions.handler');
		}
	}
	if (options.workspaceEvents) {
		validatePubSubAuthentication(options.workspaceEvents.authentication);
		if (typeof options.workspaceEvents.handler !== 'function') {
			throw new InvalidGoogleChatInputError('workspaceEvents.handler');
		}
	}
}

function validateInteractionAuthentication(
	authentication: GoogleChatInteractionAuthentication,
): void {
	if (!authentication || typeof authentication !== 'object') {
		throw new InvalidGoogleChatInputError('interactions.authentication');
	}
	if (authentication.type === 'endpoint-url') {
		assertHttpsUrl(authentication.audience, 'interactions.authentication.audience');
		if (authentication.jwksUrl !== undefined) {
			assertHttpsUrl(authentication.jwksUrl, 'interactions.authentication.jwksUrl');
		}
		return;
	}
	if (authentication.type === 'project-number') {
		if (!/^\d+$/.test(authentication.projectNumber)) {
			throw new InvalidGoogleChatInputError('interactions.authentication.projectNumber');
		}
		if (authentication.certificatesUrl !== undefined) {
			assertHttpsUrl(authentication.certificatesUrl, 'interactions.authentication.certificatesUrl');
		}
		return;
	}
	throw new InvalidGoogleChatInputError('interactions.authentication.type');
}

function validatePubSubAuthentication(authentication: GoogleChatPubSubAuthentication): void {
	if (!authentication || typeof authentication !== 'object') {
		throw new InvalidGoogleChatInputError('workspaceEvents.authentication');
	}
	if (!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(authentication.subscription)) {
		throw new InvalidGoogleChatInputError('workspaceEvents.authentication.subscription');
	}
	assertNonEmpty(authentication.audience, 'workspaceEvents.authentication.audience');
	if (!authentication.serviceAccountEmail.includes('@')) {
		throw new InvalidGoogleChatInputError('workspaceEvents.authentication.serviceAccountEmail');
	}
	if (authentication.jwksUrl !== undefined) {
		assertHttpsUrl(authentication.jwksUrl, 'workspaceEvents.authentication.jwksUrl');
	}
}

function assertConversationRef(ref: GoogleChatConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidGoogleChatInputError('ref');
	if (!/^spaces\/[^/]+$/.test(ref.space)) throw new InvalidGoogleChatInputError('ref.space');
	if (ref.thread !== undefined && !/^spaces\/[^/]+\/threads\/[^/]+$/.test(ref.thread)) {
		throw new InvalidGoogleChatInputError('ref.thread');
	}
	if (
		ref.spaceType !== undefined &&
		!['SPACE', 'GROUP_CHAT', 'DIRECT_MESSAGE', 'UNKNOWN'].includes(ref.spaceType)
	) {
		throw new InvalidGoogleChatInputError('ref.spaceType');
	}
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new InvalidGoogleChatInputError(field);
	}
}

function assertHttpsUrl(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string') throw new InvalidGoogleChatInputError(field);
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.username !== '' ||
			url.password !== '' ||
			url.hash !== ''
		) {
			throw new InvalidGoogleChatInputError(field);
		}
	} catch (error) {
		if (error instanceof InvalidGoogleChatInputError) throw error;
		throw new InvalidGoogleChatInputError(field);
	}
}

function requiredPart(value: string | undefined): string {
	if (!value) throw new InvalidGoogleChatConversationKeyError();
	return value;
}
