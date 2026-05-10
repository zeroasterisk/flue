/**
 * Public surface for user-authored `app.ts` entries.
 *
 * Users who customize their server pipeline (custom Hono routes,
 * middleware, request rewriting, auth, etc.) import everything they
 * need from this subpath:
 *
 *     import { flue, type Fetchable } from '@flue/sdk/app';
 *     import { Hono } from 'hono';
 *
 *     const app = new Hono();
 *     app.use('*', logger());
 *     app.route('/', flue());
 *     export default app;
 *
 * Why a subpath instead of the SDK root: the root barrel re-exports
 * build-time symbols (`build`, `dev`) that pull in heavy build-only
 * dependencies (notably `typescript` for agent-file parsing). Bundlers
 * for the deploy target — wrangler in particular — walk the entire
 * import graph from a user's `app.ts`, and even with tree-shaking
 * those dependencies sneak into the worker bundle and break at
 * runtime (`__filename is not defined` from the TS lib code that
 * expects Node globals).
 *
 * Splitting the runtime API onto its own subpath fixes this by
 * construction: `@flue/sdk/app` only re-exports runtime values, never
 * touches `build.ts` or `dev.ts`, and stays small in the worker bundle.
 *
 * Phase 3 of the `app.ts` work will add more runtime API here
 * (`registerProvider`, `registerApiProvider`, etc.). Connector authors
 * who wire up custom sandboxes still go through `@flue/sdk/sandbox` —
 * that's a separate audience and a separate surface.
 */
export { flue } from './runtime/flue-app.ts';

/**
 * Shape contract for a user-authored `app.ts` default export. Any
 * object exposing a `fetch(request, env?, ctx?)` method satisfies it,
 * including a `new Hono()` instance.
 *
 * The `env` and `ctx` parameters are passed through on the Cloudflare
 * target (env = bindings, ctx = ExecutionContext); on Node they are
 * undefined.
 */
export interface Fetchable {
	fetch(
		request: Request,
		env?: unknown,
		ctx?: unknown,
	): Response | Promise<Response>;
}
