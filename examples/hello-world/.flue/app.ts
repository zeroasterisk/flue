/**
 * Optional `app.ts` entry. When present, the Flue build delegates the
 * entire request pipeline to whatever this file's default export
 * exposes via `.fetch(request)`.
 *
 * Anything you can do with a Hono app, you can do here: middleware,
 * custom routes, request rewriting, auth, etc. Mount `flue()` to keep
 * Flue's built-in agent route (`POST /agents/:name/:id`) reachable.
 *
 * `registerProvider(...)` calls at the top level register custom model
 * providers for the entire build. Agents then reference them via
 * `init({ model: 'name/model-id' })` without any further setup.
 *
 * Delete this file and the build falls back to a default app that
 * mounts `flue()` at root with no extras — same behavior the project
 * had before `app.ts` was introduced.
 */
import { configureProvider, flue, registerProvider } from '@flue/sdk/app';
import { Hono } from 'hono';

// `registerProvider` declares a brand-new URL prefix. Use it for
// providers Flue/pi-ai don't already know about.
//
// Local Ollama (https://ollama.com). Start with `ollama serve`, pull a
// model with `ollama pull llama3.1:8b`, then run agents with
// `init({ model: 'ollama/llama3.1:8b' })`.
//
// Registration runs at module top level — the platform `process.env` is
// available here on Node, and on Cloudflare you'd use
// `import { env } from 'cloudflare:workers'` to capture bindings/secrets.
registerProvider('ollama', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:11434/v1',
});

// LM Studio (https://lmstudio.ai). Same pattern: start the local server,
// then `init({ model: 'lmstudio/<loaded-model-id>' })`.
registerProvider('lmstudio', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:1234/v1',
});

// `configureProvider` patches an EXISTING provider — pi-ai built-ins or
// previously-registered ones — with transport-level settings (baseUrl,
// apiKey, headers, storeResponses). The provider's catalog entry stays
// intact (cost, contextWindow, thinkingLevelMap), only the bits we name
// here are overridden.
//
// Example: route the built-in `anthropic` provider through a corporate
// gateway and supply an apiKey from env. Commented out by default — uncomment
// after setting the env vars to exercise the path.
//
// configureProvider('anthropic', {
//   baseUrl: process.env.ANTHROPIC_GATEWAY_URL,
//   apiKey: process.env.ANTHROPIC_API_KEY,
// });

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
