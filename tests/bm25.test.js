import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BM25Okapi } from '../src/bm25/index.js';

describe('BM25', () => {
  it('should rank relevant documents higher', () => {
    const corpus = [
      'Hello world',
      'Hello world this is a test',
      'Something completely different',
      'Hello again world',
    ];

    const bm25 = new BM25Okapi(corpus);
    const scores = bm25.getScores('hello world');

    assert.ok(scores.length === 4);
    // Documents with both terms should score higher
    assert.ok(scores[1] > scores[2]);
  });

  it('should return top-k results', () => {
    const corpus = [
      'apple banana cherry',
      'banana cherry date',
      'cherry date elderberry',
      'date elderberry fig',
    ];

    const bm25 = new BM25Okapi(corpus);
    const topK = bm25.getTopK('cherry', 2);

    assert.strictEqual(topK.length, 2);
    assert.ok(topK[0].score >= topK[1].score);
  });

  it('should serialize and deserialize', () => {
    const corpus = ['hello world', 'foo bar'];
    const bm25 = new BM25Okapi(corpus);

    const json = bm25.toJSON();
    const restored = BM25Okapi.fromJSON(json);

    const originalScores = bm25.getScores('hello');
    const restoredScores = restored.getScores('hello');

    assert.deepStrictEqual(originalScores, restoredScores);
  });
});
