import type { Env, Handler } from 'hono';
import type {
	TwilioChannelOptions,
	TwilioConversationRef,
	TwilioIncomingMessageBody,
	TwilioStatusCallbackBody,
	TwilioWebhookBody,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface ConfiguredUrl {
	signatureUrl: string;
}

interface ParsedForm {
	values: ReadonlyMap<string, readonly string[]>;
	body: TwilioWebhookBody;
}

interface AcceptedRequest {
	form: ParsedForm;
	idempotencyToken?: string;
}

export function createTwilioWebhookHandler<E extends Env>(
	options: TwilioChannelOptions<E>,
): Handler<E> {
	const bodyLimit = resolveBodyLimit(options.bodyLimit);
	const configuredUrl = parseConfiguredUrl(options.webhookUrl);
	const key = importSigningKey(options.authToken);

	return async (c) => {
		const accepted = await acceptSignedForm(
			c.req.raw,
			configuredUrl,
			bodyLimit,
			key,
		);
		if (accepted instanceof Response) return accepted;

		const body = accepted.form.body as TwilioIncomingMessageBody;
		if (
			!isRequired(body.MessageSid) ||
			!isRequired(body.AccountSid) ||
			!isRequired(body.From) ||
			!isRequired(body.To)
		) {
			return response(400);
		}
		if (body.AccountSid !== options.accountSid) return response(403);

		const conversation = incomingConversation(options, body);
		if (!conversation) return response(403);

		let result: unknown;
		try {
			result = await options.webhook({
				c,
				body,
				conversation,
				...(accepted.idempotencyToken === undefined
					? {}
					: { idempotencyToken: accepted.idempotencyToken }),
			});
		} catch {
			return response(500);
		}
		return serializeHandlerResult(result, true);
	};
}

export function createTwilioStatusCallbackHandler<E extends Env>(
	options: TwilioChannelOptions<E>,
): Handler<E> {
	const bodyLimit = resolveBodyLimit(options.bodyLimit);
	const configuredUrl = parseConfiguredUrl(options.statusCallbackUrl as string);
	const key = importSigningKey(options.authToken);
	const callback = options.statusCallback as NonNullable<
		TwilioChannelOptions<E>['statusCallback']
	>;

	return async (c) => {
		const accepted = await acceptSignedForm(
			c.req.raw,
			configuredUrl,
			bodyLimit,
			key,
		);
		if (accepted instanceof Response) return accepted;

		const body = accepted.form.body as TwilioStatusCallbackBody;
		if (
			!isRequired(body.MessageSid) ||
			!isRequired(body.AccountSid) ||
			!isRequired(body.MessageStatus)
		) {
			return response(400);
		}
		if (body.AccountSid !== options.accountSid) return response(403);

		const conversation = statusConversation(options, body);

		let result: unknown;
		try {
			result = await callback({
				c,
				body,
				...(conversation === undefined ? {} : { conversation }),
				...(accepted.idempotencyToken === undefined
					? {}
					: { idempotencyToken: accepted.idempotencyToken }),
			});
		} catch {
			return response(500);
		}
		return serializeHandlerResult(result, false);
	};
}

async function acceptSignedForm(
	request: Request,
	configuredUrl: ConfiguredUrl,
	bodyLimit: number,
	key: Promise<CryptoKey>,
): Promise<AcceptedRequest | Response> {
	if (!isFormRequest(request)) return response(415);

	const body = await readBody(request, bodyLimit);
	if (body.type === 'too-large') return response(413);
	if (body.type === 'invalid') return response(400);
	const form = parseForm(body.value);
	if (!form) return response(400);

	const signature = request.headers.get('x-twilio-signature');
	if (
		!signature ||
		!(await verifySignature(
			await key,
			signature,
			configuredUrl.signatureUrl,
			form.values,
		))
	) {
		return response(401);
	}

	const idempotencyToken = optionalHeader(
		request.headers.get('i-twilio-idempotency-token'),
	);
	return {
		form,
		...(idempotencyToken === undefined ? {} : { idempotencyToken }),
	};
}

function incomingConversation<E extends Env>(
	options: TwilioChannelOptions<E>,
	body: TwilioIncomingMessageBody,
): TwilioConversationRef | undefined {
	if (options.destination.type === 'address') {
		if (body.To !== options.destination.address) return undefined;
		return {
			type: 'address',
			accountSid: body.AccountSid,
			address: body.To,
			participant: body.From,
		};
	}
	if (body.MessagingServiceSid !== options.destination.messagingServiceSid) {
		return undefined;
	}
	return {
		type: 'messaging-service',
		accountSid: body.AccountSid,
		messagingServiceSid: options.destination.messagingServiceSid,
		address: body.To,
		participant: body.From,
	};
}

function statusConversation<E extends Env>(
	options: TwilioChannelOptions<E>,
	body: TwilioStatusCallbackBody,
): TwilioConversationRef | undefined {
	const { From, To } = body;
	if (!isRequired(From) || !isRequired(To)) return undefined;
	return options.destination.type === 'address'
		? {
				type: 'address',
				accountSid: body.AccountSid,
				address: From,
				participant: To,
			}
		: {
				type: 'messaging-service',
				accountSid: body.AccountSid,
				messagingServiceSid: options.destination.messagingServiceSid,
				address: From,
				participant: To,
			};
}

function parseConfiguredUrl(value: string): ConfiguredUrl {
	const fragmentIndex = value.indexOf('#');
	const signatureUrl =
		fragmentIndex === -1 ? value : value.slice(0, fragmentIndex);
	return { signatureUrl };
}

function resolveBodyLimit(value: number | undefined): number {
	const bodyLimit = value ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Twilio webhook bodyLimit must be a positive integer.');
	}
	return bodyLimit;
}

function isFormRequest(request: Request): boolean {
	return (
		request.headers
			.get('content-type')
			?.split(';', 1)[0]
			?.trim()
			.toLowerCase() === 'application/x-www-form-urlencoded'
	);
}

function parseForm(body: string): ParsedForm | undefined {
	let params: URLSearchParams;
	try {
		params = new URLSearchParams(body);
	} catch {
		return undefined;
	}
	const values = new Map<string, string[]>();
	for (const [name, value] of params) {
		const existing = values.get(name);
		if (existing) existing.push(value);
		else values.set(name, [value]);
	}
	const native: Record<string, string | readonly string[]> = {};
	for (const [name, list] of values) {
		Object.defineProperty(native, name, {
			value: list.length === 1 ? list[0] : Object.freeze([...list]),
			enumerable: true,
		});
	}
	return { values, body: Object.freeze(native) as TwilioWebhookBody };
}

async function importSigningKey(authToken: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(authToken),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['verify'],
	);
}

async function verifySignature(
	key: CryptoKey,
	signature: string,
	url: string,
	form: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
	const signatureBytes = decodeBase64(signature);
	if (!signatureBytes) return false;
	const names = [...form.keys()].sort();
	let data = url;
	for (const name of names) {
		const values = [...new Set(form.get(name) ?? [])].sort();
		for (const value of values) data += `${name}${value}`;
	}
	try {
		return crypto.subtle.verify(
			'HMAC',
			key,
			toArrayBuffer(signatureBytes),
			toArrayBuffer(encoder.encode(data)),
		);
	} catch {
		return false;
	}
}

function decodeBase64(value: string): Uint8Array | undefined {
	try {
		const decoded = atob(value);
		const bytes = new Uint8Array(decoded.length);
		for (let index = 0; index < decoded.length; index += 1) {
			bytes[index] = decoded.charCodeAt(index);
		}
		return bytes;
	} catch {
		return undefined;
	}
}

function isRequired(value: string | readonly string[] | undefined): value is string {
	return typeof value === 'string' && value.length > 0;
}

function optionalHeader(value: string | null): string | undefined {
	return value && value.trim() === value ? value : undefined;
}

async function readBody(
	request: Request,
	limit: number,
): Promise<
	| { type: 'ok'; value: string }
	| { type: 'too-large' }
	| { type: 'invalid' }
> {
	const contentLength = request.headers.get('content-length');
	if (contentLength) {
		const length = Number(contentLength);
		if (Number.isFinite(length) && length > limit) return { type: 'too-large' };
	}
	if (!request.body) return { type: 'ok', value: '' };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { type: 'ok', value: decoder.decode(bytes) };
	} catch {
		return { type: 'invalid' };
	}
}

function serializeHandlerResult(value: unknown, twiml: boolean): Response {
	if (value instanceof Response) return value;
	if (value !== undefined) return response(500);
	return twiml
		? new Response(EMPTY_TWIML, {
				status: 200,
				headers: { 'content-type': 'text/xml; charset=UTF-8' },
			})
		: response(200);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}
