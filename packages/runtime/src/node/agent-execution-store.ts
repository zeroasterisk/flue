/**
 * Node agent execution store backed by `node:sqlite` with an in-memory database.
 *
 * Uses the same SQL store implementation as Cloudflare (DO SQLite) but runs
 * against `node:sqlite`'s `DatabaseSync` with `:memory:`. Data lives for the
 * process lifetime only — restart loses everything.
 *
 * Swap `:memory:` for a file path to get local persistence without changing
 * the store contract.
 */

import { DatabaseSync } from 'node:sqlite';
import type { AgentExecutionStore, SqlStorage } from '../agent-execution-store.ts';
import { createSqlAgentExecutionStoreFromSql } from '../cloudflare/agent-execution-store.ts';

/**
 * Adapt `node:sqlite` {@link DatabaseSync} to the Cloudflare {@link SqlStorage}
 * shape expected by the shared SQL store implementation.
 */
function createNodeSqlStorage(db: DatabaseSync): SqlStorage {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			let rows: Record<string, unknown>[];
			try {
				rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
			} catch {
				stmt.run(...(bindings as never[]));
				rows = [];
			}
			return {
				toArray() {
					return rows;
				},
			};
		},
	};
}

/**
 * Create an in-memory transaction wrapper for `node:sqlite`.
 */
function createNodeTransactionSync(db: DatabaseSync): <T>(closure: () => T) => T {
	return <T>(closure: () => T): T => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
}

/**
 * Create a process-local {@link AgentExecutionStore} backed by `node:sqlite`.
 *
 * Uses `:memory:` by default — data is lost on process exit. Pass a file path
 * for local development persistence.
 */
export function createNodeAgentExecutionStore(
	path: string = ':memory:',
): AgentExecutionStore {
	const db = new DatabaseSync(path);
	const sql = createNodeSqlStorage(db);
	const runTransaction = createNodeTransactionSync(db);
	return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
}
