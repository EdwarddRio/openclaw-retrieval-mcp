import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { WikiCompiler } from '../src/wiki/compiler.js';

const TEST_WIKI_DIR = path.join(process.cwd(), 'tests', 'tmp-llmwiki');

describe('WikiCompiler', () => {
  beforeEach(() => {
    fs.rmSync(TEST_WIKI_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_WIKI_DIR, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(TEST_WIKI_DIR, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(TEST_WIKI_DIR, 'wiki', 'Example.md'), '# Example\n\ncontent', 'utf-8');
    fs.writeFileSync(path.join(TEST_WIKI_DIR, 'raw', 'source.md'), '# Source\n\nraw content', 'utf-8');
    fs.writeFileSync(path.join(TEST_WIKI_DIR, 'raw-sources.json'), JSON.stringify({
      sources: [{ id: 'test-source', type: 'file', path: 'raw/source.md' }],
    }), 'utf-8');
  });

  it('should auto-derive pages when updating index without pages argument', () => {
    const compiler = new WikiCompiler({ llmwikiDir: TEST_WIKI_DIR });
    const result = compiler.updateIndex();
    assert.strictEqual(result.indexUpdated, true);
    assert.strictEqual(result.pageCount, 1);
    const index = fs.readFileSync(path.join(TEST_WIKI_DIR, 'wiki', 'index.md'), 'utf-8');
    assert.match(index, /Example/);
  });

  it('should reject unsafe wiki page names', () => {
    const compiler = new WikiCompiler({ llmwikiDir: TEST_WIKI_DIR });
    assert.throws(() => compiler.saveWikiPage({
      sourcePath: path.join(TEST_WIKI_DIR, 'raw', 'source.md'),
      wikiPageName: '../escape.md',
      content: '# Escape',
      sourceId: 'test-source',
    }), /Invalid wikiPageName/);
  });
});
