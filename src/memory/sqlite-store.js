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

/** 生成 UUID */
function _uuid() {
  return crypto.randomUUID();
}

/**
 * 动态加载 better-sqlite3 模块（使用 createRequire 兼容 ESM）
 * @returns {Function} better-sqlite3 构造函数
 * @throws {Error} 未安装 better-sqlite3 时抛出错误
 */
function _loadDatabase() {
  try {
    const require = createRequire(import.meta.url);
    const betterSqlite3 = require('better-sqlite3');
    return betterSqlite3;
  } catch {
    throw new Error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
  }
}

/** 基础建表 SQL：sessions、turns、memory_items、memory_events、memory_aliases */
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

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_aliases (
  memory_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (memory_id, alias)
);
`;

/** sessions 表的增量列（后续迁移添加） */
const SESSION_COLUMNS = {
  project_id: "TEXT NOT NULL DEFAULT 'default'",
  session_date: "TEXT NOT NULL DEFAULT ''",
  started_at: "TEXT NOT NULL DEFAULT ''",
  title: "TEXT NOT NULL DEFAULT ''",
  summary: "TEXT NOT NULL DEFAULT ''",
  tags_json: "TEXT NOT NULL DEFAULT '[]'",
  status: "TEXT NOT NULL DEFAULT 'active'",
};

/** turns 表的增量列（后续迁移添加） */
const TURN_COLUMNS = {
  seq_no: "INTEGER NOT NULL DEFAULT 0",
  created_at_ts: "INTEGER NOT NULL DEFAULT 0",
  references_json: "TEXT NOT NULL DEFAULT '{}'",
};

/** memory_items 表的增量列（后续迁移添加） */
const MEMORY_ITEM_COLUMNS = {
  session_id: "TEXT",
  content: "TEXT NOT NULL DEFAULT ''",
  status: "TEXT NOT NULL DEFAULT 'active'",
  source: "TEXT NOT NULL DEFAULT 'manual'",
  aliases_json: "TEXT NOT NULL DEFAULT '[]'",
  path_hints_json: "TEXT NOT NULL DEFAULT '[]'",
  collection_hints_json: "TEXT NOT NULL DEFAULT '[]'",
  last_choice: "TEXT",
};

/**
 * 确保表中包含指定列（幂等迁移），缺失的列通过 ALTER TABLE ADD COLUMN 添加
 * @param {Object} db - better-sqlite3 数据库实例
 * @param {string} tableName - 表名
 * @param {Object} columns - 列名到 DDL 定义的映射
 */
function _ensureColumns(db, tableName, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name)
  );
  for (const [column, ddl] of Object.entries(columns)) {
    if (existing.has(column)) continue;
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${ddl}`).run();
  }
}

/**
 * SQLite 存储层，提供记忆、会话、轮次的持久化操作
 * 基于 better-sqlite3 的同步 API，与 Python localmem_v2 schema 对齐
 */
export class SqliteStore {
  /**
   * @param {string} [dbPath] - 数据库文件路径，默认 LOCALMEM_DIR/localmem.db
   */
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.join(LOCALMEM_DIR, 'localmem.db');
    this.db = null;
    this._connectSync();
  }

  /** 同步连接数据库，启用 WAL 模式并执行迁移 */
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

  /** 关闭数据库连接 */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** 执行数据库迁移：建表、补充列、创建索引、删除废弃表和 FTS5、迁移旧状态 */
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
      CREATE INDEX IF NOT EXISTS idx_aliases_memory ON memory_aliases(memory_id);
    `);

    // Drop deprecated tables (wiki promotion path removed, mentions unused)
    try { this.db.exec('DROP TABLE IF EXISTS memory_reviews'); } catch {}
    try { this.db.exec('DROP TABLE IF EXISTS wiki_exports'); } catch {}
    try { this.db.exec('DROP TABLE IF EXISTS memory_mentions'); } catch {}
    try { this.db.exec('DROP TABLE IF EXISTS runtime_state'); } catch {}

    // Migrate old states to new simplified states
    this._migrateStates();

    // Drop FTS5 — not used for memory queries (CJK unsupported by default tokenizer)
    try { this.db.exec('DROP TABLE IF EXISTS memory_items_fts'); } catch {}
    try { this.db.exec('DROP TRIGGER IF EXISTS memory_items_ai'); } catch {}
    try { this.db.exec('DROP TRIGGER IF EXISTS memory_items_ad'); } catch {}
    try { this.db.exec('DROP TRIGGER IF EXISTS memory_items_au'); } catch {}
  }

  // ========== Sessions ==========

  /**
   * 创建会话（INSERT OR REPLACE）
   * @param {Object} session - 会话对象
   * @param {string} session.session_id - 会话 ID
   * @param {string} [session.project_id] - 项目 ID
   * @param {string} [session.title] - 标题
   * @param {string} session.created_at - 创建时间
   * @param {string} [session.updated_at] - 更新时间
   * @param {string} [session.status] - 状态
   * @returns {Object} 传入的会话对象
   */
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

  /**
   * 获取会话
   * @param {string} sessionId - 会话 ID
   * @returns {Object|null} 会话对象，不存在时返回 null
   */
  getSession(sessionId) {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId);
    return row ? this._rowToSession(row) : null;
  }

  /**
   * 获取指定项目的活跃会话（按更新时间倒序取第一个）
   * @param {string} [projectId='default'] - 项目 ID
   * @returns {Object|null} 活跃会话对象
   */
  getActiveSession(projectId = 'default') {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE project_id = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1
    `);
    const row = stmt.get(projectId);
    return row ? this._rowToSession(row) : null;
  }

  /**
   * 更新会话字段（白名单：project_id、title、updated_at、status、summary、tags_json）
   * @param {string} sessionId - 会话 ID
   * @param {Object} updates - 需要更新的字段键值对
   */
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

  /**
   * 数据库行转会话对象
   * @param {Object} row - 数据库行
   * @returns {Object} 会话对象
   */
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

  /**
   * 追加对话轮次
   * @param {Object} turn - 轮次对象
   * @param {string} turn.turn_id - 轮次 ID
   * @param {string} turn.session_id - 会话 ID
   * @param {string} turn.role - 角色
   * @param {string} turn.content - 内容
   * @param {string} turn.created_at - 创建时间
   * @param {number} [turn.seq_no] - 序号
   * @param {Object} [turn.references] - 引用信息
   * @returns {Object} 传入的轮次对象
   */
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

  /**
   * 获取指定会话的轮次列表
   * @param {string} sessionId - 会话 ID
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 轮次列表
   */
  getTurns(sessionId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM turns WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(sessionId, limit).map(r => this._rowToTurn(r));
  }

  /**
   * 获取指定会话的最后一条轮次
   * @param {string} sessionId - 会话 ID
   * @returns {Object|null} 最后一条轮次对象
   */
  getLastTurn(sessionId) {
    const stmt = this.db.prepare(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(sessionId);
    return row ? this._rowToTurn(row) : null;
  }

  /**
   * 数据库行转轮次对象
   * @param {Object} row - 数据库行
   * @returns {Object} 轮次对象
   */
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

  /**
   * 保存记忆条目（INSERT OR REPLACE），同步别名表
   * @param {Object} memory - 记忆对象
   * @param {string} memory.memory_id - 记忆 ID
   * @param {string} [memory.canonical_key] - 规范键
   * @param {string} [memory.summary] - 摘要
   * @param {string} [memory.state] - 状态（tentative/kept）
   * @param {string} [memory.content] - 内容
   * @param {string[]} [memory.aliases] - 别名列表
   * @param {string[]} [memory.path_hints] - 路径提示
   * @param {string[]} [memory.collection_hints] - 集合提示
   * @returns {Object} 保存后的记忆对象
   */
  saveMemory(memory) {
    const now = memory.updated_at || memory.created_at || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_items
      (id, canonical_key, summary, state, status, source, content,
       session_id, created_at, updated_at,
       aliases_json, path_hints_json, collection_hints_json, last_choice)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      memory.memory_id,
      memory.canonical_key || '',
      memory.summary || memory.content || '',
      memory.state || 'tentative',
      memory.status || 'active',
      memory.source || 'manual',
      memory.content || '',
      memory.session_id || memory.source_session_id || null,
      memory.created_at || now,
      now,
      JSON.stringify(memory.aliases || []),
      JSON.stringify(memory.path_hints || []),
      JSON.stringify(memory.collection_hints || []),
      memory.last_choice || null
    );

    // Sync aliases table
    this.db.prepare('DELETE FROM memory_aliases WHERE memory_id = ?').run(memory.memory_id);
    const aliasStmt = this.db.prepare('INSERT INTO memory_aliases (memory_id, alias) VALUES (?, ?)');
    for (const alias of (memory.aliases || [])) {
      aliasStmt.run(memory.memory_id, alias);
    }

    return this._rowToMemory(this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(memory.memory_id));
  }

  /**
   * 获取单条记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Object|null} 记忆对象
   */
  getMemory(memoryId) {
    const stmt = this.db.prepare('SELECT * FROM memory_items WHERE id = ?');
    const row = stmt.get(memoryId);
    return row ? this._rowToMemory(row) : null;
  }

  /**
   * 基于 LIKE 的记忆查询，每个分词须在 content 中出现，支持中文
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回数量上限
   * @returns {Array<Object>} 匹配的记忆列表
   */
  queryMemory(query, topK = 3) {
    // Use LIKE-based search with tokenized terms for CJK support.
    // FTS5 default tokenizer doesn't handle Chinese, so we avoid it for memory queries.
    if (!query || !query.trim()) return [];

    // Build WHERE clause: each token must appear in content
    const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => 'content LIKE ?').join(' AND ');
    const params = terms.map(t => `%${t}%`);

    const stmt = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE ${conditions} AND status = 'active' AND state IN ('tentative', 'kept')
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    return stmt.all(...params, topK).map(r => this._rowToMemory(r));
  }

  /**
   * 按状态列出记忆
   * @param {string} status - 状态值
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 记忆列表
   */
  listMemoryByStatus(status, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items WHERE status = ?
      ORDER BY updated_at DESC LIMIT ?
    `);
    return stmt.all(status, limit).map(r => this._rowToMemory(r));
  }

  /**
   * 按状态（tentative/kept）列出活跃记忆
   * @param {string} state - 状态值
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 记忆列表
   */
  listMemoryByState(state, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items WHERE state = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT ?
    `);
    return stmt.all(state, limit).map(r => this._rowToMemory(r));
  }

  /**
   * 更新记忆内容
   * @param {string} memoryId - 记忆 ID
   * @param {string} content - 新内容
   * @returns {boolean} 始终返回 true
   */
  updateMemoryContent(memoryId, content) {
    const stmt = this.db.prepare(`
      UPDATE memory_items SET content = ?, summary = ?, updated_at = ? WHERE id = ?
    `);
    const now = new Date().toISOString();
    stmt.run(content, content, now, memoryId);
    return true;
  }

  /**
   * 更新记忆状态（白名单：state、status、last_choice、updated_at）
   * @param {string} memoryId - 记忆 ID
   * @param {string} [state] - 新状态值
   * @param {Object} [extra] - 额外需要更新的字段
   */
  updateMemoryState(memoryId, state, extra = {}) {
    const allowed = ['state', 'status', 'last_choice', 'updated_at'];
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

  /**
   * 硬删除记忆条目（同时清理别名记录）
   * @param {string} memoryId - 记忆 ID
   * @returns {boolean} 是否删除成功
   */
  deleteMemory(memoryId) {
    // Clean up aliases first
    this.db.prepare('DELETE FROM memory_aliases WHERE memory_id = ?').run(memoryId);
    // Hard delete the memory item
    const stmt = this.db.prepare('DELETE FROM memory_items WHERE id = ?');
    const result = stmt.run(memoryId);
    return result.changes > 0;
  }

  /**
   * 数据库行转记忆对象（反序列化 JSON 字段）
   * @param {Object} row - 数据库行
   * @returns {Object} 记忆对象
   */
  _rowToMemory(row) {
    return {
      memory_id: row.id,
      canonical_key: row.canonical_key || '',
      summary: row.summary || '',
      state: row.state || 'tentative',
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
      last_choice: row.last_choice || null,
    };
  }

  // ========== Timeline (memory_events table) ==========

  /**
   * 添加记忆时间线事件
   * @param {Object} event - 事件对象
   * @param {string} event.memory_id - 关联的记忆 ID
   * @param {string} event.event_type - 事件类型
   * @param {string} event.created_at - 创建时间
   * @param {Object} [event.event_data] - 事件数据
   */
  addEvent(event) {
    const stmt = this.db.prepare(`
      INSERT INTO memory_events (id, memory_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(_uuid(), event.memory_id, event.event_type, event.created_at, JSON.stringify(event.event_data || {}));
  }

  /**
   * 获取记忆的时间线事件列表
   * @param {string} memoryId - 记忆 ID
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 事件列表
   */
  getTimeline(memoryId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events WHERE memory_id = ?
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(memoryId, limit);
  }

  // ========== Stats ==========

  /**
   * 获取存储统计摘要
   * @returns {{ total: number, active: number, tentative: number, kept: number, sessions: number }}
   */
  statsSummary() {
    const total = this.db.prepare("SELECT COUNT(*) as c FROM memory_items").get().c;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE status = 'active' AND state IN ('tentative', 'kept')").get().c;
    const tentative = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE state = 'tentative' AND status = 'active'").get().c;
    const kept = this.db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE state = 'kept' AND status = 'active'").get().c;
    const sessions = this.db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
    return { total, active, tentative, kept, sessions };
  }

  /**
   * 获取今日自动来源的记忆写入数量
   * @returns {number} 今日写入数量
   */
  getDailyWriteCount() {
    const today = new Date().toISOString().split('T')[0];
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as c FROM memory_items
      WHERE created_at LIKE ? AND source IN ('auto_triage', 'user_explicit', 'auto_draft')
    `);
    return stmt.get(`${today}%`).c;
  }

  /**
   * 列出所有活跃记忆事实（状态为 active 且状态为 tentative/kept）
   * @param {number} [limit=1000] - 返回数量上限
   * @returns {Array<Object>} 活跃记忆列表
   */
  listActiveFacts(limit = 1000) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE status = 'active' AND state IN ('tentative', 'kept')
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    return stmt.all(limit).map(r => this._rowToMemory(r));
  }

  /**
   * 替代旧记忆：删除旧记忆、插入新记忆、记录替代事件
   * @param {string} oldMemoryId - 旧记忆 ID
   * @param {Object} newMemory - 新记忆对象
   * @returns {{ oldMemoryId: string, newMemory: Object }} 替代结果
   */
  supersedeMemory(oldMemoryId, newMemory) {
    const now = newMemory.created_at || new Date().toISOString();
    // Delete old memory
    this.deleteMemory(oldMemoryId);

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

  /**
   * 清理超过指定天数的旧轮次
   * @param {number} maxAgeDays - 最大保留天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupOldTurns(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM turns WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  /**
   * 清理超过指定天数的旧会话（排除活跃会话和有轮次关联的会话）
   * @param {number} maxAgeDays - 最大保留天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupOldSessions(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM sessions
      WHERE updated_at < ? AND status != 'active'
      AND id NOT IN (SELECT DISTINCT session_id FROM turns)
    `).run(cutoff);
    return { deleted: result.changes };
  }

  /**
   * 清理超过指定天数的旧事件
   * @param {number} maxAgeDays - 最大保留天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupOldEvents(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM memory_events WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  /**
   * 清理超过指定天数仍未确认的暂定记忆
   * @param {number} ttlDays - 暂定记忆存活天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupExpiredTentative(ttlDays) {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM memory_items
      WHERE state = 'tentative' AND status = 'active' AND created_at < ?
    `).run(cutoff);
    return { deleted: result.changes };
  }

  // ========== State Migration ==========

  /** 迁移旧状态到简化的 tentative/kept 模型，清理废弃和孤立数据 */
  _migrateStates() {
    // Migrate old states to simplified tentative/kept model
    try {
      this.db.prepare("UPDATE memory_items SET state = 'kept' WHERE state IN ('local_only', 'manual_only') AND status = 'active'").run();
      this.db.prepare("UPDATE memory_items SET state = 'tentative' WHERE state IN ('wiki_candidate', 'candidate_on_reuse') AND status = 'active'").run();
      // Delete discarded/archived items (they were soft-deleted before, now we hard-delete)
      this.db.prepare("DELETE FROM memory_items WHERE state = 'discarded' OR status IN ('archived', 'discarded')").run();
      // Clean up orphaned aliases
      this.db.prepare("DELETE FROM memory_aliases WHERE memory_id NOT IN (SELECT id FROM memory_items)").run();
    } catch (err) {
      // Non-fatal: migration best-effort
    }
  }
}

export default SqliteStore;
