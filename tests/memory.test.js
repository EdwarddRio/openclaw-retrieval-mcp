import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { LocalMemoryStore } from '../src/memory/local-memory.js';
import { MemoryFact } from '../src/memory/models.js';

const TEST_ROOT_DIR = path.join(process.cwd(), 'tests', 'localmem-root');
const TEST_DB_PATH = path.join(TEST_ROOT_DIR, 'context-engine.db');

describe('LocalMemory', () => {
  let memory;

  beforeEach(() => {
    if (fs.existsSync(TEST_ROOT_DIR)) {
      fs.rmSync(TEST_ROOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_ROOT_DIR, { recursive: true });
    memory = new LocalMemoryStore({ rootDir: TEST_ROOT_DIR });
  });

  afterEach(() => {
    if (memory) {
      memory.close();
      memory = null;
    }
    if (fs.existsSync(TEST_ROOT_DIR)) {
      fs.rmSync(TEST_ROOT_DIR, { recursive: true, force: true });
    }
  });

  it('should create a session', () => {
    const result = memory.getOrCreateActiveSession({ project_id: 'test', title: 'Test Session' });
    assert.ok(result);
  });

  it('should append a turn', () => {
    const sessionId = memory.getOrCreateActiveSession({ project_id: 'test' });
    const result = memory.appendTurn({
      session_id: sessionId,
      role: 'user',
      content: 'Hello',
    });
    assert.ok(result);
  });

  it('should query memory', () => {
    const result = memory.queryMemoryFull('test', 3);
    assert.ok(Array.isArray(result.hits));
    assert.ok(Array.isArray(result.weak_items));
  });

  it('should save and get memory', () => {
    const fact = {
      session_id: 'test-session',
      content: 'Test memory content',
      state: 'tentative',
      source: 'manual',
    };

    const saved = memory.saveMemory(fact);
    const retrieved = memory.getMemory(saved.memory_id);
    assert.strictEqual(retrieved.content, 'Test memory content');
  });

  it('should filter memory query by session', () => {
    memory.saveMemory({
      session_id: 'session-a',
      content: 'Alpha scoped memory fact',
      state: 'kept',
      source: 'manual',
    });
    memory.saveMemory({
      session_id: 'session-b',
      content: 'Alpha other memory fact',
      state: 'kept',
      source: 'manual',
    });

    const result = memory.queryMemoryFull('Alpha', 10, 'session-a');
    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0].session_id, 'session-a');
  });

  it('should query context globally when session is omitted', () => {
    memory.saveMemory({
      session_id: 'session-a',
      content: 'Global default lookup fact',
      state: 'kept',
      source: 'manual',
    });
    memory.getOrCreateActiveSession({ project_id: 'default', session_id: 'session-b', title: 'Other Active' });

    const result = memory.queryMemoryContext('Global default lookup', 5);
    assert.ok(result.hits.length >= 1);
    assert.ok(result.hits.some(hit => hit.session_id === 'session-a'));
    assert.strictEqual(result.summary.session_filter_applied, false);
  });

  it('should return matched turns for query context', () => {
    const sessionId = memory.getOrCreateActiveSession({ project_id: 'test', title: 'Turn Search' });
    memory.appendTurn({
      session_id: sessionId,
      role: 'user',
      content: 'Need a context engine diagnostic note',
    });

    const result = memory.queryMemoryContext('context engine', 3, sessionId);
    assert.ok(Array.isArray(result.matched_turns));
    assert.ok(result.matched_turns.length >= 1);
    assert.ok(result.matched_turns.some(turn => turn.role === 'user'));
    assert.strictEqual(result.matched_sessions.length, 1);
  });

  it('should import transcript turns from jsonl', () => {
    const transcriptPath = path.join(process.cwd(), 'tests', 'tmp-transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'Remember this transcript preference' }),
      JSON.stringify({ role: 'assistant', content: 'Transcript imported response' }),
    ].join('\n'), 'utf-8');

    const result = memory.importTranscriptSession({
      transcriptPath,
      projectId: 'test',
      sessionId: 'import-test-session',
    });

    assert.strictEqual(result.status, 'imported');
    assert.strictEqual(result.imported_turn_count, 2);
    const context = memory.queryMemoryContext('transcript preference', 5, 'import-test-session');
    assert.ok(context.matched_turns.length >= 1);
    fs.unlinkSync(transcriptPath);
  });

  it('should remove orphan aliases when expired tentative memories are cleaned up', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const saved = memory.saveMemory({
      session_id: 'session-a',
      content: 'Expired tentative alias cleanup fact',
      aliases: ['orphan-alias-check'],
      state: 'tentative',
      source: 'manual',
      created_at: oldDate,
    });
    const before = memory._store.db.prepare('SELECT COUNT(*) AS count FROM memory_aliases WHERE memory_id = ?').get(saved.memory_id);
    assert.strictEqual(before.count, 1);

    const cleanup = memory._store.cleanupExpiredTentative(7);
    const after = memory._store.db.prepare('SELECT COUNT(*) AS count FROM memory_aliases WHERE memory_id = ?').get(saved.memory_id);
    assert.strictEqual(cleanup.deleted, 1);
    assert.strictEqual(cleanup.orphan_aliases_deleted, 1);
    assert.strictEqual(after.count, 0);
  });
});
