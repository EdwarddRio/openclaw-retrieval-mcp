/**
 * SQLite store for memory system.
 * Uses better-sqlite3 for synchronous operations.
 * Schema aligned with Python localmem_v2.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { LOCALMEM_DIR, logger } from '../config.js';
import { canonicalKeyForText, computeRelevanceScore, RELEVANCE_WEIGHTS } from './models.js';

/** 生成 UUID */
function _uuid() {
  return crypto.randomUUID();
}

function escapeLikePattern(str) {
  return str.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
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

/** 基础建表 SQL：sessions、turns、memory_items、memory_events、memory_aliases、entities、entity_facts */
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

-- v3.3: 实体表
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- v3.3: 实体-记忆关联表
CREATE TABLE IF NOT EXISTS entity_facts (
  entity_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  observation TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (entity_id, memory_id)
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
  evaluation_json: "TEXT",
  unique_query_hashes: "TEXT NOT NULL DEFAULT '[]'",
  // v3.3: weight-based lifecycle
  category: "TEXT NOT NULL DEFAULT 'general'",
  weight: "TEXT NOT NULL DEFAULT 'MEDIUM'",
  weight_set_at: "TEXT",
  expires_at: "TEXT",
  // v3.3: multi-scope and actor
  scope: "TEXT NOT NULL DEFAULT 'global'",
  scope_id: "TEXT NOT NULL DEFAULT ''",
  actor_id: "TEXT",
  actor_type: "TEXT",
};

/**
 * 确保表中包含指定列（幂等迁移），缺失的列通过 ALTER TABLE ADD COLUMN 添加
 * @param {Object} db - better-sqlite3 数据库实例
 * @param {string} tableName - 表名
 * @param {Object} columns - 列名到 DDL 定义的映射
 */
const ALLOWED_TABLES = new Set([
  'sessions', 'turns', 'memory_items', 'memory_events', 'memory_aliases',
  'entities', 'entity_facts',
]);

function _ensureColumns(db, tableName, columns) {
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error(`_ensureColumns: table "${tableName}" is not in the allowed list`);
  }
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name)
  );
  for (const [column, ddl] of Object.entries(columns)) {
    if (existing.has(column)) continue;
    if (!/^[a-zA-Z_]\w*$/.test(column)) {
      throw new Error(`_ensureColumns: invalid column name "${column}"`);
    }
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
    this._stmtCache = new Map();
    this._lastCheckpointAt = 0;
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
    this._maybeCheckpoint();
    return this.db;
  }

  /** 关闭数据库连接 */
  close() {
    if (this.db) {
      this._stmtCache.clear();
      this._maybeCheckpoint();
      this.db.close();
      this.db = null;
    }
  }

  /**
   * 获取或缓存 prepared statement，避免重复编译 SQL
   * @param {string} sql - SQL 语句
   * @returns {Object} better-sqlite3 prepared statement
   */
  _getStmt(sql) {
    if (this._stmtCache.has(sql)) {
      return this._stmtCache.get(sql);
    }
    const stmt = this.db.prepare(sql);
    this._stmtCache.set(sql, stmt);
    return stmt;
  }

  /**
   * 数据库健康检查：验证连接可用性、WAL 大小、表完整性
   * @returns {{ healthy: boolean, walSizeMb: number, tables: string[], error?: string }}
   */
  healthCheck() {
    try {
      // 验证连接
      this.db.prepare('SELECT 1').get();
      // 验证关键表存在
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
      const required = ['sessions', 'turns', 'memory_items', 'memory_events', 'memory_aliases'];
      const missing = required.filter(t => !tables.includes(t));
      if (missing.length > 0) {
        return { healthy: false, walSizeMb: 0, tables, error: `Missing tables: ${missing.join(', ')}` };
      }
      // WAL 大小
      const walSize = this.getWalSize();
      return { healthy: true, walSizeMb: walSize.walSizeMb, tables };
    } catch (err) {
      return { healthy: false, walSizeMb: 0, tables: [], error: err.message };
    }
  }

  /**
   * 获取 WAL 文件大小
   * @returns {{ walSizeMb: number, logFrames: number, checkpointedFrames: number }}
   */
  getWalSize() {
    try {
      const info = this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      const walPath = `${this.dbPath}-wal`;
      let walSizeMb = 0;
      if (fs.existsSync(walPath)) {
        walSizeMb = Math.round(fs.statSync(walPath).size / 1024 / 1024 * 100) / 100;
      }
      return {
        walSizeMb,
        logFrames: info?.log || 0,
        checkpointedFrames: info?.checkpointed || 0,
      };
    } catch (err) {
      return { walSizeMb: 0, logFrames: 0, checkpointedFrames: 0 };
    }
  }

  /**
   * 执行 WAL checkpoint，将 WAL 中的修改合并回主数据库并截断 WAL 文件
   * 每次连接/关闭时自动调用，外部也可显式调用
   */
  checkpoint() {
    if (!this.db) return;
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (result && result.checkpointed > 0) {
        logger.info(`SQLite WAL checkpoint: log=${result.log}, checkpointed=${result.checkpointed}`);
      }
    } catch (err) {
      logger.warn(`WAL checkpoint failed: ${err.message}`);
    }
  }

  /** 尝试 checkpoint：若 WAL 较大或距上次 checkpoint 超过 1 小时 */
  _maybeCheckpoint() {
    if (!this.db) return;
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      const walInfo = this.getWalSize();
      const shouldCheckpoint = walInfo.walSizeMb > 10 || walInfo.logFrames > 1000 || (now - this._lastCheckpointAt) > oneHour;
      if (shouldCheckpoint) {
        this.checkpoint();
        this._lastCheckpointAt = now;
      }
    } catch (err) {
      logger.warn(`[SqliteStore] Checkpoint check failed: ${err.message}`);
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
      CREATE INDEX IF NOT EXISTS idx_memory_items_weight_status ON memory_items(weight, status) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_memory_items_category_status ON memory_items(category, status) WHERE status = 'active';
    `);

    // Drop deprecated tables (wiki promotion path removed, mentions unused)
    const migrationVersion = this._getMigrationVersion();
    if (migrationVersion < 1) {
      try { this.db.exec('DROP TABLE IF EXISTS memory_reviews'); } catch {}
      try { this.db.exec('DROP TABLE IF EXISTS wiki_exports'); } catch {}
      try { this.db.exec('DROP TABLE IF EXISTS memory_mentions'); } catch {}
      try { this.db.exec('DROP TABLE IF EXISTS runtime_state'); } catch {}
      try { this.db.exec('DROP TABLE IF EXISTS memory_items_fts'); } catch {}
      try { this.db.exec('DROP TRIGGER IF EXISTS memory_items_ai'); } catch {}
      try { this.db.exec('DROP TRIGGER IF EXISTS memory_items_ad'); } catch {}
      try { this.db.exec('DROP TRIGGER IF EXISTS memory_items_au'); } catch {}
      this._setMigrationVersion(1);
    }

    // Migrate old states to new simplified states
    this._migrateStates();
  }

  _getMigrationVersion() {
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)');
      const row = this.db.prepare('SELECT value FROM _meta WHERE key = ?').get('migration_version');
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  _setMigrationVersion(version) {
    this.db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)').run('migration_version', String(version));
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
    const row = this._getStmt('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    return row ? this._rowToSession(row) : null;
  }

  /**
   * 获取指定项目的活跃会话（按更新时间倒序取第一个）
   * @param {string} [projectId='default'] - 项目 ID
   * @returns {Object|null} 活跃会话对象
   */
  getActiveSession(projectId = 'default') {
    const row = this._getStmt(`
      SELECT * FROM sessions WHERE project_id = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1
    `).get(projectId);
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
    this._getStmt('UPDATE sessions SET updated_at = ? WHERE id = ?')
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
    return this._getStmt(`
      SELECT * FROM turns WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit).map(r => this._rowToTurn(r));
  }

  /**
   * 获取指定会话的最后一条轮次
   * @param {string} sessionId - 会话 ID
   * @returns {Object|null} 最后一条轮次对象
   */
  getLastTurn(sessionId) {
    const row = this._getStmt(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(sessionId);
    return row ? this._rowToTurn(row) : null;
  }

  /**
   * 获取指定时间范围内的对话轮次
   * @param {number} hours - 查询最近多少小时的轮次
   * @returns {Array<Object>} 轮次列表
   */
  getTurnsSince(hours) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this._getStmt(
      `SELECT * FROM turns WHERE created_at >= ? ORDER BY created_at ASC`
    ).all(cutoff).map(r => this._rowToTurn(r));
  }

  /**
   * 获取指定会话中指定时间之前的最近一条轮次
   * @param {string} sessionId - 会话 ID
   * @param {string} beforeTime - ISO 时间字符串
   * @returns {Object|null} 轮次对象
   */
  getPreviousTurn(sessionId, beforeTime) {
    const row = this._getStmt(
      `SELECT * FROM turns WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`
    ).get(sessionId, beforeTime);
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
   * @param {string} [memory.state] - @deprecated 使用 category+weight 替代
   * @param {string} [memory.content] - 内容
   * @param {string[]} [memory.aliases] - 别名列表
   * @param {string[]} [memory.path_hints] - 路径提示
   * @param {string[]} [memory.collection_hints] - 集合提示
   * @param {string} [memory.category] - 记忆分类（fact|preference|project|instruction|episodic）
   * @param {string} [memory.weight] - 权重（STRONG|MEDIUM|WEAK）
   * @param {string} [memory.weight_set_at] - weight最后变更时间
   * @param {string} [memory.expires_at] - 过期时间
   * @returns {Object} 保存后的记忆对象
   */
  saveMemory(memory) {
    const now = memory.updated_at || memory.created_at || new Date().toISOString();

    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memory_items
        (id, canonical_key, summary, state, status, source, content,
         session_id, created_at, updated_at,
         aliases_json, path_hints_json, collection_hints_json, last_choice,
         category, weight, weight_set_at, expires_at,
         scope, scope_id, actor_id, actor_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        memory.last_choice || null,
        memory.category || 'general',
        memory.weight || 'MEDIUM',
        memory.weight_set_at || now,
        memory.expires_at || null,
        // v3.3: multi-scope and actor
        memory.scope || 'global',
        memory.scope_id || '',
        memory.actor_id || null,
        memory.actor_type || null
      );

      this._getStmt('DELETE FROM memory_aliases WHERE memory_id = ?').run(memory.memory_id);
      const aliasStmt = this._getStmt('INSERT INTO memory_aliases (memory_id, alias) VALUES (?, ?)');
      for (const alias of (memory.aliases || [])) {
        aliasStmt.run(memory.memory_id, alias);
      }

      return this._rowToMemory(this._getStmt('SELECT * FROM memory_items WHERE id = ?').get(memory.memory_id));
    });

    return txn();
  }

  /**
   * 获取单条记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Object|null} 记忆对象
   */
  getMemory(memoryId) {
    const row = this._getStmt('SELECT * FROM memory_items WHERE id = ?').get(memoryId);
    return row ? this._rowToMemory(row) : null;
  }

  /**
   * 通过规范键获取活跃记忆（用于去重检查）
   * @param {string} canonicalKey - 规范键
   * @returns {Object|null} 记忆对象
   */
  getMemoryByCanonicalKey(canonicalKey) {
    const row = this._getStmt(
      `SELECT * FROM memory_items WHERE canonical_key = ? AND status = 'active' LIMIT 1`
    ).get(canonicalKey);
    return row ? this._rowToMemory(row) : null;
  }

  /**
   * 基于 LIKE 的记忆查询，每个分词须在 content 中出现，支持中文
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回数量上限
   * @returns {Array<Object>} 匹配的记忆列表
   */
  queryMemory(query, topK = 3, sessionId = null) {
    if (!query || !query.trim()) return [];

    const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];

    const hasChinese = terms.some(t => /[\u4e00-\u9fff]/.test(t));
    const searchMode = process.env.MEMORY_SEARCH_MODE || (hasChinese ? 'or-first' : 'and-first');

    if (searchMode === 'or-first' && hasChinese) {
      return this._queryMemoryOrFirst(query, terms, topK, sessionId);
    }

    return this._queryMemoryAndFirst(query, terms, topK, sessionId);
  }

  _queryMemoryAndFirst(query, terms, topK, sessionId) {
    const andConditions = terms.map(() => "(content LIKE ? ESCAPE '!' OR aliases_json LIKE ? ESCAPE '!')").join(' AND ');
    const sessionClause = sessionId ? ' AND session_id = ?' : '';
    const andParams = [];
    for (const t of terms) {
      const escaped = escapeLikePattern(t);
      andParams.push(`%${escaped}%`, `%"${escaped}"%`);
    }
    if (sessionId) andParams.push(sessionId);
    const andStmt = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE (${andConditions}) AND status = 'active' AND state IN ('tentative', 'kept')
      ${sessionClause}
      ORDER BY updated_at DESC LIMIT ?
    `);
    let rows = andStmt.all(...andParams, topK * 3).map(r => this._rowToMemory(r));

    if (rows.length < topK) {
      const expandedTerms = [];
      for (const term of terms) {
        if (term.length > 1 && /[\u4e00-\u9fff]/.test(term)) {
          const bigrams = [];
          for (let i = 0; i < term.length - 1; i++) {
            const bigram = term.slice(i, i + 2);
            if (/[\u4e00-\u9fff]{2}/.test(bigram)) {
              bigrams.push(bigram);
            }
          }
          if (bigrams.length > 0) {
            expandedTerms.push(...bigrams);
          } else {
            expandedTerms.push(term);
          }
        } else {
          expandedTerms.push(term);
        }
      }

      if (expandedTerms.length > terms.length) {
        const minMatch = Math.ceil(expandedTerms.length / 2);
        const orConditions = expandedTerms.map(() => "(content LIKE ? ESCAPE '!' OR aliases_json LIKE ? ESCAPE '!')").join(' OR ');
        const orParams = [];
        for (const t of expandedTerms) {
          const escaped = escapeLikePattern(t);
          orParams.push(`%${escaped}%`, `%"${escaped}"%`);
        }
        const excludeIds = rows.map(r => r.memory_id);
        const excludeClause = excludeIds.length > 0
          ? ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`
          : '';
        const fuzzySessionClause = sessionId ? ' AND session_id = ?' : '';
        const fuzzyStmt = this.db.prepare(`
          SELECT * FROM memory_items
          WHERE (${orConditions}) AND status = 'active' AND state IN ('tentative', 'kept')
          ${fuzzySessionClause}
          ${excludeClause}
          ORDER BY updated_at DESC LIMIT ?
        `);
        const fuzzyArgs = sessionId
          ? [...orParams, sessionId, ...excludeIds, topK * 5]
          : [...orParams, ...excludeIds, topK * 5];
        const fuzzyRows = fuzzyStmt.all(...fuzzyArgs)
          .map(r => this._rowToMemory(r))
          .filter(r => {
            const content = (r.content || '').toLowerCase();
            const matchCount = expandedTerms.filter(t => content.includes(t.toLowerCase())).length;
            return matchCount >= minMatch;
          });
        rows = rows.concat(fuzzyRows);
      }
    }

    rows.sort((a, b) => {
      const scoreA = this._computeRelevanceScore(a, terms);
      const scoreB = this._computeRelevanceScore(b, terms);
      return scoreB - scoreA;
    });

    return rows.slice(0, topK);
  }

  _queryMemoryOrFirst(query, terms, topK, sessionId) {
    const expandedTerms = [];
    for (const term of terms) {
      if (term.length > 1 && /[\u4e00-\u9fff]/.test(term)) {
        const bigrams = [];
        for (let i = 0; i < term.length - 1; i++) {
          const bigram = term.slice(i, i + 2);
          if (/[\u4e00-\u9fff]{2}/.test(bigram)) {
            bigrams.push(bigram);
          }
        }
        if (bigrams.length > 0) {
          expandedTerms.push(...bigrams);
        } else {
          expandedTerms.push(term);
        }
      } else {
        expandedTerms.push(term);
      }
    }

    const minMatch = Math.max(1, Math.ceil(expandedTerms.length / 3));
    const orConditions = expandedTerms.map(() => "(content LIKE ? ESCAPE '!' OR aliases_json LIKE ? ESCAPE '!')").join(' OR ');
    const sessionClause = sessionId ? ' AND session_id = ?' : '';
    const orParams = [];
    for (const t of expandedTerms) {
      const escaped = escapeLikePattern(t);
      orParams.push(`%${escaped}%`, `%"${escaped}"%`);
    }
    if (sessionId) orParams.push(sessionId);
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE (${orConditions}) AND status = 'active' AND state IN ('tentative', 'kept')
      ${sessionClause}
      ORDER BY updated_at DESC LIMIT ?
    `);
    const args = sessionId
      ? [...orParams, topK * 5]
      : [...orParams, topK * 5];
    const rows = stmt.all(...args)
      .map(r => this._rowToMemory(r))
      .filter(r => {
        const content = (r.content || '').toLowerCase();
        const matchCount = expandedTerms.filter(t => content.includes(t.toLowerCase())).length;
        return matchCount >= minMatch;
      });

    rows.sort((a, b) => {
      const scoreA = this._computeRelevanceScore(a, terms);
      const scoreB = this._computeRelevanceScore(b, terms);
      return scoreB - scoreA;
    });

    return rows.slice(0, topK);
  }

  queryTurns(query, topK = 5, sessionId = null) {
    if (!query || !query.trim()) return [];
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => "content LIKE ? ESCAPE '!'").join(' AND ');
    const sessionClause = sessionId ? ' AND session_id = ?' : '';
    const params = terms.map(t => `%${escapeLikePattern(t)}%`);
    if (sessionId) params.push(sessionId);

    const rows = this.db.prepare(`
      SELECT * FROM turns
      WHERE ${conditions}
      AND NOT (role = 'system' AND content LIKE '[检索洞察]%')
      ${sessionClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, topK);
    return rows.map(r => this._rowToTurn(r));
  }

  _computeRelevanceScore(item, terms) {
    const query = terms.join(' ');
    return computeRelevanceScore(query, item, RELEVANCE_WEIGHTS.search);
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
   * 按权重列出活跃记忆
   * @param {string} weight - 权重值（STRONG|MEDIUM|WEAK）
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 记忆列表
   */
  listMemoryByWeight(weight, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_items WHERE weight = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT ?
    `);
    return stmt.all(weight, limit).map(r => this._rowToMemory(r));
  }

  /**
   * 更新记忆内容
   * @param {string} memoryId - 记忆 ID
   * @param {string} content - 新内容
   * @returns {boolean} 始终返回 true
   */
  updateMemoryContent(memoryId, content) {
    const canonicalKey = canonicalKeyForText(content.trim());
    const stmt = this.db.prepare(`
      UPDATE memory_items SET content = ?, summary = ?, canonical_key = ?, updated_at = ? WHERE id = ?
    `);
    const now = new Date().toISOString();
    const result = stmt.run(content, content, canonicalKey, now, memoryId);
    return result.changes > 0;
  }

  /**
   * 更新记忆状态（白名单：state、status、last_choice、updated_at）
   * @param {string} memoryId - 记忆 ID
   * @param {string} [state] - 新状态值
   * @param {Object} [extra] - 额外需要更新的字段
   */
  updateMemoryState(memoryId, state, extra = {}) {
    const allowed = ['state', 'status', 'last_choice'];
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
   * 评估记忆：存储 LLM 评估结果到 evaluation_json 字段
   * @param {string} memoryId - 记忆 ID
   * @param {Object} evaluation - 评估结果 { score, reasoning, recommendation }
   * @returns {boolean} 是否更新成功
   */
  evaluateMemory(memoryId, evaluation) {
    const stmt = this.db.prepare(`
      UPDATE memory_items SET evaluation_json = ?, updated_at = ? WHERE id = ?
    `);
    const result = stmt.run(JSON.stringify(evaluation || {}), new Date().toISOString(), memoryId);
    return result.changes > 0;
  }

  addQueryHash(memoryId, queryHash) {
    const row = this.db.prepare('SELECT unique_query_hashes FROM memory_items WHERE id = ?').get(memoryId);
    if (!row) return;
    let hashes = [];
    try { hashes = JSON.parse(row.unique_query_hashes || '[]'); } catch { hashes = []; }
    if (!hashes.includes(queryHash)) {
      hashes.push(queryHash);
      if (hashes.length > 20) hashes = hashes.slice(-20);
      this.db.prepare('UPDATE memory_items SET unique_query_hashes = ? WHERE id = ?')
        .run(JSON.stringify(hashes), memoryId);
    }
  }

  /**
   * 获取指定会话最近一段时间内的检索洞察数量
   * @param {string} sessionId - 会话 ID
   * @param {number} [maxAgeHours=1] - 最大时间跨度（小时）
   * @returns {number} 洞察数量
   */
  getRecentInsightCount(sessionId, maxAgeHours = 1) {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM turns WHERE session_id = ? AND role = 'system' AND content LIKE '[检索洞察]%' AND created_at > ?`
    ).get(sessionId, cutoff);
    return row?.cnt || 0;
  }

  /**
   * 硬删除记忆条目（同时清理别名记录）
   * @param {string} memoryId - 记忆 ID
   * @returns {boolean} 是否删除成功
   */
  deleteMemory(memoryId) {
    // Clean up aliases first
    this._getStmt('DELETE FROM memory_aliases WHERE memory_id = ?').run(memoryId);
    // Hard delete the memory item
    const result = this._getStmt('DELETE FROM memory_items WHERE id = ?').run(memoryId);
    return result.changes > 0;
  }

  /**
   * 数据库行转记忆对象（反序列化 JSON 字段）
   * @param {Object} row - 数据库行
   * @returns {Object} 记忆对象
   */
  _rowToMemory(row) {
    let aliases = [];
    try { aliases = row.aliases_json ? JSON.parse(row.aliases_json) : []; } catch { aliases = []; }
    let pathHints = [];
    try { pathHints = row.path_hints_json ? JSON.parse(row.path_hints_json) : []; } catch { pathHints = []; }
    let collectionHints = [];
    try { collectionHints = row.collection_hints_json ? JSON.parse(row.collection_hints_json) : []; } catch { collectionHints = []; }
    let evaluation = null;
    try { evaluation = row.evaluation_json ? JSON.parse(row.evaluation_json) : null; } catch { evaluation = null; }
    let queryHashCount = 0;
    try { queryHashCount = (JSON.parse(row.unique_query_hashes || '[]')).length; } catch {}
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
      aliases,
      path_hints: pathHints,
      collection_hints: collectionHints,
      evaluation,
      last_choice: row.last_choice || null,
      _hitCount: queryHashCount,
      // v3.3: weight-based lifecycle
      category: row.category || 'general',
      weight: row.weight || 'MEDIUM',
      weight_set_at: row.weight_set_at || null,
      expires_at: row.expires_at || null,
      // v3.3: multi-scope and actor
      scope: row.scope || 'global',
      scope_id: row.scope_id || '',
      actor_id: row.actor_id || null,
      actor_type: row.actor_type || null,
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
    if (!memoryId) {
      const stmt = this.db.prepare(`
        SELECT * FROM memory_events
        ORDER BY created_at DESC LIMIT ?
      `);
      return stmt.all(limit);
    }
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events WHERE memory_id = ?
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(memoryId, limit);
  }

  // ========== Stats ==========

  /**
   * 获取存储统计摘要
   * @returns {{ total: number, active: number, tentative: number, kept: number, sessions: number, by_weight: {STRONG: number, MEDIUM: number, WEAK: number}, by_category: Object }}
   */
  statsSummary() {
    const total = this._getStmt("SELECT COUNT(*) as c FROM memory_items").get().c;
    const active = this._getStmt("SELECT COUNT(*) as c FROM memory_items WHERE status = 'active' AND state IN ('tentative', 'kept')").get().c;
    const tentative = this._getStmt("SELECT COUNT(*) as c FROM memory_items WHERE state = 'tentative' AND status = 'active'").get().c;
    const kept = this._getStmt("SELECT COUNT(*) as c FROM memory_items WHERE state = 'kept' AND status = 'active'").get().c;
    const sessions = this._getStmt("SELECT COUNT(*) as c FROM sessions").get().c;
    
    // v3.3: weight-based stats
    const strong = this._getStmt("SELECT COUNT(*) as c FROM memory_items WHERE weight = 'STRONG' AND status = 'active'").get().c;
    const medium = this._getStmt("SELECT COUNT(*) as c FROM memory_items WHERE weight = 'MEDIUM' AND status = 'active'").get().c;
    const weak = this._getStmt("SELECT COUNT(*) as c FROM memory_items WHERE weight = 'WEAK' AND status = 'active'").get().c;
    
    // v3.3: category stats
    const categoryRows = this._getStmt("SELECT category, COUNT(*) as c FROM memory_items WHERE status = 'active' GROUP BY category").all();
    const by_category = {};
    for (const row of categoryRows) {
      by_category[row.category] = row.c;
    }
    
    return { 
      total, active, tentative, kept, sessions,
      by_weight: { STRONG: strong, MEDIUM: medium, WEAK: weak },
      by_category
    };
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
    return this._getStmt(`
      SELECT * FROM memory_items
      WHERE status = 'active' AND state IN ('tentative', 'kept')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit).map(r => this._rowToMemory(r));
  }

  /**
   * 替代旧记忆：删除旧记忆、插入新记忆、记录替代事件
   * @param {string} oldMemoryId - 旧记忆 ID
   * @param {Object} newMemory - 新记忆对象
   * @returns {{ oldMemoryId: string, newMemory: Object }} 替代结果
   */
  supersedeMemory(oldMemoryId, newMemory) {
    const now = newMemory.created_at || new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.deleteMemory(oldMemoryId);
      const saved = this.saveMemory(newMemory);
      this.addEvent({
        memory_id: oldMemoryId,
        event_type: 'memory_superseded',
        created_at: now,
        event_data: { new_memory_id: saved.memory_id },
      });
      return { oldMemoryId, newMemory: saved };
    });

    return txn();
  }

  // ========== Periodic cleanup ==========

  /**
   * 清理超过指定天数的旧轮次
   * @param {number} maxAgeDays - 最大保留天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupOldTurns(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this._getStmt(`DELETE FROM turns WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  /**
   * 清理超过指定天数的旧会话（排除活跃会话和有轮次关联的会话）
   * @param {number} maxAgeDays - 最大保留天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupOldSessions(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this._getStmt(`
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
    const result = this._getStmt(`DELETE FROM memory_events WHERE created_at < ?`).run(cutoff);
    return { deleted: result.changes };
  }

  /**
   * 清理超过指定天数仍未确认的暂定记忆（@deprecated 使用 cleanupByWeight 代替）
   * @param {number} ttlDays - 暂定记忆存活天数
   * @returns {{ deleted: number }} 删除数量
   */
  cleanupExpiredTentative(ttlDays) {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const txn = this.db.transaction(() => {
      const result = this._getStmt(`
        DELETE FROM memory_items
        WHERE state = 'tentative' AND status = 'active' AND created_at < ?
      `).run(cutoff);
      const aliasResult = this._getStmt(`
        DELETE FROM memory_aliases
        WHERE memory_id NOT IN (SELECT id FROM memory_items)
      `).run();
      return { deleted: result.changes, orphan_aliases_deleted: aliasResult.changes };
    });
    return txn();
  }

  /**
   * 基于权重的衰减GC：降级或删除过期记忆
   * @returns {{ downgraded: number, deleted: number, expired: number }}
   */
  cleanupByWeight() {
    const now = Date.now();
    const nowISO = new Date(now).toISOString();
    
    // 1. 处理 expires_at 到期的记忆（直接硬删除）
    const expiredResult = this._getStmt(`
      DELETE FROM memory_items 
      WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'active'
    `).run(nowISO);
    
    // 2. 处理 weight 衰减
    // STRONG → MEDIUM (14天)
    const strongCutoff = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const strongDowngrade = this._getStmt(`
      UPDATE memory_items SET weight = 'MEDIUM', weight_set_at = ?
      WHERE weight = 'STRONG' AND status = 'active' 
      AND weight_set_at < ?
      AND category NOT IN ('instruction')
      AND NOT (category = 'preference' AND weight = 'STRONG')
    `).run(nowISO, strongCutoff);
    
    // MEDIUM → WEAK (7天)
    const mediumCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const mediumDowngrade = this._getStmt(`
      UPDATE memory_items SET weight = 'WEAK', weight_set_at = ?
      WHERE weight = 'MEDIUM' AND status = 'active' 
      AND weight_set_at < ?
      AND category NOT IN ('instruction')
    `).run(nowISO, mediumCutoff);
    
    // WEAK → 删除 (3天)
    const weakCutoff = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const weakDelete = this._getStmt(`
      DELETE FROM memory_items
      WHERE weight = 'WEAK' AND status = 'active'
      AND weight_set_at < ?
    `).run(weakCutoff);
    
    // 3. 清理孤立别名
    this._getStmt(`
      DELETE FROM memory_aliases WHERE memory_id NOT IN (SELECT id FROM memory_items)
    `).run();
    
    return {
      downgraded: strongDowngrade.changes + mediumDowngrade.changes,
      deleted: weakDelete.changes,
      expired: expiredResult.changes,
    };
  }

  // ========== Entities (v3.3) ==========

  /**
   * 创建或更新实体
   * @param {Object} entity - 实体对象
   * @param {string} entity.id - 实体 ID
   * @param {string} entity.name - 实体名称
   * @param {string} [entity.type] - 实体类型 (person|tech|project|concept|generic)
   * @param {string[]} [entity.aliases] - 别名列表
   * @returns {Object} 实体对象
   */
  saveEntity(entity) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entities (id, name, type, aliases_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entity.id,
      entity.name,
      entity.type || 'generic',
      JSON.stringify(entity.aliases || []),
      entity.created_at || now,
      now
    );
    return entity;
  }

  /**
   * 获取实体
   * @param {string} entityId - 实体 ID
   * @returns {Object|null} 实体对象
   */
  getEntity(entityId) {
    const row = this._getStmt('SELECT * FROM entities WHERE id = ?').get(entityId);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases_json || '[]'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 按名称查找实体
   * @param {string} name - 实体名称
   * @returns {Object|null} 实体对象
   */
  getEntityByName(name) {
    const row = this._getStmt('SELECT * FROM entities WHERE name = ?').get(name);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases_json || '[]'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 列出所有实体
   * @param {number} [limit=100] - 返回数量上限
   * @returns {Array<Object>} 实体列表
   */
  listEntities(limit = 100) {
    return this._getStmt('SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?').all(limit).map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases_json || '[]'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /**
   * 删除实体
   * @param {string} entityId - 实体 ID
   * @returns {boolean} 是否删除成功
   */
  deleteEntity(entityId) {
    this._getStmt('DELETE FROM entity_facts WHERE entity_id = ?').run(entityId);
    const result = this._getStmt('DELETE FROM entities WHERE id = ?').run(entityId);
    return result.changes > 0;
  }

  /**
   * 关联实体与记忆
   * @param {string} entityId - 实体 ID
   * @param {string} memoryId - 记忆 ID
   * @param {string} [observation] - 观察内容
   * @param {number} [confidence] - 置信度
   */
  linkEntityMemory(entityId, memoryId, observation = null, confidence = 1.0) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entity_facts (entity_id, memory_id, observation, confidence)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(entityId, memoryId, observation, confidence);
  }

  /**
   * 获取实体关联的记忆
   * @param {string} entityId - 实体 ID
   * @returns {Array<Object>} 关联的记忆列表
   */
  getEntityMemories(entityId) {
    return this._getStmt(`
      SELECT m.*, ef.observation, ef.confidence
      FROM memory_items m
      JOIN entity_facts ef ON m.id = ef.memory_id
      WHERE ef.entity_id = ? AND m.status = 'active'
      ORDER BY m.updated_at DESC
    `).all(entityId).map(r => this._rowToMemory(r));
  }

  /**
   * 获取记忆关联的实体
   * @param {string} memoryId - 记忆 ID
   * @returns {Array<Object>} 关联的实体列表
   */
  getMemoryEntities(memoryId) {
    return this._getStmt(`
      SELECT e.*, ef.observation, ef.confidence
      FROM entities e
      JOIN entity_facts ef ON e.id = ef.entity_id
      WHERE ef.memory_id = ?
      ORDER BY e.name
    `).all(memoryId).map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases_json || '[]'),
      observation: row.observation,
      confidence: row.confidence,
    }));
  }

  /**
   * 搜索观察级内容
   * @param {string} query - 查询文本
   * @param {number} [topK=5] - 返回数量上限
   * @returns {Array<Object>} 匹配的观察列表
   */
  searchObservations(query, topK = 5) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => "ef.observation LIKE ? ESCAPE '!'").join(' OR ');
    const params = terms.map(t => `%${t}%`);

    return this._getStmt(`
      SELECT e.name as entity_name, e.type as entity_type, 
             ef.observation, ef.confidence, ef.memory_id,
             m.content as memory_content
      FROM entity_facts ef
      JOIN entities e ON e.id = ef.entity_id
      JOIN memory_items m ON m.id = ef.memory_id
      WHERE (${conditions}) AND m.status = 'active'
      ORDER BY ef.confidence DESC
      LIMIT ?
    `).all(...params, topK).map(row => ({
      entity: row.entity_name,
      entity_type: row.entity_type,
      observation: row.observation,
      confidence: row.confidence,
      memory_id: row.memory_id,
      memory_content: row.memory_content,
    }));
  }

  /**
   * 获取关联记忆（1跳）
   * @param {string} memoryId - 记忆 ID
   * @returns {Array<Object>} 关联的记忆列表
   */
  getRelatedMemories(memoryId) {
    // 找出该记忆关联的所有实体
    const entities = this.getMemoryEntities(memoryId);
    if (entities.length === 0) return [];

    // 找出这些实体关联的其他记忆
    const entityIds = entities.map(e => e.id);
    const placeholders = entityIds.map(() => '?').join(',');

    return this._getStmt(`
      SELECT DISTINCT m.*, e.name as related_entity
      FROM memory_items m
      JOIN entity_facts ef ON m.id = ef.memory_id
      JOIN entities e ON e.id = ef.entity_id
      WHERE ef.entity_id IN (${placeholders}) 
        AND m.id != ? 
        AND m.status = 'active'
      ORDER BY m.updated_at DESC
      LIMIT 10
    `).all(...entityIds, memoryId).map(r => this._rowToMemory(r));
  }

  // ========== State Migration ==========

  /** 迁移旧状态到简化的 tentative/kept 模型，清理废弃和孤立数据 */
  _migrateStates() {
    try {
      this.db.prepare("UPDATE memory_items SET state = 'kept' WHERE state IN ('local_only', 'manual_only') AND status = 'active'").run();
      this.db.prepare("UPDATE memory_items SET state = 'tentative' WHERE state IN ('wiki_candidate', 'candidate_on_reuse') AND status = 'active'").run();
      this.db.prepare("DELETE FROM memory_items WHERE state = 'discarded' OR status IN ('archived', 'discarded')").run();
      this.db.prepare("DELETE FROM memory_aliases WHERE memory_id NOT IN (SELECT id FROM memory_items)").run();
    } catch (err) {
      logger.error(`[SqliteStore] State migration failed (non-fatal, continuing): ${err.message}`);
    }
  }
}

export default SqliteStore;
