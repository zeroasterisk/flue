import { Hono } from 'hono';
import { type CryptoKey, exportJWK, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createGoogleChatChannel,
	InvalidGoogleChatConversationKeyError,
	InvalidGoogleChatInputError,
} from '../src/index.ts';

const CHAT_IDENTITY = 'chat@system.gserviceaccount.com';
const ENDPOINT_AUDIENCE = 'https://assistant.example.test/channels/google-chat/interactions';
const PUBSUB_AUDIENCE = 'https://assistant.example.test/channels/google-chat/events';
const PUBSUB_IDENTITY = 'workspace-push@synthetic-project.iam.gserviceaccount.com';
const PUBSUB_SUBSCRIPTION = 'projects/synthetic-project/subscriptions/google-chat-events';
const JWKS_URL = 'https://keys.example.test/google';
const CERTIFICATES_URL = 'https://keys.example.test/chat-x509';
const PROJECT_NUMBER = '456700123998';

const SYNTHETIC_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDfatQsxJCGlooR
e+xMOqgwK7w+w6+8f/p4WpNzSHB1VZSMkPVKM2rtWKkZxjrfuBCy7uS4EZ7WUzMG
odM/BWsTiPx6YD77CIp+BQPzAT5SAqolgoJ5sw8OlZxb/qwfVuNFPPewwNT7f5GW
fzE00D9oGxCktbaJzFquTdaCCtrYic3W4n8oHITEA7DVlBstfcVWIwYbWmgyK4uZ
XWVxx+8TrkHPcuot8s8Sm9niCgNAY7J3OZC1LOeXaFiZrs8VGAmiM7WHh3LQkrXn
USh/JI+UReymu92bFp8nmJQMpHZV0/gyffDGGFYgwnPk3K0GtyfARwqnECdJMUHl
/0JlQ/HJAgMBAAECggEAVme4ez/iLUsXRr/ImYqt9UNU4GlKE/ri4Z0WHaXMaHSa
qOp/Ex1jozuA2skBh/hl7O3bYxzdc0JmH5CCZIMx8DIwgxup/+hDt401A8xdT9Zb
+3nIAE0x65ANEr8hzlUKPILhwGgzdrjVk4DJhQVtIFQnUaw9VnnEMFlGNrEABnI8
JdtcUbmNHeUMGAWba8zx7HS/jxDtoR5Sci7mP+7wGnPAU2dtUGxdkQFsi3D8Ukg2
r57k3JWHz9yG08H39gm5eIZm0eTcJChAIU1Vz/28xa33Tu4bkrnFS5gDuRY2+C2b
CAnKFk3PYPo3za2pxDHZavz6oPksWZ1MtB/HJw9roQKBgQD3GhOKR1RuwQILo/4W
gICmgsRqhJf3TZKl9Nx4l3ZsRSYHkSLrOcBmsIoYk5qTYKBpBVFsQ4uYuGRjK5Pm
Y9CYy3xtbR2TTBkBC3FBk2ICwZQ0Cp5gQUEWhZzkNG+CP16LEyQcdtD6NZlVZ3Nq
23YsYSEvd39WbFJY4DTrdglg5QKBgQDndmo3GrKQZDq7V79k9Pq4Jyd14GfGQm3A
2j5MwYpqSiPX/z/O4N5LFCBIo/f5XZX83ecL8i6BTCzWYRFbY/R7it1YixhDVnRz
k1xI9d1eWQUEiL+21TmWEowBcXKqSqaaIfLOTyiY1crqqBmdIgav+agsSn6uxtXq
97ndBDYTFQKBgDwx2QK9f57/W500VOhsY2qsvmZoaJCxEAFnlfG2i/2yFqKPQ59j
0S/y36E/C8/NISaUShKCndYVTTcvXXcpZ55hK62IgETqq8iqXeuomJ6tQ4ot8Ajo
vI9c+yxIbcWf5Esi3ZAljaD2P6Ujb2VfkvkarDfg9185QhIuhBW8CmrVAoGBAMRX
ragKzJgxfaS3vZJ9QUT/abjTYBRM+18RgrGHp8ucEqXCTzVFiSu06eHUvaBZo8a5
0alPieWCYbKE6r1Un+pAlJzseOt+JhB4W1tEvMCw0NHU0pPcchn8p6j9vF/6LTMo
QxiBC5YCHTxK1ld1qqiSJfdURfwqjQHhnFeAoAI1AoGBALG/Bjlv0jpe3rrEFU2J
pnQbdCtTQYg6Qykqi/h7niWIkdkxB/BY1zeSCmWK6mdFhRWUYVLcC+sVr+ZIi9qq
ibEkFAdWW9vIf1+VEPiEg+D+FqWoGTCcFw0dLW+DHfGTaV1WX9JqEC5p2qK25wxS
sm/A/fHwtd0ZmmpzRBWeAyRZ
-----END PRIVATE KEY-----`;

const SYNTHETIC_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICxjCCAa4CCQDuaZiYnfU5vTANBgkqhkiG9w0BAQsFADAlMSMwIQYDVQQDDBpz
eW50aGV0aWMtZ29vZ2xlLWNoYXQudGVzdDAeFw0yNjA2MTMxNzM3MzVaFw0zNjA2
MTAxNzM3MzVaMCUxIzAhBgNVBAMMGnN5bnRoZXRpYy1nb29nbGUtY2hhdC50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA32rULMSQhpaKEXvsTDqo
MCu8PsOvvH/6eFqTc0hwdVWUjJD1SjNq7VipGcY637gQsu7kuBGe1lMzBqHTPwVr
E4j8emA++wiKfgUD8wE+UgKqJYKCebMPDpWcW/6sH1bjRTz3sMDU+3+Rln8xNNA/
aBsQpLW2icxark3Wggra2InN1uJ/KByExAOw1ZQbLX3FViMGG1poMiuLmV1lccfv
E65Bz3LqLfLPEpvZ4goDQGOydzmQtSznl2hYma7PFRgJojO1h4dy0JK151EofySP
lEXsprvdmxafJ5iUDKR2VdP4Mn3wxhhWIMJz5NytBrcnwEcKpxAnSTFB5f9CZUPx
yQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQDdSfGN68GJJZ3pDYv+tEf+SNZNnn0F
xE9JUK2AMEsEe00UTNiEjRB/zpbT6rFe6eNWEx5pNjE+7fdzvyL7fbKw0ch4Jb8X
odNlR6ECyXiGUsUkikkJvnAq71o2Wb/NkZI0EvGaRbbB2cN0UtrY3FZoty8FBAnG
btDWTl0kbIcsuV5rBzDsycXrl8OP5LjYjL5R7I2K/eTwRX9HCB+42oSQIx8cVR/U
LhdVxSD+CpVVSyqiQBJmOAyDS3F2I+dt6KeVLKQhWjNvhxC/0wTO4i7I/Lm6L1ls
AiG8pBjuPyBEIaHivmJ3GgsZP8rsHIz8ybwjY8+l1ncJMToiJIN1uK3M
-----END CERTIFICATE-----`;

let oidcPrivateKey: CryptoKey;
let oidcJwk: JsonWebKey;
let x509PrivateKey: CryptoKey;

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	oidcPrivateKey = pair.privateKey;
	oidcJwk = await exportJWK(pair.publicKey);
	x509PrivateKey = await importPKCS8(SYNTHETIC_PRIVATE_KEY, 'RS256');
});

describe('createGoogleChatChannel()', () => {
	it('normalizes a signed message interaction when endpoint-url authentication succeeds', async () => {
		const handler = vi.fn(({ event }) => ({
			type: event.type,
			text: event.type === 'message' ? event.payload.text : undefined,
		}));
		const fetcher = createKeyFetcher();
		const channel = createGoogleChatChannel({
			fetch: fetcher,
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const token = await signOidcToken({
			audience: ENDPOINT_AUDIENCE,
			email: CHAT_IDENTITY,
		});
		const response = await mount(channel).request('/interactions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				type: 'MESSAGE',
				eventTime: '2026-06-13T17:55:00Z',
				user: {
					name: 'users/visitor-42',
					displayName: 'Synthetic Visitor',
					type: 'HUMAN',
				},
				space: { name: 'spaces/cobalt-lab', type: 'SPACE' },
				message: {
					name: 'spaces/cobalt-lab/messages/message-77',
					text: '@helper summarize the launch notes',
					argumentText: 'summarize the launch notes',
					thread: { name: 'spaces/cobalt-lab/threads/thread-15' },
					annotations: [{ type: 'USER_MENTION' }],
				},
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: 'message',
			text: '@helper summarize the launch notes',
		});
		expect(handler).toHaveBeenCalledOnce();
		const event = handler.mock.calls[0]?.[0].event;
		expect(event.destination).toEqual({
			space: 'spaces/cobalt-lab',
			thread: 'spaces/cobalt-lab/threads/thread-15',
			spaceType: 'SPACE',
		});
		expect(event.user).toEqual({
			name: 'users/visitor-42',
			displayName: 'Synthetic Visitor',
			type: 'HUMAN',
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('rejects a direct interaction when the signed token has another identity', async () => {
		const handler = vi.fn();
		const channel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const token = await signOidcToken({
			audience: ENDPOINT_AUDIENCE,
			email: 'another-service@synthetic-project.iam.gserviceaccount.com',
		});

		const response = await mount(channel).request('/interactions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ type: 'REMOVED_FROM_SPACE' }),
		});

		expect(response.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it('verifies a project-number interaction against the Chat service certificate', async () => {
		const handler = vi.fn(({ event }) => {
			if (event.type !== 'card_clicked') return;
			return {
				action: event.payload.actionMethodName,
				parameters: event.payload.parameters,
			};
		});
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe(CERTIFICATES_URL);
			return Response.json(
				{ 'synthetic-x509-key': SYNTHETIC_CERTIFICATE },
				{ headers: { 'cache-control': 'public, max-age=300' } },
			);
		});
		const channel = createGoogleChatChannel({
			fetch: fetcher,
			interactions: {
				authentication: {
					type: 'project-number',
					projectNumber: PROJECT_NUMBER,
					certificatesUrl: CERTIFICATES_URL,
				},
				handler,
			},
		});
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'synthetic-x509-key' })
			.setIssuer(CHAT_IDENTITY)
			.setAudience(PROJECT_NUMBER)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(x509PrivateKey);

		const response = await mount(channel).request('/interactions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				type: 'CARD_CLICKED',
				space: { name: 'spaces/project-room', type: 'GROUP_CHAT' },
				action: {
					actionMethodName: 'approve_release',
					parameters: [
						{ key: 'release', value: 'rc-8' },
						{ key: 'ignored', value: 9 },
					],
				},
				common: { formInputs: { note: { stringInputs: { value: ['ship'] } } } },
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			action: 'approve_release',
			parameters: { release: 'rc-8' },
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('normalizes the remaining direct interaction families when their tokens are valid', async () => {
		const observed: string[] = [];
		const channel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler({ event }) {
					observed.push(event.type);
					return;
				},
			},
		});
		const token = await signOidcToken({
			audience: ENDPOINT_AUDIENCE,
			email: CHAT_IDENTITY,
		});
		for (const body of [
			{
				type: 'ADDED_TO_SPACE',
				space: { name: 'spaces/family-test', type: 'SPACE' },
			},
			{
				type: 'REMOVED_FROM_SPACE',
				space: { name: 'spaces/family-test', type: 'SPACE' },
			},
			{
				type: 'APP_COMMAND',
				appCommandMetadata: { appCommandId: 'command-19', appCommandType: 'SLASH_COMMAND' },
			},
			{
				type: 'APP_HOME',
				action: { actionMethodName: 'render_home' },
			},
			{
				type: 'SUBMIT_FORM',
				action: { actionMethodName: 'save_preferences' },
				common: { formInputs: { color: { stringInputs: { value: ['blue'] } } } },
			},
			{ type: 'FUTURE_INTERACTION', futureField: true },
		]) {
			const response = await mount(channel).request('/interactions', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
		}

		expect(observed).toEqual([
			'added_to_space',
			'removed_from_space',
			'app_command',
			'app_home',
			'submit_form',
			'unknown',
		]);
	});

	it('refreshes cached Google keys once when a valid token uses a rotated key id', async () => {
		const rotatedPair = await generateKeyPair('RS256');
		const rotatedJwk = await exportJWK(rotatedPair.publicKey);
		let discovery = 0;
		const fetcher = vi.fn(async () => {
			discovery += 1;
			const key =
				discovery === 1
					? { ...oidcJwk, kid: 'synthetic-google-key', alg: 'RS256', use: 'sig' }
					: { ...rotatedJwk, kid: 'rotated-google-key', alg: 'RS256', use: 'sig' };
			return Response.json(
				{ keys: [key] },
				{ headers: { 'cache-control': 'public, max-age=300' } },
			);
		});
		const handler = vi.fn();
		const channel = createGoogleChatChannel({
			fetch: fetcher,
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const originalToken = await signOidcToken({
			audience: ENDPOINT_AUDIENCE,
			email: CHAT_IDENTITY,
		});
		const rotatedToken = await new SignJWT({
			email: CHAT_IDENTITY,
			email_verified: true,
		})
			.setProtectedHeader({ alg: 'RS256', kid: 'rotated-google-key' })
			.setIssuer('https://accounts.google.com')
			.setAudience(ENDPOINT_AUDIENCE)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(rotatedPair.privateKey);
		const request = (token: string) => ({
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ type: 'REMOVED_FROM_SPACE' }),
		});

		expect((await mount(channel).request('/interactions', request(originalToken))).status).toBe(
			200,
		);
		expect((await mount(channel).request('/interactions', request(rotatedToken))).status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it('uses Hono responses and returns failure when an interaction handler throws', async () => {
		const token = await signOidcToken({
			audience: ENDPOINT_AUDIENCE,
			email: CHAT_IDENTITY,
		});
		const responseChannel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler({ c }) {
					return c.json({ accepted: false }, 422);
				},
			},
		});
		const thrownChannel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler() {
					throw new Error('synthetic handler failure');
				},
			},
		});
		const request = {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ type: 'REMOVED_FROM_SPACE' }),
		};

		const customResponse = await mount(responseChannel).request('/interactions', request);
		const failureResponse = await mount(thrownChannel).request('/interactions', request);

		expect(customResponse.status).toBe(422);
		expect(await customResponse.json()).toEqual({ accepted: false });
		expect(failureResponse.status).toBe(500);
	});

	it('rejects unsupported media types and oversized direct interaction bodies', async () => {
		const handler = vi.fn();
		const channel = createGoogleChatChannel({
			bodyLimit: 32,
			interactions: {
				authentication: {
					type: 'endpoint-url',
					audience: ENDPOINT_AUDIENCE,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});

		const unsupported = await mount(channel).request('/interactions', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: '{}',
		});
		const oversized = await mount(channel).request('/interactions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': '64',
			},
			body: JSON.stringify({ type: 'MESSAGE', text: 'larger than the configured limit' }),
		});

		expect(unsupported.status).toBe(415);
		expect(oversized.status).toBe(413);
		expect(handler).not.toHaveBeenCalled();
	});

	it('normalizes an authenticated Workspace message event when Pub/Sub attributes match', async () => {
		const handler = vi.fn(({ event }) => ({
			type: event.type,
			space: event.destination?.space,
		}));
		const fetcher = createKeyFetcher();
		const channel = createGoogleChatChannel({
			fetch: fetcher,
			workspaceEvents: {
				authentication: {
					subscription: PUBSUB_SUBSCRIPTION,
					audience: PUBSUB_AUDIENCE,
					serviceAccountEmail: PUBSUB_IDENTITY,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const token = await signOidcToken({
			audience: PUBSUB_AUDIENCE,
			email: PUBSUB_IDENTITY,
		});
		const response = await mount(channel).request('/events', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(
				pubsubBody({
					eventType: 'google.workspace.chat.message.v1.created',
					subject: '//chat.googleapis.com/spaces/amber-ops',
					data: {
						message: {
							name: 'spaces/amber-ops/messages/event-message-3',
							space: { name: 'spaces/amber-ops', type: 'SPACE' },
							thread: { name: 'spaces/amber-ops/threads/thread-9' },
							text: 'status update from synthetic event',
						},
					},
				}),
			),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: 'message_created',
			space: 'spaces/amber-ops',
		});
		const event = handler.mock.calls[0]?.[0].event;
		expect(event.pubsubMessageId).toBe('pubsub-message-100');
		expect(event.attributes.id).toBe('workspace-event-88');
		expect(event.destination).toEqual({
			space: 'spaces/amber-ops',
			thread: 'spaces/amber-ops/threads/thread-9',
			spaceType: 'SPACE',
		});
	});

	it('forwards an authenticated lifecycle event without inventing a Chat destination', async () => {
		const handler = vi.fn(({ event }) => ({
			type: event.type,
			hasDestination: event.destination !== undefined,
		}));
		const channel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			workspaceEvents: {
				authentication: {
					subscription: PUBSUB_SUBSCRIPTION,
					audience: PUBSUB_AUDIENCE,
					serviceAccountEmail: PUBSUB_IDENTITY,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const token = await signOidcToken({
			audience: PUBSUB_AUDIENCE,
			email: PUBSUB_IDENTITY,
		});
		const subscription = '//workspaceevents.googleapis.com/subscriptions/subscription-23';
		const response = await mount(channel).request('/events', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(
				pubsubBody({
					eventType: 'google.workspace.events.subscription.v1.suspended',
					subject: subscription,
					source: subscription,
					data: { subscription: { name: 'subscriptions/subscription-23' } },
				}),
			),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: 'subscription_suspended',
			hasDestination: false,
		});
	});

	it('normalizes membership, reaction, space, and unknown Workspace Event families', async () => {
		const observed: string[] = [];
		const channel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			workspaceEvents: {
				authentication: {
					subscription: PUBSUB_SUBSCRIPTION,
					audience: PUBSUB_AUDIENCE,
					serviceAccountEmail: PUBSUB_IDENTITY,
					jwksUrl: JWKS_URL,
				},
				handler({ event }) {
					observed.push(event.type);
					return;
				},
			},
		});
		const token = await signOidcToken({
			audience: PUBSUB_AUDIENCE,
			email: PUBSUB_IDENTITY,
		});
		for (const eventType of [
			'google.workspace.chat.membership.v1.created',
			'google.workspace.chat.reaction.v1.deleted',
			'google.workspace.chat.space.v1.updated',
			'google.workspace.chat.future.v1.changed',
		]) {
			const response = await mount(channel).request('/events', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(
					pubsubBody({
						eventType,
						subject: '//chat.googleapis.com/spaces/family-events',
						data: { space: { name: 'spaces/family-events', type: 'SPACE' } },
					}),
				),
			});
			expect(response.status).toBe(200);
		}

		expect(observed).toEqual([
			'membership_created',
			'reaction_deleted',
			'space_updated',
			'unknown',
		]);
	});

	it('rejects a Workspace event when the authenticated Pub/Sub identity differs', async () => {
		const handler = vi.fn();
		const channel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			workspaceEvents: {
				authentication: {
					subscription: PUBSUB_SUBSCRIPTION,
					audience: PUBSUB_AUDIENCE,
					serviceAccountEmail: PUBSUB_IDENTITY,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const token = await signOidcToken({
			audience: PUBSUB_AUDIENCE,
			email: 'unexpected-push@synthetic-project.iam.gserviceaccount.com',
		});
		const response = await mount(channel).request('/events', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(
				pubsubBody({
					eventType: 'google.workspace.chat.space.v1.updated',
					subject: '//chat.googleapis.com/spaces/identity-test',
					data: { space: { name: 'spaces/identity-test', type: 'SPACE' } },
				}),
			),
		});

		expect(response.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects a Workspace event when the Pub/Sub subscription differs', async () => {
		const handler = vi.fn();
		const channel = createGoogleChatChannel({
			fetch: createKeyFetcher(),
			workspaceEvents: {
				authentication: {
					subscription: PUBSUB_SUBSCRIPTION,
					audience: PUBSUB_AUDIENCE,
					serviceAccountEmail: PUBSUB_IDENTITY,
					jwksUrl: JWKS_URL,
				},
				handler,
			},
		});
		const token = await signOidcToken({
			audience: PUBSUB_AUDIENCE,
			email: PUBSUB_IDENTITY,
		});
		const body = pubsubBody({
			eventType: 'google.workspace.chat.space.v1.updated',
			subject: '//chat.googleapis.com/spaces/subscription-test',
			data: { space: { name: 'spaces/subscription-test', type: 'SPACE' } },
		});
		body.subscription = 'projects/synthetic-project/subscriptions/another-stream';

		const response = await mount(channel).request('/events', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(403);
		expect(handler).not.toHaveBeenCalled();
	});

	it('publishes only configured routes when one Google Chat surface is omitted', () => {
		const interactionChannel = createGoogleChatChannel({
			interactions: {
				authentication: { type: 'endpoint-url', audience: ENDPOINT_AUDIENCE },
				handler() {},
			},
		});
		const workspaceChannel = createGoogleChatChannel({
			workspaceEvents: {
				authentication: {
					subscription: PUBSUB_SUBSCRIPTION,
					audience: PUBSUB_AUDIENCE,
					serviceAccountEmail: PUBSUB_IDENTITY,
				},
				handler() {},
			},
		});

		expect(interactionChannel.routes.map((route) => route.path)).toEqual(['/interactions']);
		expect(workspaceChannel.routes.map((route) => route.path)).toEqual(['/events']);
	});

	it('round trips canonical conversation keys when the reference is valid', () => {
		const channel = createGoogleChatChannel({
			interactions: {
				authentication: { type: 'endpoint-url', audience: ENDPOINT_AUDIENCE },
				handler() {},
			},
		});
		const reference = {
			space: 'spaces/canonical-space',
			thread: 'spaces/canonical-space/threads/canonical-thread',
		};
		const key = channel.conversationKey(reference);

		expect(key).toBe(
			'google-chat:v1:spaces%2Fcanonical-space:spaces%2Fcanonical-space%2Fthreads%2Fcanonical-thread',
		);
		expect(
			channel.conversationKey({
				...reference,
				spaceType: 'SPACE',
			}),
		).toBe(key);
		expect(channel.parseConversationKey(key)).toEqual(reference);
	});

	it('throws structured input errors when configuration or conversation keys are invalid', () => {
		expect(() => createGoogleChatChannel({})).toThrow(InvalidGoogleChatInputError);
		const channel = createGoogleChatChannel({
			interactions: {
				authentication: { type: 'endpoint-url', audience: ENDPOINT_AUDIENCE },
				handler() {},
			},
		});
		expect(() => channel.parseConversationKey('google-chat:v1:invalid')).toThrow(
			InvalidGoogleChatConversationKeyError,
		);
	});
});

function mount(channel: ReturnType<typeof createGoogleChatChannel>): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function createKeyFetcher() {
	return vi.fn(async (input: RequestInfo | URL) => {
		expect(String(input)).toBe(JWKS_URL);
		return Response.json(
			{
				keys: [
					{
						...oidcJwk,
						kid: 'synthetic-google-key',
						alg: 'RS256',
						use: 'sig',
					},
				],
			},
			{ headers: { 'cache-control': 'public, max-age=300' } },
		);
	});
}

async function signOidcToken(options: { audience: string; email: string }): Promise<string> {
	return new SignJWT({
		email: options.email,
		email_verified: true,
	})
		.setProtectedHeader({ alg: 'RS256', kid: 'synthetic-google-key' })
		.setIssuer('https://accounts.google.com')
		.setAudience(options.audience)
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(oidcPrivateKey);
}

function pubsubBody(options: {
	eventType: string;
	subject: string;
	data: unknown;
	source?: string;
}) {
	return {
		message: {
			attributes: {
				'ce-datacontenttype': 'application/json',
				'ce-id': 'workspace-event-88',
				'ce-source':
					options.source ?? '//workspaceevents.googleapis.com/subscriptions/subscription-23',
				'ce-specversion': '1.0',
				'ce-subject': options.subject,
				'ce-time': '2026-06-13T18:07:00Z',
				'ce-type': options.eventType,
			},
			data: btoa(JSON.stringify(options.data)),
			messageId: 'pubsub-message-100',
			publishTime: '2026-06-13T18:07:01Z',
		},
		subscription: PUBSUB_SUBSCRIPTION,
	};
}
