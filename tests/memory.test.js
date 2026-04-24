import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { LocalMemoryStore } from '../src/memory/local-memory.js';
import { MemoryFact } from '../src/memory/models.js';

const TEST_DB_PATH = path.join(process.cwd(), 'tests', 'test-localmem.db');

describe('LocalMemory', () => {
  let memory;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    memory = new LocalMemoryStore({ rootDir: path.dirname(TEST_DB_PATH) });
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
    assert.ok(Array.isArray(result.tentative_items));
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
});
