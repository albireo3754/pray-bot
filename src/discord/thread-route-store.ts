import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type PersistedDiscordThreadRoute = {
  threadId: string;
  parentChannelId: string;
  mappingKey: string;
  provider: 'codex' | 'codex-app-server' | 'claude';
  providerSessionId: string;
  ownerUserId?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  autoDiscovered?: boolean;
};

const DB_DIR = join(process.env.HOME ?? '.', '.pray-bot');
const DB_PATH = join(DB_DIR, 'deploy.db');

let db: Database | null = null;
let upsertStmt: ReturnType<Database['prepare']> | null = null;
let deleteStmt: ReturnType<Database['prepare']> | null = null;
let listStmt: ReturnType<Database['prepare']> | null = null;
let findByThreadStmt: ReturnType<Database['prepare']> | null = null;
let findLatestByParentProviderStmt: ReturnType<Database['prepare']> | null = null;

type RouteRow = {
  threadId: string;
  parentChannelId: string;
  mappingKey: string;
  provider: string;
  providerSessionId: string;
  ownerUserId: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  autoDiscovered: number;
};

function toPersistedRoute(row: RouteRow): PersistedDiscordThreadRoute | null {
  if (row.provider !== 'codex' && row.provider !== 'codex-app-server' && row.provider !== 'claude') {
    return null;
  }
  return {
    threadId: row.threadId,
    parentChannelId: row.parentChannelId,
    mappingKey: row.mappingKey,
    provider: row.provider as 'codex' | 'codex-app-server' | 'claude',
    providerSessionId: row.providerSessionId ?? '',
    ownerUserId: row.ownerUserId ?? undefined,
    cwd: row.cwd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    autoDiscovered: row.autoDiscovered === 1,
  };
}

function ensureDb(): Database {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_thread_routes (
      thread_id TEXT PRIMARY KEY,
      parent_channel_id TEXT NOT NULL,
      mapping_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      auto_discovered INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

export function initDiscordThreadRouteStore(): void {
  ensureDb();
}

export function upsertDiscordThreadRoute(route: PersistedDiscordThreadRoute): void {
  const store = ensureDb();
  if (!upsertStmt) {
    upsertStmt = store.prepare(`
      INSERT INTO discord_thread_routes (
        thread_id,
        parent_channel_id,
        mapping_key,
        provider,
        provider_session_id,
        owner_user_id,
        cwd,
        created_at,
        updated_at,
        auto_discovered
      ) VALUES (
        $threadId,
        $parentChannelId,
        $mappingKey,
        $provider,
        $providerSessionId,
        $ownerUserId,
        $cwd,
        $createdAt,
        $updatedAt,
        $autoDiscovered
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        parent_channel_id = excluded.parent_channel_id,
        mapping_key = excluded.mapping_key,
        provider = excluded.provider,
        provider_session_id = excluded.provider_session_id,
        owner_user_id = excluded.owner_user_id,
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        auto_discovered = excluded.auto_discovered
    `);
  }

  upsertStmt.run({
    $threadId: route.threadId,
    $parentChannelId: route.parentChannelId,
    $mappingKey: route.mappingKey,
    $provider: route.provider,
    $providerSessionId: route.providerSessionId,
    $ownerUserId: route.ownerUserId ?? null,
    $cwd: route.cwd,
    $createdAt: route.createdAt,
    $updatedAt: route.updatedAt,
    $autoDiscovered: route.autoDiscovered ? 1 : 0,
  });
}

export function deleteDiscordThreadRoute(threadId: string): void {
  const store = ensureDb();
  if (!deleteStmt) {
    deleteStmt = store.prepare('DELETE FROM discord_thread_routes WHERE thread_id = $threadId');
  }
  deleteStmt.run({ $threadId: threadId });
}

export function listDiscordThreadRoutes(): PersistedDiscordThreadRoute[] {
  const store = ensureDb();
  if (!listStmt) {
    listStmt = store.prepare(`
      SELECT
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        mapping_key AS mappingKey,
        provider,
        provider_session_id AS providerSessionId,
        owner_user_id AS ownerUserId,
        cwd,
        created_at AS createdAt,
        updated_at AS updatedAt,
        auto_discovered AS autoDiscovered
      FROM discord_thread_routes
      ORDER BY updated_at DESC
    `);
  }

  const rows = listStmt.all() as RouteRow[];
  return rows
    .map((row) => toPersistedRoute(row))
    .filter((row): row is PersistedDiscordThreadRoute => !!row);
}

export function getDiscordThreadRoute(threadId: string): PersistedDiscordThreadRoute | null {
  const store = ensureDb();
  if (!findByThreadStmt) {
    findByThreadStmt = store.prepare(`
      SELECT
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        mapping_key AS mappingKey,
        provider,
        provider_session_id AS providerSessionId,
        owner_user_id AS ownerUserId,
        cwd,
        created_at AS createdAt,
        updated_at AS updatedAt,
        auto_discovered AS autoDiscovered
      FROM discord_thread_routes
      WHERE thread_id = $threadId
      LIMIT 1
    `);
  }
  const row = findByThreadStmt.get({ $threadId: threadId }) as RouteRow | null;
  if (!row) return null;
  return toPersistedRoute(row);
}

export function getLatestDiscordThreadRouteByParentProvider(
  parentChannelId: string,
  provider: 'codex' | 'codex-app-server' | 'claude',
): PersistedDiscordThreadRoute | null {
  const store = ensureDb();
  if (!findLatestByParentProviderStmt) {
    findLatestByParentProviderStmt = store.prepare(`
      SELECT
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        mapping_key AS mappingKey,
        provider,
        provider_session_id AS providerSessionId,
        owner_user_id AS ownerUserId,
        cwd,
        created_at AS createdAt,
        updated_at AS updatedAt,
        auto_discovered AS autoDiscovered
      FROM discord_thread_routes
      WHERE parent_channel_id = $parentChannelId AND provider = $provider
      ORDER BY updated_at DESC
      LIMIT 1
    `);
  }
  const row = findLatestByParentProviderStmt.get({
    $parentChannelId: parentChannelId,
    $provider: provider,
  }) as RouteRow | null;
  if (!row) return null;
  return toPersistedRoute(row);
}
