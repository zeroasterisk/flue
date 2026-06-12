import { describe, expect, it, vi } from 'vitest';
import { observe } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';

function createContext(id: string) {
	return createFlueContext({
		id,
		payload: {},
		env: {},
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => {
			throw new Error('unexpected sandbox initialization');
		},
		defaultStore: new InMemorySessionStore(),
	});
}

describe('observe()', () => {
	it('receives decorated event snapshots when a runtime context emits events', () => {
		const events: unknown[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-decorated-event') events.push(event);
		});
		const ctx = createContext('observe-decorated-event');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual([
				{
					type: 'idle',
					instanceId: 'observe-decorated-event',
					v: 1,
					eventIndex: 0,
					timestamp: expect.any(String),
				},
			]);
		} finally {
			stopObserving();
		}
	});

	it('receives the originating context when a runtime context emits events', () => {
		const contexts: unknown[] = [];
		const stopObserving = observe((_event, ctx) => {
			if (ctx.id === 'observe-originating-context') contexts.push(ctx);
		});
		const ctx = createContext('observe-originating-context');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(contexts).toEqual([ctx]);
		} finally {
			stopObserving();
		}
	});

	it("prevents one subscriber's event mutation from affecting another subscriber when an event is delivered", () => {
		const events: unknown[] = [];
		const stopMutating = observe((event, ctx) => {
			if (ctx.id !== 'observe-isolated-snapshot' || event.type !== 'log') return;
			event.message = 'mutated';
			(event.attributes?.nested as { value: string }).value = 'mutated';
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observe-isolated-snapshot') events.push(event);
		});
		const ctx = createContext('observe-isolated-snapshot');

		try {
			ctx.emitEvent({
				type: 'log',
				level: 'info',
				message: 'original',
				attributes: { nested: { value: 'original' } },
			});

			expect(events).toMatchObject([
				{
					type: 'log',
					message: 'original',
					attributes: { nested: { value: 'original' } },
				},
			]);
		} finally {
			stopMutating();
			stopRecording();
		}
	});

	it('continues delivery when one subscriber throws', () => {
		const error = new Error('observe subscriber failure');
		const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const events: string[] = [];
		const stopThrowing = observe((_event, ctx) => {
			if (ctx.id === 'observe-thrown-failure') throw error;
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observe-thrown-failure') events.push(event.type);
		});
		const ctx = createContext('observe-thrown-failure');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
			expect(failure).toHaveBeenCalledWith('[flue:observe] subscriber failed:', error);
		} finally {
			stopThrowing();
			stopRecording();
			failure.mockRestore();
		}
	});

	it('continues delivery when one subscriber returns a rejected promise', async () => {
		const error = new Error('observe subscriber rejection');
		const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const events: string[] = [];
		const stopRejecting = observe((_event, ctx) => {
			if (ctx.id === 'observe-rejected-failure') return Promise.reject(error);
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observe-rejected-failure') events.push(event.type);
		});
		const ctx = createContext('observe-rejected-failure');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
			await vi.waitFor(() => {
				expect(failure).toHaveBeenCalledWith('[flue:observe] subscriber failed:', error);
			});
		} finally {
			stopRejecting();
			stopRecording();
			failure.mockRestore();
		}
	});

	it('delivers only the declared event types when registered with { types }', () => {
		const events: string[] = [];
		const stopObserving = observe(
			(event, ctx) => {
				if (ctx.id === 'observe-types-filter') events.push(event.type);
			},
			{ types: ['log'] },
		);
		const ctx = createContext('observe-types-filter');

		try {
			ctx.emitEvent({ type: 'idle' });
			ctx.emitEvent({ type: 'log', level: 'info', message: 'kept' });
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['log']);
		} finally {
			stopObserving();
		}
	});

	it('skips event snapshot serialization when every subscriber filters out the event type', () => {
		const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const events: string[] = [];
		const stopObserving = observe(
			(event, ctx) => {
				if (ctx.id === 'observe-types-lazy-snapshot') events.push(event.type);
			},
			{ types: ['idle'] },
		);
		const ctx = createContext('observe-types-lazy-snapshot');
		const circular: { self?: unknown } = {};
		circular.self = circular;

		try {
			// A circular payload would fail JSON snapshotting; with no subscriber
			// listening for 'log', the snapshot must never be attempted.
			ctx.emitEvent({ type: 'log', level: 'info', message: 'skipped', attributes: { circular } });
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
			expect(failure).not.toHaveBeenCalled();
		} finally {
			stopObserving();
			failure.mockRestore();
		}
	});

	it('stops delivery when the unsubscribe callback is invoked', () => {
		const events: string[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-unsubscribe') events.push(event.type);
		});
		const ctx = createContext('observe-unsubscribe');

		try {
			ctx.emitEvent({ type: 'idle' });
			stopObserving();
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
		} finally {
			stopObserving();
		}
	});
});
