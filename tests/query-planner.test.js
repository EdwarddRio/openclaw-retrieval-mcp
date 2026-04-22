import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectIntent, generateVariants, routeCollections, buildSearchPlan } from '../src/retrieval/query-planner.js';

describe('Query Planner', () => {
  it('should detect exact symbol intent', () => {
    assert.strictEqual(detectIntent('helloWorld'), 'exact_symbol');
    assert.strictEqual(detectIntent('foo_bar'), 'exact_symbol');
  });

  it('should detect path intent', () => {
    assert.strictEqual(detectIntent('where is the file'), 'path');
    assert.strictEqual(detectIntent('文件在哪里'), 'path');
  });

  it('should detect error intent', () => {
    assert.strictEqual(detectIntent('error occurred'), 'error');
    assert.strictEqual(detectIntent('报错了'), 'error');
  });

  it('should generate variants', () => {
    const variants = generateVariants('hello world', 'general');
    assert.ok(variants.length >= 1);
    assert.strictEqual(variants[0], 'hello world');
  });

  it('should route to collections', () => {
    const collections = routeCollections('how to implement', 'general');
    assert.ok(collections.includes('code'));
  });

  it('should build search plan', () => {
    const plan = buildSearchPlan('hello world');
    assert.strictEqual(plan.originalQuery, 'hello world');
    assert.ok(plan.intent);
    assert.ok(Array.isArray(plan.variants));
    assert.ok(Array.isArray(plan.collections));
  });
});
