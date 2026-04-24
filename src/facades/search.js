/**
 * Search facade - orchestrates search operations via KnowledgeBaseSearchService.
 */

import { CollectionManager } from '../retrieval/collection-manager.js';
import { logger, DEFAULT_TOP_K, CHROMA_DIR, INDEX_COLLECTIONS } from '../config.js';
import { KnowledgeBaseSearchService } from '../api/search-service.js';
import { QueryExporter } from '../api/query-exporter.js';

export class SearchFacade {
  constructor(options = {}) {
    this.collectionManager = options.collectionManager || new CollectionManager(CHROMA_DIR);
    this.memoryStore = options.memoryStore || null;

    this.searchService = new KnowledgeBaseSearchService({
      collectionManager: this.collectionManager,
      memoryStore: this.memoryStore,
      queryExporter: new QueryExporter(),
    });
  }

  async initializeEager() {
    await this.collectionManager.initializeEager();
  }

  async search(options) {
    const { query, top_k, doc_type, session_id, include_debug } = options;
    return this.searchService.search({
      query,
      top_k: top_k || DEFAULT_TOP_K,
      doc_type,
      session_id,
      include_debug,
    });
  }

  async syncCollections() {
    return this.searchService.syncCollections();
  }

  getCollections() {
    return Object.keys(INDEX_COLLECTIONS).map(name => ({
      name,
      lazy: !!INDEX_COLLECTIONS[name]?.lazy,
    }));
  }

  getCollectionContext(collectionName) {
    if (!this.collectionManager) return null;

    const state = this.collectionManager.states[collectionName];
    if (!state) return null;

    return {
      name: collectionName,
      loaded: this.collectionManager._stateFlag(state, 'loaded'),
      warming: this.collectionManager._stateFlag(state, 'warming'),
      chunk_count: this.collectionManager._stateChunkCount(state),
      last_load_mode: this.collectionManager._stateText(state, 'lastLoadMode'),
    };
  }

  async rebuild() {
    const collections = Array.from(this.collectionManager._indexers?.keys() || []);
    const results = {};
    for (const collection of collections) {
      results[collection] = await this.collectionManager.rebuildCollection(collection);
    }
    return { rebuilt: true, collections: results };
  }

  async stats() {
    return await this.collectionManager.getStats();
  }
}

export default SearchFacade;
