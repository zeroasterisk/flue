import { defineAgent } from '@flue/runtime';
import greet from '../../.agents/skills/greet/SKILL.md' with { type: 'skill' };

export { greet };

export const greetingAgent = defineAgent({
	name: 'with-skill',
	model: 'anthropic/claude-sonnet-4-6',
	skills: [greet],
});
