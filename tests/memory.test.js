import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { LocalMemory } from '../src/memory/local-memory.js';
import { SqliteStore } from '../src/memory/sqlite-store.js';
import { MemoryFact } from '../src/memory/models.js';

const TEST_DB_PATH = path.join(process.cwd(), 'tests', 'test-localmem.db');

describe('LocalMemory', () => {
  let memory;

  beforeEach(() => {
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    memory = new LocalMemory(TEST_DB_PATH);
  });

  it('should create a session', () => {
    const result = memory.startSession({ projectId: 'test', title: 'Test Session' });
    assert.ok(result.session_id);
    assert.ok(result.created_at);
  });

  it('should append a turn', () => {
    const session = memory.startSession({ projectId: 'test' });
    const result = memory.appendTurn({
      sessionId: session.session_id,
      role: 'user',
      content: 'Hello',
    });
    assert.ok(result.turn_id);
  });

  it('should query memory', () => {
    const result = memory.queryMemory('test', 3);
    assert.ok(Array.isArray(result.hits));
    assert.ok(Array.isArray(result.tentative_items));
    assert.ok(Array.isArray(result.review_queue));
  });

  it('should save and get memory', () => {
    const fact = new MemoryFact({
      memory_id: 'test-1',
      content: 'Test memory content',
      status: 'tentative',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    memory.localMemory.store.saveMemory(fact);
    const retrieved = memory.getMemory('test-1');
    assert.strictEqual(retrieved.content, 'Test memory content');
  });
});
