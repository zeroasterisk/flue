---
title: Turso
description: Give Flue agents and workflow runs durable, hosted state with Turso — managed, replicated libSQL.
subtitle: Persist agent sessions, accepted submissions, and workflow-run history in hosted Turso, with optional embedded replicas for low-latency reads.
package:
  name: '@flue/libsql'
  href: https://www.npmjs.com/package/@flue/libsql
---

## Add Turso

Add [Turso](https://turso.tech)-backed persistence to any existing Flue project
by running the following command in your terminal, or your coding agent of
choice.

```sh
flue add turso
```

Turso is hosted, replicated libSQL. The blueprint installs `@flue/libsql` and
the official `@libsql/client`, and writes a source-root `db.ts` that wraps the
client with a Turso configuration — it is the **same adapter** as
[`flue add libsql`](/docs/ecosystem/databases/libsql/), pointed at a Turso
database. Flue discovers `db.ts` at build time and wires it into the generated
Node server.

`@flue/libsql` is a **Node.js** adapter. The Cloudflare target uses Durable
Object SQLite automatically and rejects a `db.ts` file at build time, so this
guide applies to Node deployments. See [Database](/docs/guide/database/) for the
full picture of how state is stored on each target.

## Create a database

Create a database and an auth token with the
[Turso CLI](https://docs.turso.tech/cli/introduction):

```sh
turso db create flue-agents
turso db show --url flue-agents      # → TURSO_DATABASE_URL (libsql://…)
turso db tokens create flue-agents   # → TURSO_AUTH_TOKEN
```

## Configure

Set these application secrets:

| Variable             | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `TURSO_DATABASE_URL` | The database's `libsql://` URL.                    |
| `TURSO_AUTH_TOKEN`   | Auth token for the database.                       |

`createClient` reads these at runtime — they are not baked into the build. For
local development, `flue dev --env <file>` and `flue run --env <file>` load any
`.env`-format file. In production, supply them from your platform's secret store.

```ts title="src/db.ts"
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

export default libsql({
  query: async (text, params = []) =>
    toRows(await client.execute({ sql: text, args: params })),
  transaction: async (fn) => {
    const tx = await client.transaction('write');
    try {
      const result = await fn({
        query: async (text, params = []) =>
          toRows(await tx.execute({ sql: text, args: params })),
      });
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  },
  close: () => client.close(),
});
```

Turso serializes writes server-side, so there is no embedded-file concurrency
concern. The runner shape (`query`, `transaction`, `close`) and the `ResultSet`
mapping are explained in the [libSQL guide](/docs/ecosystem/databases/libsql/).

## Embedded replicas

For lower read latency, Turso supports **embedded replicas** — a local SQLite
file kept in sync with the remote database, so reads hit local disk and writes
forward to Turso. Point `url` at a local file and add `syncUrl`:

```ts title="src/db.ts"
const client = createClient({
  url: 'file:flue-replica.db',
  syncUrl: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});
```

The rest of the `db.ts` is unchanged. Reach for this when read latency matters;
the plain remote client above is the default.

## Migrations

The adapter's `migrate()` hook runs automatically when the generated Node
server starts. It creates Flue's `flue_*` tables idempotently and stamps a
schema version, so a fresh database is provisioned on first boot and an existing
one is reused on restart. There is no separate migration command to run, and a
database written by a newer Flue refuses to start rather than corrupting state.

## What gets stored

A Flue database stores runtime state, not your whole application.

| Stored by Flue | Not stored by Flue |
| --- | --- |
| Agent session messages and compaction state | Sandbox files and installed dependencies |
| Accepted direct prompts and `dispatch(...)` submissions | External API side effects |
| Workflow-run records and persisted events | Application-owned business data unless your own tools store it |
| Run indexing for `/runs` lookups and `listRuns()` | Provider credentials or secrets |

See [Durable Agents](/docs/concepts/durable-execution/) for how recovery uses
submission state, and the [Data Persistence API](/docs/api/data-persistence-api/)
for the exact adapter contract.

## When to choose Turso

Choose Turso when you want a managed, replicated SQLite without running a
server, and optionally embedded replicas for low-latency reads. For a local
file or a libSQL server you operate yourself, use the same adapter via the
[libSQL guide](/docs/ecosystem/databases/libsql/). For a multi-replica Node
deployment on Postgres, see [`@flue/postgres`](/docs/ecosystem/databases/postgres/).
