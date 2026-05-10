/**
 * Optional `app.ts` entry. When present, the Flue build delegates the
 * entire request pipeline to whatever this file's default export
 * exposes via `.fetch(request)`.
 *
 * Anything you can do with a Hono app, you can do here: middleware,
 * custom routes, request rewriting, auth, etc. Mount `flue()` to keep
 * Flue's built-in agent route (`POST /agents/:name/:id`) reachable.
 *
 * Delete this file and the build falls back to a default app that
 * mounts `flue()` at root with no extras — same behavior the project
 * had before `app.ts` was introduced.
 */
import { flue } from '@flue/sdk/app';
import { Hono } from 'hono';

const app = new Hono();

// Plain Hono middleware: log every request with a duration. Demonstrates
// that anything in Hono's middleware ecosystem works inside `app.ts`.
app.use('*', async (c, next) => {
	const started = Date.now();
	await next();
	const ms = Date.now() - started;
	console.log(`[app] ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

// Custom route that has nothing to do with agents. Useful for liveness
// probes, status pages, or app-specific endpoints.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Mount Flue's built-in agent route. Order matters: routes registered
// before this take precedence; routes after this only see requests that
// `flue()` didn't match (i.e. anything other than `/agents/:name/:id`).
app.route('/', flue());

export default app;
