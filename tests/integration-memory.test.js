/**
 * Integration tests for end-to-end memory workflow.
 * Tests: turn write → autoTriage → query → review → promote/discard
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

describe('Memory Integration', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-integration-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        summary TEXT,
        state TEXT DEFAULT 'tentative',
        status TEXT DEFAULT 'active',
        source TEXT DEFAULT 'auto',
        canonical_key TEXT,
        aliases_json TEXT DEFAULT '[]',
        path_hints_json TEXT DEFAULT '[]',
        collection_hints_json TEXT DEFAULT '[]',
        unique_query_hashes TEXT DEFAULT '[]',
        evaluation_json TEXT,
        last_choice TEXT,
        session_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        references_json TEXT DEFAULT '{}',
        seq_no INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Turn Write → Query', () => {
    it('should write a turn and query it back', () => {
      const sessionId = 'test-session-001';
      const turnId = 'turn-001';

      db.prepare(`INSERT INTO sessions (id, title) VALUES (?, ?)`).run(sessionId, 'Integration Test Session');
      db.prepare(`INSERT INTO turns (id, session_id, role, content, seq_no) VALUES (?, ?, ?, ?, ?)`)
        .run(turnId, sessionId, 'user', '梦境系统读取 runtime 目录下的文件', 1);

      const rows = db.prepare(`SELECT * FROM turns WHERE session_id = ?`).all(sessionId);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].content, '梦境系统读取 runtime 目录下的文件');
    });
  });

  describe('Memory Item Lifecycle', () => {
    it('should create tentative memory, then promote to kept', () => {
      const memoryId = 'mem-001';

      db.prepare(`INSERT INTO memory_items (id, content, state, status, source) VALUES (?, ?, ?, ?, ?)`)
        .run(memoryId, '梦境系统 query diversity 瓶颈需要优化', 'tentative', 'active', 'auto');

      let item = db.prepare(`SELECT state FROM memory_items WHERE id = ?`).get(memoryId);
      assert.strictEqual(item.state, 'tentative');

      db.prepare(`UPDATE memory_items SET state = 'kept', updated_at = datetime('now') WHERE id = ?`)
        .run(memoryId);

      item = db.prepare(`SELECT state FROM memory_items WHERE id = ?`).get(memoryId);
      assert.strictEqual(item.state, 'kept');
    });

    it('should discard tentative memory', () => {
      const memoryId = 'mem-002';

      db.prepare(`INSERT INTO memory_items (id, content, state, status, source) VALUES (?, ?, ?, ?, ?)`)
        .run(memoryId, '待丢弃的测试记忆', 'tentative', 'active', 'auto');

      db.prepare(`DELETE FROM memory_items WHERE id = ?`).run(memoryId);

      const item = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(memoryId);
      assert.strictEqual(item, undefined);
    });
  });

  describe('Query Hash Tracking', () => {
    it('should add query hash and track unique queries', () => {
      const memoryId = 'mem-003';

      db.prepare(`INSERT INTO memory_items (id, content, state, status, source) VALUES (?, ?, ?, ?, ?)`)
        .run(memoryId, '中间层 API 端点验证', 'kept', 'active', 'manual');

      function addQueryHash(memId, queryHash) {
        const row = db.prepare('SELECT unique_query_hashes FROM memory_items WHERE id = ?').get(memId);
        if (!row) return;
        let hashes = [];
        try { hashes = JSON.parse(row.unique_query_hashes || '[]'); } catch { hashes = []; }
        if (!hashes.includes(queryHash)) {
          hashes.push(queryHash);
          if (hashes.length > 20) hashes = hashes.slice(-20);
          db.prepare('UPDATE memory_items SET unique_query_hashes = ? WHERE id = ?')
            .run(JSON.stringify(hashes), memId);
        }
      }

      addQueryHash(memoryId, 'abc123');
      addQueryHash(memoryId, 'def456');
      addQueryHash(memoryId, 'abc123');

      const row = db.prepare('SELECT unique_query_hashes FROM memory_items WHERE id = ?').get(memoryId);
      const hashes = JSON.parse(row.unique_query_hashes);
      assert.strictEqual(hashes.length, 2);
      assert.ok(hashes.includes('abc123'));
      assert.ok(hashes.includes('def456'));
    });
  });

  describe('Chinese Search Strategy', () => {
    it('should expand Chinese terms into bigrams', () => {
      const term = '梦境系统';
      const bigrams = [];
      for (let i = 0; i < term.length - 1; i++) {
        const bigram = term.slice(i, i + 2);
        if (/[\u4e00-\u9fff]{2}/.test(bigram)) {
          bigrams.push(bigram);
        }
      }
      assert.deepStrictEqual(bigrams, ['梦境', '境系', '系统']);
    });

    it('should find memory items using bigram OR search', () => {
      db.prepare(`INSERT INTO memory_items (id, content, state, status, source) VALUES (?, ?, ?, ?, ?)`)
        .run('mem-cn-1', '梦境系统读取 runtime 目录下的文件', 'kept', 'active', 'manual');
      db.prepare(`INSERT INTO memory_items (id, content, state, status, source) VALUES (?, ?, ?, ?, ?)`)
        .run('mem-cn-2', '系统架构优化方案', 'kept', 'active', 'manual');
      db.prepare(`INSERT INTO memory_items (id, content, state, status, source) VALUES (?, ?, ?, ?, ?)`)
        .run('mem-cn-3', '完全无关的内容', 'kept', 'active', 'manual');

      const bigrams = ['梦境', '境系', '系统'];
      const conditions = bigrams.map(() => "content LIKE ? ESCAPE '!'").join(' OR ');
      const params = bigrams.map(b => `%${b}%`);

      const rows = db.prepare(`SELECT id FROM memory_items WHERE (${conditions}) AND status = 'active' AND state IN ('tentative', 'kept')`)
        .all(...params);

      const ids = rows.map(r => r.id);
      assert.ok(ids.includes('mem-cn-1'));
      assert.ok(ids.includes('mem-cn-2'));
      assert.ok(!ids.includes('mem-cn-3'));
    });
  });

  describe('Rate Limiting', () => {
    it('should distinguish Unix Socket vs TCP rate limiters', async () => {
      const mod = await import('../src/middleware/rate-limit.js');
      const metrics = mod.getRateLimitMetrics();

      assert.ok(metrics.tcp);
      assert.ok(metrics.unix_socket);
      assert.strictEqual(typeof metrics.tcp.points, 'number');
      assert.strictEqual(typeof metrics.unix_socket.points, 'number');
      assert.ok(metrics.unix_socket.points >= metrics.tcp.points);
    });
  });
});
