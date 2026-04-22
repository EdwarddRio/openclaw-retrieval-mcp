/**
 * Indexer - manages ChromaDB vector index and BM25 keyword index.
 * With modelUnavailable degradation, Chroma connection fault-tolerance,
 * and batch processing.
 */

import fs from 'fs';
import path from 'path';
import { logger, CHROMA_DIR, VECTOR_FETCH_K, EMBEDDING_MODEL } from '../config.js';
import { getChromaClient } from '../vector/chroma-client.js';
import { getEmbeddingClient } from '../vector/embedding-client.js';
import { BM25Okapi } from '../bm25/index.js';
import { tokenizeKeepAll } from './tokenizer.js';

export class Indexer {
  constructor(chromaDir = CHROMA_DIR, collectionName = 'project_knowledge', modelName = EMBEDDING_MODEL) {
    this._chromaDir = chromaDir;
    this._collectionName = collectionName;
    this._cacheFile = path.join(path.dirname(chromaDir), `${collectionName}_index_cache.json`);
    this._modelName = modelName;
    this._chromaClient = getChromaClient();
    this._embeddingClient = getEmbeddingClient();
    this.bm25Index = null;
    this._chunks = [];
    this._chunkById = {};
    this._tokenizedCorpus = [];
    this.modelUnavailable = false;
    this._collection = null;
  }

  async build(chunks) {
    this._chunks = [...chunks];
    this._refreshChunkLookup();
    await this._buildChroma(chunks);
    this._buildBm25(chunks);
    this._saveCache();
    logger.info(`Index built and cached: ${chunks.length} chunks`);
  }

  async syncChunks(upsertChunks, deletedSourceFiles = []) {
    const deletedSources = new Set(deletedSourceFiles);
    for (const chunk of upsertChunks) {
      deletedSources.add(chunk.sourceFile);
    }

    const staleIds = [];
    for (let index = 0; index < this._chunks.length; index++) {
      const chunk = this._chunks[index];
      if (deletedSources.has(chunk.sourceFile)) {
        staleIds.push(this._chunkStorageId(chunk, index));
      }
    }

    this._chunks = this._chunks.filter(c => !deletedSources.has(c.sourceFile));
    this._chunks.push(...upsertChunks);
    this._refreshChunkLookup();

    if (staleIds.length > 0) {
      try {
        await this._chromaClient.deleteDocuments(this._collectionName, staleIds);
      } catch (error) {
        logger.warn(`Failed to delete stale documents: ${error}`);
      }
    }

    if (upsertChunks.length > 0) {
      await this._upsertChroma(upsertChunks);
    }

    this._buildBm25(this._chunks);
    this._saveCache();
    logger.info(
      `Incremental sync applied: removed=${staleIds.length} upserted=${upsertChunks.length} chunk_count=${this._chunks.length}`
    );
  }

  async vectorSearch(query, topK = VECTOR_FETCH_K, docType = null) {
    if (this.modelUnavailable) return [];

    const count = await this._chromaClient.count(this._collectionName);
    if (count === 0) return [];

    if (!this._embeddingClient.isAvailable()) return [];

    try {
      const queryEmbeddings = await this._embeddingClient.encode([query]);
      const where = docType ? { doc_type: docType } : null;
      const results = await this._chromaClient.query(
        this._collectionName,
        queryEmbeddings,
        Math.min(topK, count),
        where
      );

      const found = [];
      if (results.ids && results.ids[0]) {
        for (const rawId of results.ids[0]) {
          const chunk = this._resolveChunk(rawId);
          if (chunk) found.push(chunk);
        }
      }
      return found;
    } catch (error) {
      logger.error(`Vector search failed: ${error}`);
      return [];
    }
  }

  bm25Search(query, topK = VECTOR_FETCH_K) {
    if (!this.bm25Index || this._chunks.length === 0) return [];
    
    const tokens = tokenizeKeepAll(query);
    const scores = this.bm25Index.getScores(tokens);
    const indexedScores = scores.map((score, index) => ({ index, score }));
    indexedScores.sort((a, b) => b.score - a.score);

    const results = [];
    for (const { index, score } of indexedScores.slice(0, topK)) {
      if (score > 0) {
        results.push(this._chunks[index]);
      }
    }
    return results;
  }

  async _buildChroma(chunks) {
    if (this.modelUnavailable) {
      this._collection = null;
      logger.warn('Skipping vector index build because embedding model is unavailable');
      return;
    }

    if (chunks.length === 0) {
      await this._chromaClient.getOrCreateCollection(this._collectionName);
      return;
    }

    if (!this._embeddingClient.isAvailable()) {
      this.modelUnavailable = true;
      logger.warn('Skipping vector index build because embedding service is unavailable');
      return;
    }

    try {
      await this._chromaClient.deleteCollection(this._collectionName);
      await this._chromaClient.getOrCreateCollection(this._collectionName);
      await this._addChunksToCollection(chunks, 'add');
    } catch (error) {
      logger.error(`Failed to build Chroma index: ${error}`);
      this.modelUnavailable = true;
    }
  }

  async _upsertChroma(chunks) {
    if (this.modelUnavailable) {
      logger.warn('Skipping vector upsert because embedding model is unavailable');
      return;
    }
    if (!this._embeddingClient.isAvailable()) {
      logger.warn('Skipping vector upsert because embedding service is unavailable');
      return;
    }
    await this._addChunksToCollection(chunks, 'upsert');
  }

  async _addChunksToCollection(chunks, operation) {
    if (!chunks || chunks.length === 0) return;

    const texts = chunks.map(c => c.content);
    const embeddings = await this._embeddingClient.encode(texts);
    const ids = chunks.map((chunk, index) => this._chunkStorageId(chunk, index));
    const metadatas = chunks.map(chunk => this._chunkMetadata(chunk));

    const batchSize = 500;
    for (let start = 0; start < chunks.length; start += batchSize) {
      const end = start + batchSize;
      const batchIds = ids.slice(start, end);
      const batchEmbeddings = embeddings.slice(start, end);
      const batchDocuments = texts.slice(start, end);
      const batchMetadatas = metadatas.slice(start, end);

      await this._chromaClient.addDocuments(
        this._collectionName,
        { ids: batchIds, embeddings: batchEmbeddings, documents: batchDocuments, metadatas: batchMetadatas },
        operation
      );
    }
  }

  _chunkStorageId(chunk, index) {
    return chunk.chunkId || String(index);
  }

  _chunkMetadata(chunk) {
    const meta = {
      sourceFile: chunk.sourceFile,
      docType: chunk.docType,
      title: chunk.title,
      collection: chunk.collection,
    };
    if (chunk.language) meta.language = chunk.language;
    if (chunk.headingPath) meta.headingPath = chunk.headingPath;
    if (chunk.symbols && chunk.symbols.length > 0) meta.symbols = chunk.symbols.join(',');
    return meta;
  }

  _buildBm25(chunks) {
    this._tokenizedCorpus = chunks.map(c => tokenizeKeepAll(c.content));
    if (this._tokenizedCorpus.length > 0) {
      this.bm25Index = new BM25Okapi(this._tokenizedCorpus);
    } else {
      this.bm25Index = null;
    }
  }

  _refreshChunkLookup() {
    this._chunkById = {};
    for (let index = 0; index < this._chunks.length; index++) {
      this._chunkById[this._chunkStorageId(this._chunks[index], index)] = this._chunks[index];
    }
  }

  _resolveChunk(rawId) {
    const chunk = this._chunkById[String(rawId)];
    if (chunk) return chunk;
    if (/^\d+$/.test(String(rawId))) {
      const idx = parseInt(rawId, 10);
      if (idx < this._chunks.length) return this._chunks[idx];
    }
    return null;
  }

  async loadCache() {
    // 优先从本地 JSON 缓存加载
    if (fs.existsSync(this._cacheFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this._cacheFile, 'utf-8'));
        this._chunks = data.chunks.map(c => ({
          content: c.content,
          sourceFile: c.sourceFile,
          docType: c.docType,
          title: c.title,
          chunkId: c.chunkId || '',
          collection: c.collection || '',
          language: c.language || '',
          symbols: c.symbols || [],
          headingPath: c.headingPath || '',
          tags: c.tags || [],
        }));
        this._refreshChunkLookup();
        this._tokenizedCorpus = data.tokenizedCorpus || [];
        if (this._tokenizedCorpus.length > 0) {
          this.bm25Index = new BM25Okapi(this._tokenizedCorpus);
        }

        // Reconnect Chroma collection
        try {
          this._collection = this._chromaClient.getOrCreateCollection
            ? await this._chromaClient.getOrCreateCollection(this._collectionName)
            : null;
        } catch (error) {
          logger.warn(`Chroma collection missing, vector retrieval disabled until rebuild: ${error}`);
          this._collection = null;
        }

        logger.info(`Index loaded from cache: ${this._chunks.length} chunks`);
        return true;
      } catch (err) {
        logger.warn(`Cache load failed, will try ChromaDB recovery: ${err.message}`);
      }
    }

    // 本地缓存不存在或损坏，尝试从 ChromaDB 恢复
    return await this._recoverFromChroma();
  }

  async _recoverFromChroma() {
    try {
      const collection = await this._chromaClient.getCollection(this._collectionName);
      if (!collection) return false;

      const count = await collection.count();
      if (count === 0) return false;

      // 分页获取所有文档
      const batchSize = 500;
      const recoveredChunks = [];
      for (let offset = 0; offset < count; offset += batchSize) {
        const batch = await collection.get({ limit: batchSize, offset });
        if (!batch || !batch.ids) continue;
        for (let i = 0; i < batch.ids.length; i++) {
          const meta = batch.metadatas?.[i] || {};
          recoveredChunks.push({
            content: batch.documents?.[i] || '',
            sourceFile: meta.sourceFile || '',
            docType: meta.docType || '',
            title: meta.title || '',
            chunkId: batch.ids[i] || '',
            collection: meta.collection || this._collectionName,
            language: meta.language || '',
            symbols: meta.symbols ? meta.symbols.split(',') : [],
            headingPath: meta.headingPath || '',
            tags: [],
          });
        }
      }

      this._chunks = recoveredChunks;
      this._refreshChunkLookup();
      this._buildBm25(this._chunks);
      this._saveCache();

      logger.info(`Index recovered from ChromaDB: ${this._chunks.length} chunks`);
      return true;
    } catch (err) {
      logger.warn(`ChromaDB recovery failed, will rebuild from source: ${err.message}`);
      return false;
    }
  }

  chunkCount() {
    return this._chunks.length;
  }

  clearCache() {
    if (fs.existsSync(this._cacheFile)) {
      fs.unlinkSync(this._cacheFile);
      logger.info('Cache cleared');
    }
  }

  _saveCache() {
    try {
      const dir = path.dirname(this._cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this._cacheFile,
        JSON.stringify({
          chunks: this._chunks,
          tokenizedCorpus: this._tokenizedCorpus,
        }),
        'utf-8'
      );
    } catch (err) {
      logger.warn(`Failed to save cache: ${err.message}`);
    }
  }
}

export default Indexer;
