import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SessionLifecycleEvent, SkillLifecycleEvent } from './types.ts';

const HOME = process.env.HOME ?? '';
export const DEFAULT_DB_PATH = `${HOME}/.pray-bot/lifecycle-stream.db`;

// ── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_lifecycle_events (
    id TEXT PRIMARY KEY,
    occurred_at_iso TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    phase TEXT NOT NULL,
    project_path TEXT,
    cwd TEXT,
    raw_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_session_events_time
    ON session_lifecycle_events (session_id, occurred_at_iso DESC);

  CREATE TABLE IF NOT EXISTS skill_lifecycle_events (
    id TEXT PRIMARY KEY,
    occurred_at_iso TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    phase TEXT NOT NULL,
    trigger_command TEXT,
    target_doc_path TEXT,
    turn_seq INTEGER,
    project_path TEXT,
    raw_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_skill_events_session_time
    ON skill_lifecycle_events (session_id, occurred_at_iso DESC);

  CREATE TABLE IF NOT EXISTS lifecycle_stream_offsets (
    stream_key TEXT PRIMARY KEY,
    inode TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    updated_at_iso TEXT NOT NULL
  );
`;

// ── LifecycleStore ─────────────────────────────────────────────────────────

export class LifecycleStore {
  private readonly db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run(SCHEMA);
  }

  // ── Session events ─────────────────────────────────────────────────────

  insertSessionEvent(event: SessionLifecycleEvent): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_lifecycle_events
        (id, occurred_at_iso, session_id, provider, phase, project_path, cwd, raw_json)
      VALUES ($id, $occurredAtIso, $sessionId, $provider, $phase, $projectPath, $cwd, $rawJson)
    `);
    const result = stmt.run({
      $id: event.id,
      $occurredAtIso: event.occurredAtIso,
      $sessionId: event.sessionId,
      $provider: event.provider,
      $phase: event.phase,
      $projectPath: event.projectPath ?? null,
      $cwd: event.cwd ?? null,
      $rawJson: JSON.stringify(event),
    });
    return result.changes > 0;
  }

  // ── Skill events ───────────────────────────────────────────────────────

  insertSkillEvent(event: SkillLifecycleEvent): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO skill_lifecycle_events
        (id, occurred_at_iso, session_id, provider, skill_name, phase,
         trigger_command, target_doc_path, turn_seq, project_path, raw_json)
      VALUES (
        $id, $occurredAtIso, $sessionId, $provider, $skillName, $phase,
        $triggerCommand, $targetDocPath, $turnSeq, $projectPath, $rawJson
      )
    `);
    const result = stmt.run({
      $id: event.id,
      $occurredAtIso: event.occurredAtIso,
      $sessionId: event.sessionId,
      $provider: event.provider,
      $skillName: event.skillName,
      $phase: event.phase,
      $triggerCommand: event.triggerCommand ?? null,
      $targetDocPath: event.targetDocPath ?? null,
      $turnSeq: event.turnSeq ?? null,
      $projectPath: event.projectPath ?? null,
      $rawJson: JSON.stringify(event),
    });
    return result.changes > 0;
  }

  // ── Offset tracking ────────────────────────────────────────────────────

  getOffset(streamKey: string): { inode: string; byteOffset: number } | null {
    const stmt = this.db.prepare(`
      SELECT inode, byte_offset FROM lifecycle_stream_offsets WHERE stream_key = $streamKey
    `);
    const row = stmt.get({ $streamKey: streamKey }) as
      | { inode: string; byte_offset: number }
      | null;
    if (!row) return null;
    return { inode: row.inode, byteOffset: row.byte_offset };
  }

  setOffset(streamKey: string, inode: string, byteOffset: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO lifecycle_stream_offsets (stream_key, inode, byte_offset, updated_at_iso)
      VALUES ($streamKey, $inode, $byteOffset, $updatedAtIso)
      ON CONFLICT(stream_key) DO UPDATE SET
        inode = excluded.inode,
        byte_offset = excluded.byte_offset,
        updated_at_iso = excluded.updated_at_iso
    `);
    stmt.run({
      $streamKey: streamKey,
      $inode: inode,
      $byteOffset: byteOffset,
      $updatedAtIso: new Date().toISOString(),
    });
  }

  close(): void {
    this.db.close();
  }
}
