import { createGoogleChatChannel, type GoogleChatConversationRef } from '@flue/google-chat';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createGoogleChatClient } from '../lib/google-chat-client.ts';

const appUrl = requiredEnv('GOOGLE_CHAT_APP_URL');
const jwksUrl = optionalEnv('GOOGLE_CHAT_JWKS_URL');

export const client = createGoogleChatClient({
	clientEmail: requiredEnv('GOOGLE_CHAT_CLIENT_EMAIL'),
	privateKey: requiredEnv('GOOGLE_CHAT_PRIVATE_KEY'),
});

export const channel = createGoogleChatChannel({
	interactions: {
		authentication: {
			type: 'endpoint-url',
			audience: appUrl,
			...(jwksUrl === undefined ? {} : { jwksUrl }),
		},

		// Path: /channels/google-chat/interactions
		async handler({ event }) {
			switch (event.type) {
				case 'message':
				case 'app_command': {
					if (!event.destination) return;
					await dispatch(assistant, {
						id: channel.conversationKey(event.destination),
						input: {
							type: `google-chat.${event.type}`,
							user: event.user,
							payload: event.payload,
						},
					});
					return;
				}
				default:
					return;
			}
		},
	},

	// Optional Path: /channels/google-chat/events
	// workspaceEvents: {
	//   authentication: {
	//     subscription: requiredEnv('GOOGLE_CHAT_PUBSUB_SUBSCRIPTION'),
	//     audience: requiredEnv('GOOGLE_CHAT_PUBSUB_AUDIENCE'),
	//     serviceAccountEmail: requiredEnv('GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT'),
	//   },
	//   async handler({ event }) {
	//     // Handle Workspace Events delivered through authenticated Pub/Sub push.
	//   },
	// },
});

export function postMessage(ref: GoogleChatConversationRef) {
	return defineTool({
		name: 'post_google_chat_message',
		description: 'Post a message to the Google Chat conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const message = await client.postMessage(ref, text);
			return JSON.stringify({ message: message.name });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
