/**
 * Collection manager - manages collection lifecycle, lazy/eager loading, and sync.
 */

import { Indexer } from './indexer.js';
import { ManifestStore } from './manifest.js';
import { scanCollectionWithReport, iterTargets } from './scanner.js';
import { INDEX_COLLECTIONS } from '../config.js';
import { HybridRetriever } from './retriever.js';

export class CollectionManager {
  constructor(chromaRoot) {
    this._chromaRoot = chromaRoot;
    this._indexers = new Map();
    this._manifests = new Map();
    this._retrievers = new Map();
    this._states = new Map();
    this._initialized = false;
  }

  get states() {
    return Object.fromEntries(this._states);
  }

  async initializeEager() {
    if (this._initialized) return;

    // Initialize eager collections
    const eagerCollections = this._getEagerCollections();
    for (const collection of eagerCollections) {
      await this._ensureIndexer(collection);
    }

    this._initialized = true;
  }

  async getIndexer(collection) {
    return await this._ensureIndexer(collection);
  }

  async rebuildCollection(collection) {
    const indexer = await this._ensureIndexer(collection);
    const [chunks, report] = scanCollectionWithReport(collection);
    await indexer.build(chunks);

    // Update manifest
    const manifest = this._getManifest(collection);
    const targets = iterTargets([collection]);
    manifest.saveTargets(targets, [collection]);

    return { chunks: chunks.length, report };
  }

  async syncCollection(collection) {
    const indexer = await this._ensureIndexer(collection);
    const manifest = this._getManifest(collection);
    const targets = iterTargets([collection]);

    if (!manifest.isStale(targets, [collection])) {
      return { synced: false, reason: 'up_to_date' };
    }

    const diff = manifest.diff(targets, [collection]);
    const changedTargets = [...diff.added, ...diff.updated];

    if (changedTargets.length === 0 && diff.deleted.length === 0) {
      return { synced: false, reason: 'no_changes' };
    }

    // Load changed chunks
    const { loadTargetWithReport } = await import('./scanner.js');
    const upsertChunks = [];
    for (const target of changedTargets) {
      const [chunks] = loadTargetWithReport(target);
      upsertChunks.push(...chunks);
    }

    const deletedSourceFiles = diff.deleted.map(r => r.sourceFile);
    await indexer.syncChunks(upsertChunks, deletedSourceFiles);

    manifest.saveTargets(targets, [collection]);

    return {
      synced: true,
      added: diff.added.length,
      updated: diff.updated.length,
      deleted: diff.deleted.length,
      upsertedChunks: upsertChunks.length,
    };
  }

  async getStats() {
    const stats = {};
    for (const [name, indexer] of this._indexers) {
      const count = await indexer._chromaClient.count(name);
      stats[name] = {
        chromaCount: count,
        cacheChunks: indexer._chunks.length,
      };
    }
    return stats;
  }

  async prepareLazyForQuery(collection) {
    await this._ensureIndexer(collection);
  }

  async ensureCollectionReady(collection, forceSync = false) {
    const indexer = await this._ensureIndexer(collection);
    if (forceSync) {
      await this.syncCollection(collection);
    }
    return indexer;
  }

  async _ensureIndexer(collection) {
    if (this._indexers.has(collection)) {
      return this._indexers.get(collection);
    }

    const chromaDir = `${this._chromaRoot}/${collection}`;
    const indexer = new Indexer(chromaDir, collection);

    // Try loading from cache first (async now)
    const cacheLoaded = await indexer.loadCache();
    if (!cacheLoaded) {
      // Build from scratch
      const [chunks] = scanCollectionWithReport(collection);
      await indexer.build(chunks);

      // Save manifest
      const manifest = this._getManifest(collection);
      const targets = iterTargets([collection]);
      manifest.saveTargets(targets, [collection]);
    }

    this._indexers.set(collection, indexer);

    // Create retriever and state
    const retriever = new HybridRetriever(indexer);
    this._retrievers.set(collection, retriever);
    this._states.set(collection, {
      retriever,
      indexer,
      loaded: true,
      warming: false,
      chunkCount: indexer.chunkCount(),
    });

    return indexer;
  }

  _getManifest(collection) {
    if (!this._manifests.has(collection)) {
      this._manifests.set(collection, new ManifestStore());
    }
    return this._manifests.get(collection);
  }

  _getEagerCollections() {
    // Import config dynamically to avoid circular dependency issues
    return Object.entries(INDEX_COLLECTIONS)
      .filter(([, cfg]) => !cfg.lazy)
      .map(([name]) => name);
  }
}

export default CollectionManager;
