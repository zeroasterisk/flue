import type { Context, Env, Handler } from 'hono';
import type Stripe from 'stripe';
import type {
	JsonValue,
	StripeChannelOptions,
	StripeHandlerResult,
	StripeSnapshotChannelOptions,
	StripeThinChannelOptions,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function createStripeWebhookHandler<E extends Env>(
	options: StripeChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Stripe webhook bodyLimit must be a positive integer.');
	}
	const signatureToleranceSeconds = options.signatureToleranceSeconds;
	if (
		signatureToleranceSeconds !== undefined &&
		(!Number.isSafeInteger(signatureToleranceSeconds) || signatureToleranceSeconds <= 0)
	) {
		throw new TypeError('Stripe webhook signatureToleranceSeconds must be a positive integer.');
	}

	return async (c) => {
		const request = c.req.raw;
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (!isJsonRequest(request)) return response(415);
		if (contentLength !== null && Number(contentLength) > bodyLimit) {
			return response(413);
		}

		const signature = request.headers.get('stripe-signature');
		if (!signature) return response(400);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		if (options.eventPayload === 'thin') {
			return handleThinEvent(options, c, body.value, signature);
		}
		return handleSnapshotEvent(options, c, body.value, signature);
	};
}

async function handleSnapshotEvent<E extends Env>(
	options: StripeSnapshotChannelOptions<E>,
	c: Context<E>,
	body: Uint8Array,
	signature: string,
): Promise<Response> {
	let event: Stripe.Event;
	try {
		event = await options.client.webhooks.constructEventAsync(
			body,
			signature,
			options.webhookSecret,
			options.signatureToleranceSeconds,
		);
	} catch {
		return response(400);
	}
	if (!isSnapshotEvent(event)) return response(400);
	return runWebhook(() => options.webhook({ c, event }));
}

async function handleThinEvent<E extends Env>(
	options: StripeThinChannelOptions<E>,
	c: Context<E>,
	body: Uint8Array,
	signature: string,
): Promise<Response> {
	let event: Stripe.V2.Core.EventNotification;
	try {
		event = await options.client.parseEventNotificationAsync(
			body,
			signature,
			options.webhookSecret,
			options.signatureToleranceSeconds,
		);
	} catch {
		return response(400);
	}
	if (!isThinEvent(event)) return response(400);
	return runWebhook(() => options.webhook({ c, event }));
}

async function runWebhook(webhook: () => StripeHandlerResult): Promise<Response> {
	try {
		return serializeHandlerResult(await webhook());
	} catch {
		return response(500);
	}
}

function serializeHandlerResult(value: unknown): Response {
	if (value instanceof Response) return value;
	if (value === undefined) return response(200);
	if (!isJsonValue(value)) return response(500);
	return Response.json(value);
}

function isSnapshotEvent(value: unknown): value is Stripe.Event {
	if (!isRecord(value)) return false;
	return (
		value.object === 'event' &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.type) &&
		typeof value.livemode === 'boolean' &&
		typeof value.created === 'number' &&
		Number.isFinite(value.created) &&
		(value.api_version === null || typeof value.api_version === 'string') &&
		Number.isSafeInteger(value.pending_webhooks) &&
		(value.pending_webhooks as number) >= 0 &&
		isStripeRequest(value.request) &&
		isRecord(value.data) &&
		Object.hasOwn(value.data, 'object')
	);
}

function isThinEvent(value: unknown): value is Stripe.V2.Core.EventNotification {
	if (!isRecord(value)) return false;
	return (
		value.object === 'v2.core.event' &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.type) &&
		isNonEmptyString(value.created) &&
		typeof value.livemode === 'boolean' &&
		isStripeContext(value.context) &&
		isRelatedObject(value.related_object) &&
		typeof value.fetchEvent === 'function' &&
		typeof value.fetchRelatedObject === 'function'
	);
}

function isStripeRequest(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	return (
		(value.id === null || typeof value.id === 'string') &&
		(value.idempotency_key === null || typeof value.idempotency_key === 'string')
	);
}

function isStripeContext(value: unknown): boolean {
	return (
		value === undefined ||
		(isRecord(value) && typeof value.toString === 'function' && Array.isArray(value.segments))
	);
}

function isRelatedObject(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(isRecord(value) &&
			isNonEmptyString(value.id) &&
			isNonEmptyString(value.type) &&
			isNonEmptyString(value.url))
	);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
	seen.add(value);
	try {
		return Array.isArray(value)
			? value.every((item) => isJsonValue(item, seen))
			: Object.values(value).every((item) => isJsonValue(item, seen));
	} finally {
		seen.delete(value);
	}
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

async function readBody(
	request: Request,
	bodyLimit: number,
): Promise<{ type: 'success'; value: Uint8Array } | { type: 'too-large' } | { type: 'invalid' }> {
	if (!request.body) return { type: 'success', value: new Uint8Array() };
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
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
	} catch {
		return { type: 'invalid' };
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { type: 'success', value: body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function response(status: number): Response {
	return new Response(null, { status });
}
