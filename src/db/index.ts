import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err, client) => {
      console.error('Unexpected error on idle SQL pool client:', err.message);
      if (client) {
        try {
          client.release(true);
        } catch {}
      }
    });

    global._postgresPool.on('connect', (client) => {
      client.on('error', (err) => {
        console.error('Database client error event caught safely:', err.message);
        try {
          client.release(true);
        } catch {}
      });
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const pgDb = drizzle(pool, { schema });
export type PgDatabase = typeof pgDb;
type Transaction = Parameters<Parameters<typeof pgDb.transaction>[0]>[0];

export async function lockCatalogWrites(tx: Transaction) {
  // Shared by catalog writers, including workers on other instances.
  await tx.execute(sql`select pg_advisory_xact_lock(187640, 1)`);
}

export function withCatalogWrite<T>(operation: (tx: Transaction) => Promise<T>) {
  return executeWithDbRetry(() =>
    pgDb.transaction(async (tx) => {
      await lockCatalogWrites(tx);
      return operation(tx);
    })
  );
}

function isDeadlock(error: unknown): boolean {
  for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth++) {
    const current = error as { code?: string; cause?: unknown };
    if (current.code === '40P01') return true;
    error = current.cause;
  }
  return false;
}

function isConnectionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Client has encountered a connection error') ||
    msg.includes('Connection terminated unexpectedly') ||
    msg.includes('Failed query: rollback') ||
    msg.includes('terminado inesperadamente') ||
    msg.includes('closed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND')
  );
}

export async function executeWithDbRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const deadlock = isDeadlock(err);
      if (attempt < maxRetries && (deadlock || isConnectionError(err))) {
        console.warn(
          `[DB Retry] ${deadlock ? '40P01' : 'Connection error'}; retrying transaction (${attempt}/${maxRetries}).`
        );
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt + Math.random() * 150));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
