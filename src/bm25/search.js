/**
 * BM25 search utilities.
 */

import fs from 'fs';
import path from 'path';
import { BM25Okapi } from './index.js';

/**
 * Search a corpus using BM25 and return ranked results.
 * @param {string[]} corpus - Array of document strings.
 * @param {string} query - Query string.
 * @param {number} topK - Number of top results.
 * @param {Object} options - BM25 parameters.
 * @returns {Array<{index: number, score: number, document: string}>}
 */
export function bm25Search(corpus, query, topK = 10, options = {}) {
  const bm25 = new BM25Okapi(corpus, options);
  const topResults = bm25.getTopK(query, topK);
  return topResults.map(({ index, score }) => ({
    index,
    score,
    document: corpus[index],
  }));
}

/**
 * Load a BM25 index from disk.
 * @param {string} filePath - Path to the JSON file.
 * @returns {BM25Okapi|null}
 */
export function loadBm25Index(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return BM25Okapi.fromJSON(data);
  } catch {
    return null;
  }
}

/**
 * Save a BM25 index to disk.
 * @param {BM25Okapi} index
 * @param {string} filePath
 */
export function saveBm25Index(index, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(index.toJSON()), 'utf-8');
}

export { BM25Okapi };
