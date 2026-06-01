/**
 * DO-backed session store. Uses setState/state directly. Usually not needed —
 * the generated entry point uses DO SQLite by default.
 */
import type { SessionData, SessionStore } from '../types.ts';
import { getCloudflareContext } from './context.ts';

function copySessions(
	sessions: Record<string, SessionData> | undefined,
): Record<string, SessionData> {
	return Object.assign(Object.create(null), sessions);
}

export function store(): SessionStore {
	return {
		async save(id: string, data: SessionData): Promise<void> {
			const { agentInstance } = getCloudflareContext();
			const sessions = copySessions(agentInstance.state?.sessions);
			sessions[id] = data;
			agentInstance.setState({ ...agentInstance.state, sessions });
		},

		async load(id: string): Promise<SessionData | null> {
			const { agentInstance } = getCloudflareContext();
			const sessions = agentInstance.state?.sessions;
			return sessions && Object.hasOwn(sessions, id) ? (sessions[id] ?? null) : null;
		},

		async delete(id: string): Promise<void> {
			const { agentInstance } = getCloudflareContext();
			const sessions = copySessions(agentInstance.state?.sessions);
			delete sessions[id];
			agentInstance.setState({ ...agentInstance.state, sessions });
		},
	};
}
