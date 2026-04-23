import { describe, it } from 'node:test';
import assert from 'node:assert';
import { rrfFuse, twoStageFuse } from '../src/retrieval/fusion.js';

describe('RRF Fusion', () => {
  it('should fuse two ranked lists', () => {
    const list1 = [{ item: 'a' }, { item: 'b' }, { item: 'c' }];
    const list2 = [{ item: 'b' }, { item: 'd' }, { item: 'a' }];

    const result = rrfFuse([list1, list2], 5);

    assert.ok(result.length > 0);
    assert.ok(result.length <= 5);
  });

  it('should boost items appearing in multiple lists', () => {
    const list1 = [{ item: 'a' }, { item: 'b' }];
    const list2 = [{ item: 'a' }, { item: 'c' }];

    const result = rrfFuse([list1, list2], 3);

    // 'a' appears in both lists, should be ranked first
    assert.strictEqual(result[0].item, 'a');
  });

  it('should handle two-stage fusion', () => {
    // variantResults: each collection has an array of result lists
    const collectionResults = {
      static_kb: [
        [{ source: 'doc1' }, { source: 'doc2' }],
      ],
      code: [
        [{ source: 'code1' }, { source: 'doc1' }],
      ],
    };

    const result = twoStageFuse(collectionResults, 3);

    assert.ok(Array.isArray(result));
    assert.ok(result.length <= 3);
  });
});
