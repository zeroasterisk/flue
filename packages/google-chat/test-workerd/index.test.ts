import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleChatChannel } from '../src/index.ts';

describe('@flue/google-chat workerd ingress', () => {
	it('executes Google OIDC verification for direct and Pub/Sub routes in workerd', async () => {
		const audience = 'https://worker.example.test/channels/google-chat/interactions';
		const pubsubAudience = 'https://worker.example.test/channels/google-chat/events';
		const pubsubIdentity = 'push@worker-project.iam.gserviceaccount.com';
		const jwksUrl = 'https://keys.worker.test/google';
		const keyPair = await generateKeyPair('RS256');
		const publicJwk = await exportJWK(keyPair.publicKey);
		const fetcher = vi.fn(async () =>
			Response.json({
				keys: [
					{
						...publicJwk,
						kid: 'workerd-key',
						alg: 'RS256',
						use: 'sig',
					},
				],
			}),
		);
		const interactions = vi.fn(({ event }) => ({ surface: 'interaction', type: event.type }));
		const workspaceEvents = vi.fn(({ event }) => ({ surface: 'event', type: event.type }));
		const channel = createGoogleChatChannel({
			fetch: fetcher,
			interactions: {
				authentication: { type: 'endpoint-url', audience, jwksUrl },
				handler: interactions,
			},
			workspaceEvents: {
				authentication: {
					subscription: 'projects/worker-project/subscriptions/google-chat-events',
					audience: pubsubAudience,
					serviceAccountEmail: pubsubIdentity,
					jwksUrl,
				},
				handler: workspaceEvents,
			},
		});
		const app = new Hono();
		for (const route of channel.routes) app.on(route.method, route.path, route.handler);
		const interactionToken = await new SignJWT({
			email: 'chat@system.gserviceaccount.com',
			email_verified: true,
		})
			.setProtectedHeader({ alg: 'RS256', kid: 'workerd-key' })
			.setIssuer('https://accounts.google.com')
			.setAudience(audience)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(keyPair.privateKey);
		const pubsubToken = await new SignJWT({
			email: pubsubIdentity,
			email_verified: true,
		})
			.setProtectedHeader({ alg: 'RS256', kid: 'workerd-key' })
			.setIssuer('https://accounts.google.com')
			.setAudience(pubsubAudience)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(keyPair.privateKey);

		const interactionResponse = await app.request('/interactions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${interactionToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				type: 'MESSAGE',
				space: { name: 'spaces/workerd', type: 'DIRECT_MESSAGE' },
				message: { text: 'workerd interaction' },
			}),
		});
		const data = btoa(
			JSON.stringify({
				message: {
					space: { name: 'spaces/workerd', type: 'DIRECT_MESSAGE' },
					text: 'workerd event',
				},
			}),
		);
		const eventResponse = await app.request('/events', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${pubsubToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				message: {
					attributes: {
						'ce-datacontenttype': 'application/json',
						'ce-id': 'workerd-event',
						'ce-source': '//workspaceevents.googleapis.com/subscriptions/workerd',
						'ce-specversion': '1.0',
						'ce-subject': '//chat.googleapis.com/spaces/workerd',
						'ce-type': 'google.workspace.chat.message.v1.created',
					},
					data,
					messageId: 'workerd-pubsub-message',
				},
				subscription: 'projects/worker-project/subscriptions/google-chat-events',
			}),
		});

		expect(interactionResponse.status).toBe(200);
		expect(await interactionResponse.json()).toEqual({
			surface: 'interaction',
			type: 'message',
		});
		expect(eventResponse.status).toBe(200);
		expect(await eventResponse.json()).toEqual({
			surface: 'event',
			type: 'message_created',
		});
		expect(interactions).toHaveBeenCalledOnce();
		expect(workspaceEvents).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
