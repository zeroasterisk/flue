/** Global, isolate-scoped subscription to live Flue runtime activity. */

import type { FlueContext, FlueEvent } from '../types.ts';

/**
 * Receives a decorated event snapshot and its originating context. Workflow
 * events may carry `runId`; direct and dispatched agent events carry
 * `instanceId` and optional `dispatchId` without becoming workflow runs.
 * Subscriber failures are logged and do not halt dispatch or the originating
 * execution. Returned promises are observed for rejection but are not awaited.
 */
export type FlueEventSubscriber = (event: FlueEvent, ctx: FlueContext) => void | Promise<void>;

export interface ObserveOptions {
	/**
	 * Restrict delivery to these event types. Subscribers without `types`
	 * receive every event. Declaring `types` matters for cost, not just
	 * filtering: each delivered event is serialized to an isolated JSON
	 * snapshot on the emit path, and high-frequency streaming events such as
	 * `message_update` carry the full accumulated assistant message on every
	 * streamed chunk. When no subscriber listens for an event's type, the
	 * snapshot is never serialized.
	 */
	types?: readonly FlueEvent['type'][];
}

const subscribers = new Map<FlueEventSubscriber, ReadonlySet<FlueEvent['type']> | undefined>();

/**
 * Subscribe to live workflow-run or agent-interaction activity emitted in this isolate.
 * The subscription does not replay durable workflow history or aggregate events
 * across processes or Cloudflare Durable Object isolates.
 *
 * Usage (typically at the top of `app.ts`):

 *
 *     import { observe } from '@flue/runtime';
 *
 *     observe((event, ctx) => {
 *       if (event.type === 'run_end' && event.isError) {
 *         // ship to your error reporter, metrics sink, etc.
 *       }
 *     });
 *
 * The returned function unsubscribes the listener. Most error
 * reporting and telemetry use cases register once at startup and
 * never unsubscribe — the returned function is provided for tests
 * and dynamic-wiring scenarios.
 *
 * Subscribers are invoked synchronously from the event emit path with an
 * isolated JSON snapshot. They should be cheap and side-effect-only; returned
 * promises are observed for rejection but are not awaited. Queue substantial
 * work outside the callback rather than blocking emission.
 *
 * Pass `options.types` to restrict delivery to the event types the
 * subscriber handles; this also skips snapshot serialization for events no
 * subscriber listens for (see {@link ObserveOptions.types}).
 */
export function observe(subscriber: FlueEventSubscriber, options?: ObserveOptions): () => void {
	subscribers.set(subscriber, options?.types ? new Set(options.types) : undefined);
	return () => {
		subscribers.delete(subscriber);
	};
}

/**
 * Internal: dispatch a single event to every registered subscriber.
 * Called from `createFlueContext`'s `emitEvent` after the per-context
 * subscribers have run.
 */
export function dispatchGlobalEvent(event: FlueEvent, ctx: FlueContext): void {
	if (subscribers.size === 0) return;
	// Snapshot recipients to a local array so subscribers that unsubscribe
	// themselves mid-dispatch don't perturb the iteration. Serialization is
	// skipped entirely when every subscriber filters out this event's type.
	const recipients: FlueEventSubscriber[] = [];
	for (const [subscriber, types] of subscribers) {
		if (types === undefined || types.has(event.type)) recipients.push(subscriber);
	}
	if (recipients.length === 0) return;
	let serializedEvent: string | undefined;
	try {
		serializedEvent = JSON.stringify(event);
		if (serializedEvent === undefined)
			throw new Error('Event snapshot serialization returned undefined.');
	} catch (error) {
		reportSubscriberFailure(error);
		return;
	}
	for (const subscriber of recipients) {
		try {
			Promise.resolve(subscriber(JSON.parse(serializedEvent) as FlueEvent, ctx)).catch(
				reportSubscriberFailure,
			);
		} catch (error) {
			reportSubscriberFailure(error);
		}
	}
}

function reportSubscriberFailure(error: unknown): void {
	console.error('[flue:observe] subscriber failed:', error);
}
