import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildMemoryQueryCall,
  MEMORY_ENDPOINTS,
} from '../src/api/contract.js';

describe('API Contracts', () => {
  it('should build memory query call', () => {
    const call = buildMemoryQueryCall({ query: 'test', top_k: 5 });
    assert.strictEqual(call.query, 'test');
    assert.strictEqual(call.top_k, 5);
  });

  it('should have correct memory endpoints', () => {
    assert.ok(MEMORY_ENDPOINTS.QUERY);
    assert.ok(MEMORY_ENDPOINTS.QUERY_CONTEXT);
    assert.ok(MEMORY_ENDPOINTS.TURN);
    assert.ok(MEMORY_ENDPOINTS.SAVE);
    assert.ok(MEMORY_ENDPOINTS.REVIEWS);
    assert.ok(MEMORY_ENDPOINTS.AUTO_TRIAGE);
    assert.ok(MEMORY_ENDPOINTS.GOVERNANCE_PLAN);
  });
});
