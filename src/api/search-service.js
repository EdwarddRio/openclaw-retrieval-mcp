/**
 * Knowledge Base Search Service - business logic layer for search operations.
 * Extracted from SearchFacade to separate concerns.
 */

import { logger, DEFAULT_TOP_K, INDEX_COLLECTIONS } from '../config.js';
import { buildSearchPlan, rerankResults } from '../retrieval/query-planner.js';
import { mmrRerank } from '../retrieval/mmr.js';
import { DEFAULT_SCORING } from '../retrieval/scoring-config.js';

export class KnowledgeBaseSearchService {
  constructor(options = {}) {
    this.collectionManager = options.collectionManager;
    this.memoryStore = options.memoryStore;
    this.queryExporter = options.queryExporter;
  }

  async search(options) {
    const startTime = performance.now();
    const { query, top_k, doc_type, session_id, include_debug } = options;

    try {
      const searchPlan = buildSearchPlan(query, doc_type, top_k);
      const allResults = [];
      const debugInfo = include_debug ? { plan: searchPlan } : null;

      // Memory results
      if (this.memoryStore) {
        const memoryResults = this.memoryStore.queryMemory(query, Math.min(top_k, 3), session_id);
        allResults.push(...(memoryResults.items || []).map(item => ({
          ...item,
          source: item.source || 'memory',
          doc_type: 'memory',
          score: item.score || 0.5,
          content: item.content,
          title: '记忆',
          collection: 'memory',
        })));
      }

      // Collection results
      if (this.collectionManager) {
        for (const collectionName of searchPlan.collections) {
          try {
            await this.collectionManager.prepareLazyForQuery(collectionName);
            const state = this.collectionManager.states[collectionName];
            
            if (state && state.retriever) {
              const collectionResults = await state.retriever.search(
                query,
                searchPlan.candidateLimit,
                doc_type,
                searchPlan.queryIntent
              );
              allResults.push(...(collectionResults || []));
            }
          } catch (error) {
            logger.warn(`Searching collection ${collectionName} failed: ${error}`);
          }
        }
      }

      // Rerank
      const reranked = rerankResults(searchPlan, allResults, top_k);
      
      // MMR deduplication
      let finalResults = reranked;
      if (DEFAULT_SCORING.mmrEnabled) {
        finalResults = mmrRerank(reranked, {
          lambda: DEFAULT_SCORING.mmrLambda,
          top_k,
          query_intent: searchPlan.queryIntent,
        });
      }

      const timingMs = Math.round(performance.now() - startTime);

      // Debug export
      if (this.queryExporter && include_debug) {
        await this.queryExporter.export({
          query,
          plan: searchPlan,
          results: finalResults,
          timing_ms: timingMs,
        });
      }

      return {
        results: finalResults,
        timing_ms: timingMs,
        debug: debugInfo,
        query,
        top_k,
      };
    } catch (error) {
      logger.error(`Search failed: ${error}`, error.stack);
      throw error;
    }
  }

  async syncCollections() {
    if (!this.collectionManager) {
      return { success: false, error: 'Collection manager not available' };
    }

    try {
      const collections = Object.keys(INDEX_COLLECTIONS);
      const results = [];
      
      for (const collection of collections) {
        try {
          await this.collectionManager.ensureCollectionReady(collection, true);
          results.push({ collection, success: true });
        } catch (error) {
          logger.warn(`Syncing collection ${collection} failed: ${error}`);
          results.push({ collection, success: false, error: error.message });
        }
      }

      return { success: true, results };
    } catch (error) {
      logger.error(`Sync collections failed: ${error}`);
      return { success: false, error: error.message };
    }
  }
}

export default KnowledgeBaseSearchService;
