/**
 * Hybrid retriever - combines vector search and BM25 keyword search
 * with scoring breakdown, rule priority bonus, and queryIntent-aware weighting.
 */

import { logger, DEFAULT_TOP_K, VECTOR_FETCH_K, BM25_FETCH_K } from '../config.js';
import { DEFAULT_SCORING } from './scoring-config.js';

const RULE_INTENT_KEYWORDS = ['规则', '规范', '约定'];
const RULE_DOC_TYPE = 'rule';
const RULE_PRIORITY_BONUS = 0.001;

export class HybridRetriever {
  constructor(indexer) {
    this.indexer = indexer;
  }

  async search(query, topK = DEFAULT_TOP_K, docType = null, queryIntent = null, scoring = null) {
    if (!query || !query.trim()) return [];

    const cfg = scoring || DEFAULT_SCORING;
    const effectiveDocType = this._resolveDocType(query, docType);
    const weights = this._queryWeights(queryIntent, cfg);

    const vectorResults = await this.indexer.vectorSearch(query, VECTOR_FETCH_K, effectiveDocType);
    const bm25Results = this.indexer.bm25Search(query, BM25_FETCH_K);

    const filteredBm25 = effectiveDocType
      ? bm25Results.filter(chunk => chunk.docType === effectiveDocType)
      : bm25Results;

    const scores = new Map();
    const chunkMap = new Map();
    const breakdowns = new Map();

    for (let rank = 0; rank < vectorResults.length; rank++) {
      const chunk = vectorResults[rank];
      const key = this._chunkKey(chunk);
      const contribution = weights.dense / (cfg.rrfK + rank + 1);
      const currentScore = scores.get(key) || 0;
      const bonus = this._scoreBonus(chunk, docType, effectiveDocType);
      scores.set(key, currentScore + contribution + bonus);

      const breakdown = breakdowns.get(key) || {
        vectorRrf: 0,
        bm25Rrf: 0,
        denseWeight: Math.round(weights.dense * 10000) / 10000,
        bm25Weight: Math.round(weights.bm25 * 10000) / 10000,
      };
      breakdown.vectorRrf = Math.round((breakdown.vectorRrf + contribution) * 1000000) / 1000000;
      if (bonus) {
        breakdown.rulePriorityBonus = Math.round((breakdown.rulePriorityBonus || 0) + bonus * 1000000) / 1000000;
      }
      breakdowns.set(key, breakdown);
      chunkMap.set(key, chunk);
    }

    for (let rank = 0; rank < filteredBm25.length; rank++) {
      const chunk = filteredBm25[rank];
      const key = this._chunkKey(chunk);
      const contribution = weights.bm25 / (cfg.rrfK + rank + 1);
      const currentScore = scores.get(key) || 0;
      const bonus = this._scoreBonus(chunk, docType, effectiveDocType);
      scores.set(key, currentScore + contribution + bonus);

      const breakdown = breakdowns.get(key) || {
        vectorRrf: 0,
        bm25Rrf: 0,
        denseWeight: Math.round(weights.dense * 10000) / 10000,
        bm25Weight: Math.round(weights.bm25 * 10000) / 10000,
      };
      breakdown.bm25Rrf = Math.round((breakdown.bm25Rrf + contribution) * 1000000) / 1000000;
      if (bonus) {
        breakdown.rulePriorityBonus = Math.round((breakdown.rulePriorityBonus || 0) + bonus * 1000000) / 1000000;
      }
      breakdowns.set(key, breakdown);
      chunkMap.set(key, chunk);
    }

    const sortedEntries = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    const results = [];

    for (const [key, score] of sortedEntries.slice(0, topK)) {
      const chunk = chunkMap.get(key);
      const breakdown = breakdowns.get(key);
      results.push({
        content: chunk.content,
        source: chunk.sourceFile,
        docType: chunk.docType,
        title: chunk.title,
        chunkId: chunk.chunkId,
        collection: chunk.collection,
        score: Math.round(score * 10000) / 10000,
        scoreBreakdown: { ...breakdown },
      });
    }

    return results;
  }

  _resolveDocType(query, docType) {
    if (docType) return docType;
    if (RULE_INTENT_KEYWORDS.some(keyword => query.includes(keyword))) return RULE_DOC_TYPE;
    return null;
  }

  _chunkKey(chunk) {
    if (chunk.chunkId) return String(chunk.chunkId);
    return `${chunk.sourceFile}::${chunk.title}::${chunk.content.slice(0, 50)}`;
  }

  _scoreBonus(chunk, requestedDocType, effectiveDocType) {
    if (requestedDocType === null && effectiveDocType === null && chunk.docType === RULE_DOC_TYPE) {
      return RULE_PRIORITY_BONUS;
    }
    return 0;
  }

  _queryWeights(queryIntent, scoring) {
    const intent = String(queryIntent || '').toLowerCase().trim();
    if (intent === 'exactsymbol') return { dense: scoring.denseExactWeight, bm25: scoring.bm25ExactWeight };
    if (intent === 'path') return { dense: scoring.densePathWeight, bm25: scoring.bm25PathWeight };
    if (intent === 'error') return { dense: scoring.denseErrorWeight, bm25: scoring.bm25ErrorWeight };
    if (intent === 'configkey') return { dense: scoring.denseConfigWeight, bm25: scoring.bm25ConfigWeight };
    return { dense: scoring.denseDefaultWeight, bm25: scoring.bm25DefaultWeight };
  }
}

export default HybridRetriever;
