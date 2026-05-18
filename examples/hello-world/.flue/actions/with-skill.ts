import type { ActionContext } from '@flue/runtime';
import * as v from 'valibot';
import { greet, greetingAgent } from '../agents/with-skill.ts';

export const triggers = { webhook: true };

export default async function ({ init, payload }: ActionContext) {
	const harness = await init({ agent: greetingAgent });
	const session = await harness.session();
	const { data } = await session.skill(greet, {
		args: { name: payload.name ?? 'World' },
		result: v.object({ greeting: v.string() }),
	});
	console.log('[with-skill] greeting:', data.greeting);
	return data;
}
