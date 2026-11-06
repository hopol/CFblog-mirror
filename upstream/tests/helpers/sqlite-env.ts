import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Env, User } from '../../src/types';
import { generateToken } from '../../src/auth';
import { bumpPublicCacheVersion } from '../../src/public-site/cache';

export const TEST_JWT_SECRET = 'test-secret-with-at-least-32-random-looking-characters-123456';

// Execute the actual application SQL against SQLite, including constraints and
// transactions, while exposing the small D1 API used by the request handlers.
export async function createSqliteEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  const pending: Promise<unknown>[] = [];

  function prepare(sql: string, parameters: SQLInputValue[] = []) {
    return {
      bind(...values: SQLInputValue[]) {
        return prepare(sql, values);
      },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...parameters);
        return column ? row?.[column] ?? null : row ?? null;
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...parameters) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...parameters);
        return {
          success: true,
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      },
    };
  }

  const database = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const env = { DB: database, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  await bumpPublicCacheVersion(env);

  const executionCtx = {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    passThroughOnException() {},
  };

  function insertUser(id: number, role: User['role'] = 'administrator') {
    sqlite.prepare(`
      INSERT INTO users (id, username, email, password, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, `user-${id}`, `user-${id}@example.com`, 'unused-password', role);
    return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User;
  }

  async function authHeaders(id: number) {
    const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User;
    return { Authorization: `Bearer ${await generateToken(user, TEST_JWT_SECRET)}` };
  }

  async function close() {
    await Promise.allSettled(pending);
    sqlite.close();
  }

  return { env, sqlite, executionCtx, insertUser, authHeaders, close };
}

export type SqliteEnv = Awaited<ReturnType<typeof createSqliteEnv>>;
