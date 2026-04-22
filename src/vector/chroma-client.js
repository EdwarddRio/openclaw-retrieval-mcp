/**
 * ChromaDB HTTP client wrapper.
 * Provides collection management, vector storage, and similarity search.
 */

import { ChromaClient } from 'chromadb';
import { CHROMA_URL } from '../config.js';

class ChromaDbClient {
  constructor() {
    this.client = new ChromaClient({ path: CHROMA_URL });
    this.collections = new Map();
  }

  /**
   * Get or create a collection.
   * @param {string} name - Collection name.
   * @param {Object} metadata - Optional collection metadata.
   * @returns {Promise<Object>} - ChromaDB collection object.
   */
  async getOrCreateCollection(name, metadata = {}) {
    if (this.collections.has(name)) {
      return this.collections.get(name);
    }

    const defaultMetadata = { 'hnsw:space': 'cosine' };
    const mergedMetadata = { ...defaultMetadata, ...metadata };

    const collection = await this.client.getOrCreateCollection({
      name,
      metadata: mergedMetadata,
    });

    this.collections.set(name, collection);
    return collection;
  }

  /**
   * Get an existing collection.
   * @param {string} name - Collection name.
   * @returns {Promise<Object|null>} - Collection or null if not found.
   */
  async getCollection(name) {
    if (this.collections.has(name)) {
      return this.collections.get(name);
    }
    try {
      const collection = await this.client.getCollection({ name });
      this.collections.set(name, collection);
      return collection;
    } catch {
      return null;
    }
  }

  /**
   * Delete a collection.
   * @param {string} name - Collection name.
   */
  async deleteCollection(name) {
    try {
      await this.client.deleteCollection({ name });
    } catch {
      // Ignore if collection doesn't exist
    }
    this.collections.delete(name);
  }

  /**
   * Add or upsert documents to a collection.
   * @param {string} collectionName - Target collection.
   * @param {Object} params - { ids, embeddings, documents, metadatas }
   * @param {string} operation - 'add' or 'upsert'.
   */
  async addDocuments(collectionName, { ids, embeddings, documents, metadatas }, operation = 'add') {
    const collection = await this.getOrCreateCollection(collectionName);
    const MAX_BATCH_SIZE = 500;

    for (let start = 0; start < ids.length; start += MAX_BATCH_SIZE) {
      const end = Math.min(start + MAX_BATCH_SIZE, ids.length);
      const batch = {
        ids: ids.slice(start, end),
        embeddings: embeddings.slice(start, end),
        documents: documents.slice(start, end),
        metadatas: metadatas.slice(start, end),
      };

      if (operation === 'upsert') {
        await collection.upsert(batch);
      } else {
        await collection.add(batch);
      }
    }
  }

  /**
   * Delete documents by IDs.
   * @param {string} collectionName - Target collection.
   * @param {string[]} ids - Document IDs to delete.
   */
  async deleteDocuments(collectionName, ids) {
    const collection = await this.getCollection(collectionName);
    if (!collection) return;
    await collection.delete({ ids });
  }

  /**
   * Query collection by vector similarity.
   * @param {string} collectionName - Target collection.
   * @param {number[][]} queryEmbeddings - Query embedding vectors.
   * @param {number} nResults - Number of results to return.
   * @param {Object} where - Optional metadata filter.
   * @returns {Promise<Object>} - Query results.
   */
  async query(collectionName, queryEmbeddings, nResults = 10, where = null) {
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      return { ids: [[]], distances: [[]], documents: [[]], metadatas: [[]] };
    }

    const count = await collection.count();
    const actualNResults = Math.min(nResults, count || 0);
    if (actualNResults === 0) {
      return { ids: [[]], distances: [[]], documents: [[]], metadatas: [[]] };
    }

    const params = {
      queryEmbeddings,
      nResults: actualNResults,
    };
    if (where) {
      params.where = where;
    }

    return await collection.query(params);
  }

  /**
   * Get the count of documents in a collection.
   * @param {string} collectionName - Collection name.
   * @returns {Promise<number>}
   */
  async count(collectionName) {
    const collection = await this.getCollection(collectionName);
    if (!collection) return 0;
    return await collection.count();
  }

  /**
   * Peek at documents in a collection.
   * @param {string} collectionName - Collection name.
   * @param {number} limit - Number of documents to peek.
   * @returns {Promise<Object>}
   */
  async peek(collectionName, limit = 10) {
    const collection = await this.getCollection(collectionName);
    if (!collection) return { ids: [], documents: [], metadatas: [] };
    return await collection.peek({ limit });
  }

  /**
   * List all collections.
   * @returns {Promise<string[]>}
   */
  async listCollections() {
    const collections = await this.client.listCollections();
    return collections.map(c => c.name);
  }

  /**
   * Reset the client (clear cached collections).
   */
  reset() {
    this.collections.clear();
  }

  /**
   * Health check.
   * @returns {Promise<{healthy: boolean, error?: string}>}
   */
  async health() {
    try {
      await this.client.heartbeat();
      return { healthy: true };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }
}

// Singleton instance
let _instance = null;

export function getChromaClient() {
  if (!_instance) {
    _instance = new ChromaDbClient();
  }
  return _instance;
}

export default ChromaDbClient;
