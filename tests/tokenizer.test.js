import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize, hasChinese } from '../src/retrieval/tokenizer.js';

describe('tokenizer', () => {
  it('should tokenize English text', () => {
    const result = tokenize('Hello world, this is a test.');
    assert.ok(result.length > 0);
    assert.ok(result.includes('hello') || result.includes('hell'));
  });

  it('should tokenize Chinese text', () => {
    const result = tokenize('这是一个中文测试');
    assert.ok(result.length > 0);
    assert.ok(hasChinese('这是一个中文测试'));
  });

  it('should remove stopwords by default', () => {
    const result = tokenize('the and or but in on at');
    assert.strictEqual(result.length, 0);
  });

  it('should split CamelCase identifiers', () => {
    const result = tokenize('helloWorld fooBar');
    assert.ok(result.some(t => t.includes('hello')));
    assert.ok(result.some(t => t.includes('world')));
  });

  it('should split snake_case identifiers', () => {
    const result = tokenize('hello_world foo_bar');
    assert.ok(result.some(t => t.includes('hello')));
    assert.ok(result.some(t => t.includes('world')));
  });
});
