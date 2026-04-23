import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSearchPlan, rerankResults, SearchPlan } from '../src/retrieval/query-planner.js';

describe('Query Planner', () => {
  it('should build search plan for exact symbol query', () => {
    const plan = buildSearchPlan('HelloWorld');
    assert.ok(plan.symbols.includes('HelloWorld'));
    assert.ok(plan.queryIntent === 'exactsymbol' || plan.queryIntent === 'symbollookup');
  });

  it('should build search plan for path query', () => {
    const plan = buildSearchPlan('src/config.js');
    assert.strictEqual(plan.queryIntent, 'path');
  });

  it('should build search plan for error query', () => {
    const plan = buildSearchPlan('报错了');
    assert.strictEqual(plan.queryIntent, 'error');
  });

  it('should build search plan with memory context', () => {
    const memoryContext = {
      matched_sessions: [],
      matched_facts: [{ memory_id: 'f1', score: 0.9, aliases: ['UserService'], path_hints: [], collection_hints: [] }],
      aliases: ['UserService'],
      path_hints: [],
      collection_hints: [],
      confidenceApplied: true,
    };
    const plan = buildSearchPlan('怎么使用 UserService', null, 5, memoryContext);
    assert.strictEqual(plan.memoryRoute, 'fact-assisted');
    assert.ok(plan.evidenceGroups.length > 0);
  });

  it('should detect abstain-preferred when no memory evidence', () => {
    const memoryContext = {
      matched_sessions: [],
      matched_facts: [],
      memory_intent: true,
    };
    const plan = buildSearchPlan('上次说的', null, 5, memoryContext);
    assert.strictEqual(plan.memoryRoute, 'abstain-preferred');
    assert.strictEqual(plan.abstainPreferred, true);
  });

  it('should rerank results', () => {
    const plan = buildSearchPlan('config');
    const results = [
      { source: 'a.md', title: 'Config', content: 'configuration', score: 0.5, collection: 'static_kb' },
      { source: 'b.md', title: 'Config', content: 'configuration', score: 0.5, collection: 'static_kb' },
    ];
    const reranked = rerankResults(plan, results, 5);
    assert.ok(Array.isArray(reranked));
  });
});
