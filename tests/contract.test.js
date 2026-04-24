import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSearchCall,
  buildMemoryQueryCall,
} from '../src/api/contract.js';

describe('API Contracts', () => {
  it('should build search call', () => {
    const call = buildSearchCall({ query: 'test', top_k: 10, doc_type: 'rule' });
    assert.strictEqual(call.query, 'test');
    assert.strictEqual(call.top_k, 10);
    assert.strictEqual(call.doc_type, 'rule');
  });

  it('should build memory query call', () => {
    const call = buildMemoryQueryCall({ query: 'test', top_k: 5 });
    assert.strictEqual(call.query, 'test');
    assert.strictEqual(call.top_k, 5);
  });
});
