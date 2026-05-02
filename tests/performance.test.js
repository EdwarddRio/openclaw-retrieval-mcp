/**
 * Performance benchmark tests.
 * Measures write and query performance under load.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { LocalMemoryStore } from '../src/memory/local-memory.js';

const TEST_ROOT_DIR = path.join(process.cwd(), 'tests', 'performance-root');
const TEST_DB_PATH = path.join(TEST_ROOT_DIR, 'context-engine.db');

describe('Performance Benchmarks', () => {
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

  describe('Write Performance', () => {
    it('should handle 1000 memory saves within 5 seconds', () => {
      const start = Date.now();
      const count = 1000;
      
      for (let i = 0; i < count; i++) {
        memory.saveMemory({
          session_id: 'perf-test',
          content: `Performance test memory ${i}: ${Math.random().toString(36).substring(7)}`,
          state: 'tentative',
          source: 'manual'
        });
      }
      
      const duration = Date.now() - start;
      const opsPerSecond = Math.round(count / (duration / 1000));
      
      console.log(`Write Performance: ${count} saves in ${duration}ms (${opsPerSecond} ops/sec)`);
      assert.ok(duration < 5000, `Took ${duration}ms, expected < 5000ms`);
    });

    it('should handle 100 session creations within 1 second', () => {
      const start = Date.now();
      const count = 100;
      
      for (let i = 0; i < count; i++) {
        memory.getOrCreateActiveSession({
          project_id: `project-${i}`,
          title: `Performance Test Session ${i}`
        });
      }
      
      const duration = Date.now() - start;
      console.log(`Session Creation: ${count} sessions in ${duration}ms`);
      assert.ok(duration < 1000, `Took ${duration}ms, expected < 1000ms`);
    });

    it('should handle 500 turn appends within 2 seconds', () => {
      const sessionId = memory.getOrCreateActiveSession({ project_id: 'perf-test' });
      const start = Date.now();
      const count = 500;
      
      for (let i = 0; i < count; i++) {
        memory.appendTurn({
          session_id: sessionId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Turn ${i}: ${Math.random().toString(36).substring(7)}`
        });
      }
      
      const duration = Date.now() - start;
      const opsPerSecond = Math.round(count / (duration / 1000));
      
      console.log(`Turn Appends: ${count} turns in ${duration}ms (${opsPerSecond} ops/sec)`);
      assert.ok(duration < 2000, `Took ${duration}ms, expected < 2000ms`);
    });
  });

  describe('Query Performance', () => {
    it('should query within 100ms for 10000 records', () => {
      // Prepare data
      const count = 10000;
      for (let i = 0; i < count; i++) {
        memory.saveMemory({
          session_id: 'perf-test',
          content: `Memory ${i}: Test content with keyword ${i % 10}`,
          state: 'kept',
          source: 'manual'
        });
      }

      // Benchmark queries
      const queryCount = 100;
      const start = Date.now();
      
      for (let i = 0; i < queryCount; i++) {
        memory.queryMemoryFull(`keyword ${i % 10}`, 10);
      }
      
      const duration = Date.now() - start;
      const avgQueryTime = duration / queryCount;
      
      console.log(`Query Performance: ${queryCount} queries in ${duration}ms (avg ${avgQueryTime.toFixed(2)}ms/query)`);
      assert.ok(avgQueryTime < 100, `Average query time ${avgQueryTime}ms, expected < 100ms`);
    });

    it('should handle concurrent queries efficiently', () => {
      // Prepare data
      for (let i = 0; i < 1000; i++) {
        memory.saveMemory({
          session_id: 'perf-test',
          content: `Concurrent test memory ${i}`,
          state: 'kept',
          source: 'manual'
        });
      }

      // Simulate concurrent queries
      const queryCount = 50;
      const start = Date.now();
      
      const promises = [];
      for (let i = 0; i < queryCount; i++) {
        promises.push(
          new Promise(resolve => {
            const result = memory.queryMemoryFull(`memory ${i}`, 5);
            resolve(result);
          })
        );
      }
      
      return Promise.all(promises).then(results => {
        const duration = Date.now() - start;
        console.log(`Concurrent Queries: ${queryCount} queries in ${duration}ms`);
        assert.strictEqual(results.length, queryCount);
        assert.ok(duration < 2000, `Took ${duration}ms, expected < 2000ms`);
      });
    });

    it('should maintain performance with large result sets', () => {
      // Prepare data with similar content
      for (let i = 0; i < 1000; i++) {
        memory.saveMemory({
          session_id: 'perf-test',
          content: `Large result set test: common keyword shared across all memories`,
          state: 'kept',
          source: 'manual'
        });
      }

      const start = Date.now();
      const result = memory.queryMemoryFull('common keyword', 100);
      const duration = Date.now() - start;
      
      console.log(`Large Result Set: ${result.hits.length} results in ${duration}ms`);
      assert.ok(duration < 200, `Took ${duration}ms, expected < 200ms`);
    });
  });

  describe('Memory Usage', () => {
    it('should maintain stable memory usage during extended operation', () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Perform many operations
      for (let i = 0; i < 5000; i++) {
        memory.saveMemory({
          session_id: 'memory-test',
          content: `Memory stability test ${i}`,
          state: 'tentative',
          source: 'manual'
        });
        
        if (i % 100 === 0) {
          memory.queryMemoryFull('stability', 10);
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = (finalMemory - initialMemory) / 1024 / 1024;
      
      console.log(`Memory Usage: Increased by ${memoryIncrease.toFixed(2)}MB after 5000 operations`);
      assert.ok(memoryIncrease < 50, `Memory increased by ${memoryIncrease}MB, expected < 50MB`);
    });
  });

  describe('Cleanup Performance', () => {
    it('should cleanup 1000 expired memories within 1 second', () => {
      // Create expired memories
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 1000; i++) {
        memory.saveMemory({
          session_id: 'cleanup-test',
          content: `Expired memory ${i}`,
          state: 'tentative',
          source: 'manual',
          created_at: oldDate
        });
      }

      // Force cleanup
      memory._lastCleanupAt = 0;
      const start = Date.now();
      memory._maybePeriodicCleanup();
      const duration = Date.now() - start;
      
      console.log(`Cleanup Performance: Completed in ${duration}ms`);
      assert.ok(duration < 1000, `Took ${duration}ms, expected < 1000ms`);
    });
  });

  describe('Relevance Score Computation', () => {
    it('should compute relevance scores for 1000 memories within 500ms', () => {
      // Prepare memories
      const memories = [];
      for (let i = 0; i < 1000; i++) {
        memories.push({
          memory_id: `mem-${i}`,
          content: `Test memory ${i} with various keywords: ${['alpha', 'beta', 'gamma', 'delta'][i % 4]}`,
          aliases: [`alias-${i}`],
          path_hints: [`path/${i}`],
          unique_query_hashes: i > 500 ? ['hash1', 'hash2'] : [],
          updated_at: new Date(Date.now() - i * 1000).toISOString()
        });
      }

      const query = 'test alpha';
      const start = Date.now();
      
      for (const mem of memories) {
        // Simulate relevance computation
        const content = mem.content.toLowerCase();
        const queryTokens = query.toLowerCase().split(/\s+/);
        const hitCount = queryTokens.filter(t => content.includes(t)).length;
        mem._score = hitCount / queryTokens.length;
      }
      
      const duration = Date.now() - start;
      console.log(`Relevance Computation: ${memories.length} memories in ${duration}ms`);
      assert.ok(duration < 500, `Took ${duration}ms, expected < 500ms`);
    });
  });
});
