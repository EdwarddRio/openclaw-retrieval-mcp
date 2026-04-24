/**
 * SQLite store for memory system.
 * Uses better-sqlite3 for synchronous operations.
 * Schema aligned with Python localmem_v2.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { LOCALMEM_DIR } from '../config.js';

function _uuid() {
  return crypto.randomUUID();
}

function _loadDatabase() {
  try {
    const require = createRequire(import.meta.url);
    const betterSqlite3 = require('better-sqlite3');
    return betterSqlite3;
  } catch {
    throw new Error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
  }
}

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_mentions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  mention_type TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_reviews (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS wiki_exports (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  output_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_aliases (
  memory_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (memory_id, alias)
);

CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
`;

const SESSION_COLUMNS = {
  project_id: "TEXT NOT NULL DEFAULT 'default'",
  session_date: "TEXT NOT NULL DEFAULT ''",
  started_at: "TEXT NOT NULL DEFAULT ''",
  title: "TEXT NOT NULL DEFAULT ''",
  summary: "TEXT NOT NULL DEFAULT ''",
  tags_json: "TEXT NOT NULL DEFAULT '[]'",
  status: "TEXT NOT NULL DEFAULT 'active'",
};

const TURN_COLUMNS = {
  seq_no: "INTEGER NOT NULL DEFAULT 0",
  created_at_ts: "INTEGER NOT NULL DEFAULT 0",
  references_json: "TEXT NOT NULL DEFAULT '{}'",
};

const MEMORY_ITEM_COLUMNS = {
  session_id: "TEXT",
  content: "TEXT NOT NULL DEFAULT ''",
  status: "TEXT NOT NULL DEFAULT 'active'",
  source: "TEXT NOT NULL DEFAULT 'manual'",
  aliases_json: "TEXT NOT NULL DEFAULT '[]'",
  path_hints_json: "TEXT NOT NULL DEFAULT '[]'",
  collection_hints_json: "TEXT NOT NULL DEFAULT '[]'",
  output_path: "TEXT",
  rule_output_path: "TEXT",
  publish_targets_json: "TEXT NOT NULL DEFAULT '[]'",
  slug: "TEXT",
  wiki_title: "TEXT",
  last_choice: "TEXT",
  last_review_action: "TEXT",
};

function _ensureColumns(db, tableName, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name)
  );
  for (const [column, ddl] of Object.entries(columns)) {
    if (existing.has(column)) continue;
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${ddl}`).run();
  }
}

export class SqliteStore {
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.join(LOCALMEM_DIR, 'localmem.db');
    this.db = null;
    this._connectSync();
  }

  _connectSync() {
    const DbClass = _loadDatabase();
    if (this.db) return this.db;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DbClass(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  _migrate() {
    this.db.exec(BASE_SCHEMA);

    // Ensure columns (idempotent migrations)
    _ensureColumns(this.db, 'sessions', SESSION_COLUMNS);
    _ensureColumns(this.db, 'turns', TURN_COLUMNS);
    _ensureColumns(this.db, 'memory_items', MEMORY_ITEM_COLUMNS);

    // Ensure indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_items_status_updated ON memory_items(status, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_items_state_status_updated ON memory_items(state, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_items_ck_status ON memory_items(canonical_key, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_ck_active ON memory_items(canonical_key) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_mentions_memory_seen_session ON memory_mentions(memory_id, seen_at, session_id);
      CREATE INDEX IF NOT EXISTS idx_mentions_seen_at ON memory_mentions(seen_at);
      CREATE INDEX IF NOT EXISTS idx_reviews_memory ON memory_reviews(memory_id);
      CREATE INDEX IF NOT EXISTS idx_aliases_memory ON memory_aliases(memory_id);
    `);

    // Ensure FTS5 with triggers
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
          content,
          content='memory_items',
          content_rowid='rowid'
        );
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
          INSERT INTO memory_items_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
          INSERT INTO memory_items_fts(memory_items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
          INSERT INTO memory_items_fts(memory_items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          INSERT INTO memory_items_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
      // Rebuild if counts mismatch
      const countItems = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE status = 'active'").get().c;
      const countFts = this.db.prepare("SELECT COUNT(*) as c FROM memory_items_fts").get().c;
      if (countItems !== countFts) {
        this.db.exec("INSERT INTO memory_items_fts(memory_items_fts) VALUES ('rebuild')");
      }
    } catch {
      // FTS5 may not be available in all builds
    }
  }

  // ========== Sessions ==========

  createSession(session) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, updated_at, status, session_date, started_at, summary, tags_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.session_id,
      session.project_id || 'default',
      session.title || '',
      session.created_at,
      session.updated_at || session.created_at,
      session.status || 'active',
      session.session_date || '',
      session.started_at || session.created_at,
      session.summary || '',
      JSON.stringify(session.tags || [])
    );
    return session;
  }

  getSession(sessionId) {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId);
    return row ? this._rowToSession(row) : null;
  }

  getActiveSession(projectId = 'default') {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE project_id = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1
    `);
    const row = stmt.get(projectId);
    return row ? this._rowToSession(row) : null;
  }

  updateSession(sessionId, updates) {
    const allowed = ['project_id', 'title', 'updated_at', 'status', 'summary', 'tags_json'];
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k)) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return;
    const stmt = this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values, sessionId);
  }

  _rowToSession(row) {
    return {
      session_id: row.id,
      project_id: row.project_id || 'default',
      title: row.title || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      status: row.status || 'active',
      session_date: row.session_date || '',
      started_at: row.started_at || '',
      summary: row.summary || '',
      tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    };
  }

  // ========== Turns ==========

  appendTurn(turn) {
    const stmt = this.db.prepare(`
      INSERT INTO turns (id, session_id, role, content, created_at, seq_no, references_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      turn.turn_id,
      turn.session_id,
      turn.role,
      turn.content,
      turn.created_at,
      turn.seq_no || 0,
      JSON.stringify(turn.references || {})
    );

    // Update session updated_at
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(turn.created_at, turn.session_id);

    return turn;
  }

  getTurns(sessionId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM turns WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(sessionId, limit).map(r => this._rowToTurn(r));
  }

  getLastTurn(sessionId) {
    const stmt = this.db.prepare(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(sessionId);
    return row ? this._rowToTurn(row) : null;
  }

  _rowToTurn(row) {
    return {
      turn_id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
      seq_no: row.seq_no || 0,
      references: row.references_json ? JSON.parse(row.references_json) : {},
    };
  }

  // ========== Memory Items ==========

  saveMemory(memory) {
    const now = memory.updated_at || memory.created_at || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_items
      (id, canonical_key, summary, state, status, source, content,
       session_id, created_at, updated_at,
       aliases_json, path_hints_json, collection_hints_json,
       output_path, rule_output_path, publish_targets_json,
       slug, wiki_title, last_choice, last_review_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      memory.memory_id,
      memory.canonical_key || '',
      memory.summary || memory.content || '',
      memory.state || memory.status || 'tentative',
      memory.status || 'active',
      memory.source || 'manual',
      memory.content || '',
      memory.session_id || memory.source_session_id || null,
      memory.created_at || now,
      now,
      JSON.stringify(memory.aliases || []),
      JSON.stringify(memory.path_hints || []),
      JSON.stringify(memory.collection_hints || []),
      memory.output_path || null,
      memory.rule_output_path || null,
      JSON.stringify(memory.publish_targets || []),
      memory.slug || null,
      memory.wiki_title || null,
      memory.last_choice || null,
      memory.last_review_action || null
    );

    // Sync aliases table
    this.db.prepare('DELETE FROM memory_aliases WHERE memory_id = ?').run(memory.memory_id);
    const aliasStmt = this.db.prepare('INSERT INTO memory_aliases (memory_id, alias) VALUES (?, ?)');
    for (const alias of (memory.aliases || [])) {
      aliasStmt.run(memory.memory_id, alias);
    }

    return this._rowToMemory(this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(memory.memory_id));
  }

  getMemory(memoryId) {
    const stmt = this.db.prepare('SELECT * FROM memory_items WHERE id = ?');
    const row = stmt.get(memoryId);
    return row ? this._rowToMemory(row) : null;
  }

  queryMemory(query, topK = 3) {
    // Try FTS5 first, fallback to LIKE
    try {
      const stmt = this.db.prepare(`
        SELECT mi.* FROM memory_items mi
        JOIN memory_items_fts fts ON mi.rowid = fts.rowid
        WHERE memory_items_fts MATCH ? AND mi.status != 'discarded'
        ORDER BY rank
        LIMIT ?
      `);
      return stmt.all(query, topK).map(r => this._rowToMemory(r));
    } catch {
      const stmt = this.db.prepare(`
        SELECT * FROM memory_items
        WHERE content LIKE ? AND status != 'discarded'
        ORDER BY updated_at DESC
        LIMIT ?
      `);
      return stmt.all(`%${query}%`, topK).map(r => this._rowToMemory(r));
    }
  }

  listMemoryByStatus(status, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items WHERE status = ?
      ORDER BY updated_at DESC LIMIT ?
    `);
    return stmt.all(status, limit).map(r => this._rowToMemory(r));
  }

  listMemoryByState(state, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items WHERE state = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT ?
    `);
    return stmt.all(state, limit).map(r => this._rowToMemory(r));
  }

  updateMemoryContent(memoryId, content) {
    const stmt = this.db.prepare(`
      UPDATE memory_items SET content = ?, summary = ?, updated_at = ? WHERE id = ?
    `);
    const now = new Date().toISOString();
    stmt.run(content, content, now, memoryId);
    return true;
  }

  updateMemoryState(memoryId, state, extra = {}) {
    const allowed = ['state', 'status', 'last_choice', 'last_review_action', 'output_path', 'slug', 'wiki_title', 'updated_at'];
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(extra)) {
      if (allowed.includes(k) && v !== undefined) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (state !== undefined) {
      fields.push('state = ?');
      values.push(state);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    const stmt = this.db.prepare(`UPDATE memory_items SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values, memoryId);
  }

  deleteMemory(memoryId) {
    const stmt = this.db.prepare(`
      UPDATE memory_items SET status = 'discarded', updated_at = ? WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), memoryId);
    return true;
  }

  _rowToMemory(row) {
    return {
      memory_id: row.id,
      canonical_key: row.canonical_key || '',
      summary: row.summary || '',
      state: row.state || 'local_only',
      status: row.status || 'active',
      source: row.source || 'manual',
      content: row.content || '',
      session_id: row.session_id || null,
      source_session_id: row.session_id || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      aliases: row.aliases_json ? JSON.parse(row.aliases_json) : [],
      path_hints: row.path_hints_json ? JSON.parse(row.path_hints_json) : [],
      collection_hints: row.collection_hints_json ? JSON.parse(row.collection_hints_json) : [],
      output_path: row.output_path || null,
      rule_output_path: row.rule_output_path || null,
      publish_targets: row.publish_targets_json ? JSON.parse(row.publish_targets_json) : [],
      slug: row.slug || null,
      wiki_title: row.wiki_title || null,
      last_choice: row.last_choice || null,
      last_review_action: row.last_review_action || null,
    };
  }

  // ========== Reviews ==========

  addReview(review) {
    const stmt = this.db.prepare(`
      INSERT INTO memory_reviews (id, memory_id, action, created_at, reason)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(_uuid(), review.memory_id, review.action, review.created_at, review.reason || '');
  }

  getReviews(memoryId) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_reviews WHERE memory_id = ? ORDER BY created_at DESC
    `);
    return stmt.all(memoryId);
  }

  // ========== Wiki Exports ==========

  addWikiExport(exportRecord) {
    const stmt = this.db.prepare(`
      INSERT INTO wiki_exports (id, memory_id, output_path, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(_uuid(), exportRecord.memory_id, exportRecord.output_path, exportRecord.created_at);
  }

  getWikiExports(memoryId) {
    const stmt = this.db.prepare(`
      SELECT * FROM wiki_exports WHERE memory_id = ? ORDER BY created_at DESC
    `);
    return stmt.all(memoryId);
  }

  // ========== Timeline (memory_events table) ==========

  addEvent(event) {
    const stmt = this.db.prepare(`
      INSERT INTO memory_events (id, memory_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(_uuid(), event.memory_id, event.event_type, event.created_at, JSON.stringify(event.event_data || {}));
  }

  getTimeline(memoryId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events WHERE memory_id = ?
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(memoryId, limit);
  }

  // ========== State ==========

  getState(key) {
    const stmt = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?');
    const row = stmt.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setState(key, value) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(key, JSON.stringify(value), new Date().toISOString());
  }

  // ========== Stats ==========

  statsSummary() {
    const total = this.db.prepare("SELECT COUNT(*) as c FROM memory_items").get().c;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE status = 'active'").get().c;
    const tentative = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE state = 'tentative' AND status = 'active'").get().c;
    const wikiCandidate = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE state = 'wiki_candidate' AND status = 'active'").get().c;
    const published = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE state = 'published' AND status = 'active'").get().c;
    const sessions = this.db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
    return { total, active, tentative, wiki_candidate: wikiCandidate, published, sessions };
  }

  getDailyWriteCount() {
    const today = new Date().toISOString().split('T')[0];
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as c FROM memory_items
      WHERE created_at LIKE ? AND source IN ('auto_triage', 'user_explicit', 'auto_draft')
    `);
    return stmt.get(`${today}%`).c;
  }

  listActiveFacts(limit = 1000) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE status = 'active' AND state != 'discarded'
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    return stmt.all(limit).map(r => this._rowToMemory(r));
  }

  supersedeMemory(oldMemoryId, newMemory) {
    const now = newMemory.created_at || new Date().toISOString();
    // Mark old memory as archived/superseded
    this.db.prepare(`
      UPDATE memory_items
      SET status = 'archived', state = 'discarded', updated_at = ?
      WHERE id = ?
    `).run(now, oldMemoryId);

    // Insert new memory
    const saved = this.saveMemory(newMemory);

    // Record event
    this.addEvent({
      memory_id: oldMemoryId,
      event_type: 'memory_superseded',
      created_at: now,
      event_data: { new_memory_id: saved.memory_id },
    });

    return { oldMemoryId, newMemory: saved };
  }

  // ========== Periodic cleanup ==========

  cleanupOldTurns(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM turns WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  cleanupOldSessions(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM sessions
      WHERE updated_at < ? AND status != 'active'
      AND id NOT IN (SELECT DISTINCT session_id FROM turns)
    `).run(cutoff);
    return { deleted: result.changes };
  }

  cleanupOldMentions(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM memory_mentions WHERE seen_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  cleanupOldEvents(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM memory_events WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  cleanupOldReviews(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM memory_reviews WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  cleanupExpiredTentative(ttlDays) {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM memory_items
      WHERE state = 'tentative' AND status = 'active' AND created_at < ?
    `).run(cutoff);
    return { deleted: result.changes };
  }
}

export default SqliteStore;
