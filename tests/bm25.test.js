/**
 * BM25 search tests.
 * Tests the hybrid search implementation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BM25Search, HybridWikiSearch } from '../src/wiki/bm25.js';

describe('BM25Search', () => {
  it('should tokenize text correctly', () => {
    const bm25 = new BM25Search();
    const tokens = bm25.tokenize('Hello World 你好世界');
    // Chinese text is tokenized into characters and bigrams
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('world'));
    assert.ok(tokens.includes('你'));
    assert.ok(tokens.includes('你好'));
    assert.ok(tokens.includes('世界'));
  });

  it('should add and search documents', () => {
    const bm25 = new BM25Search();
    bm25.addDocument('doc1', 'JavaScript is a programming language', { title: 'JavaScript' });
    bm25.addDocument('doc2', 'Python is also a programming language', { title: 'Python' });
    bm25.addDocument('doc3', 'Java is different from JavaScript', { title: 'Java' });
    
    const results = bm25.search('JavaScript language', 3);
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].docId, 'doc1');
  });

  it('should handle empty queries', () => {
    const bm25 = new BM25Search();
    bm25.addDocument('doc1', 'test content');
    
    const results = bm25.search('', 5);
    assert.deepStrictEqual(results, []);
  });

  it('should handle Chinese text', () => {
    const bm25 = new BM25Search();
    bm25.addDocument('doc1', '这是一个测试文档');
    bm25.addDocument('doc2', '这是另一个文档');
    
    const results = bm25.search('测试', 5);
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].docId, 'doc1');
  });

  it('should remove documents', () => {
    const bm25 = new BM25Search();
    bm25.addDocument('doc1', 'test content');
    bm25.addDocument('doc2', 'other content');
    
    bm25.removeDocument('doc1');
    
    const results = bm25.search('test', 5);
    assert.strictEqual(results.length, 0);
  });

  it('should provide statistics', () => {
    const bm25 = new BM25Search();
    bm25.addDocument('doc1', 'test content one');
    bm25.addDocument('doc2', 'test content two');
    
    const stats = bm25.stats();
    assert.strictEqual(stats.docCount, 2);
    assert.ok(stats.avgDocLen > 0);
    assert.ok(stats.uniqueTerms > 0);
  });
});

describe('HybridWikiSearch', () => {
  it('should use simple search below threshold', () => {
    const search = new HybridWikiSearch({ bm25Threshold: 10 });
    
    for (let i = 0; i < 5; i++) {
      search.addPage(`page${i}`, `Content for page ${i}`);
    }
    
    assert.strictEqual(search.getMode(), 'simple');
    const results = search.search('Content', 5);
    assert.ok(results.length > 0);
  });

  it('should switch to BM25 above threshold', () => {
    const search = new HybridWikiSearch({ bm25Threshold: 5 });
    
    for (let i = 0; i < 10; i++) {
      search.addPage(`page${i}`, `Content for page ${i} with unique word ${i}`);
    }
    
    assert.strictEqual(search.getMode(), 'bm25');
    const results = search.search('Content', 5);
    assert.ok(results.length > 0);
  });

  it('should handle page removal', () => {
    const search = new HybridWikiSearch({ bm25Threshold: 5 });
    
    for (let i = 0; i < 10; i++) {
      search.addPage(`page${i}`, `Content ${i}`);
    }
    
    assert.strictEqual(search.getMode(), 'bm25');
    
    // Remove pages to go below threshold (need to have less than 5 pages)
    for (let i = 4; i < 10; i++) {
      search.removePage(`page${i}`);
    }
    
    // Now we have 4 pages (page0-page3), which is below threshold of 5
    assert.strictEqual(search.getMode(), 'simple');
  });

  it('should provide statistics', () => {
    const search = new HybridWikiSearch({ bm25Threshold: 100 });
    
    for (let i = 0; i < 5; i++) {
      search.addPage(`page${i}`, `Content ${i}`);
    }
    
    const stats = search.stats();
    assert.strictEqual(stats.mode, 'simple');
    assert.strictEqual(stats.pageCount, 5);
    assert.strictEqual(stats.threshold, 100);
  });

  it('should boost title matches', () => {
    const search = new HybridWikiSearch({ bm25Threshold: 100 });
    
    search.addPage('JavaScript Guide', 'This is a guide about programming');
    search.addPage('Python Tutorial', 'This is a tutorial about JavaScript programming');
    
    const results = search.search('JavaScript', 5);
    assert.ok(results.length > 0);
    // Title match should rank higher
    assert.strictEqual(results[0].docId, 'JavaScript Guide');
  });
});
