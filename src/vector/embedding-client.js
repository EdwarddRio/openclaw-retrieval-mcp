/**
 * HTTP client for the Python Embedding Service.
 * Singleton pattern with lazy initialization, batch support, LRU cache, and circuit breaker.
 */

import { EMBEDDING_URL } from '../config.js';

// Simple LRU cache implementation
class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

// Circuit breaker state
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 30000;

class EmbeddingClient {
  constructor() {
    this.baseUrl = EMBEDDING_URL;
    this.cache = new LRUCache(1000);
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.circuitOpenTime = null;
    this.modelInfo = null;
  }

  /**
   * Check if the embedding service is healthy.
   */
  async health() {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) return { healthy: false, status: response.status };
      const data = await response.json();
      return { healthy: data.status === 'healthy', ...data };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }

  /**
   * Wait for the embedding service to become ready.
   * @param {number} timeoutMs - Maximum time to wait in milliseconds.
   * @param {number} intervalMs - Polling interval in milliseconds.
   */
  async waitForReady(timeoutMs = 60000, intervalMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const health = await this.health();
      if (health.healthy) {
        this.modelInfo = {
          modelName: health.model_name,
          dimension: health.dimension,
        };
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  }

  /**
   * Encode a batch of texts into embeddings.
   * Uses LRU cache to avoid re-encoding duplicate texts.
   * @param {string[]} texts - List of texts to encode.
   * @returns {Promise<number[][]>} - List of embedding vectors.
   */
  async encode(texts) {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Check circuit breaker
    if (this.circuitOpen) {
      if (Date.now() - this.circuitOpenTime > CIRCUIT_BREAKER_RESET_MS) {
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
      } else {
        throw new Error('Embedding service circuit breaker is open');
      }
    }

    // Check cache for each text
    const results = new Array(texts.length);
    const missingIndices = [];
    const missingTexts = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        missingIndices.push(i);
        missingTexts.push(texts[i]);
      }
    }

    if (missingTexts.length === 0) {
      return results;
    }

    // Batch size limit
    const MAX_BATCH_SIZE = 500;
    if (missingTexts.length > MAX_BATCH_SIZE) {
      const allEmbeddings = new Array(missingTexts.length);
      for (let start = 0; start < missingTexts.length; start += MAX_BATCH_SIZE) {
        const end = Math.min(start + MAX_BATCH_SIZE, missingTexts.length);
        const batchTexts = missingTexts.slice(start, end);
        const batchEmbeddings = await this._encodeBatch(batchTexts);
        for (let i = 0; i < batchEmbeddings.length; i++) {
          allEmbeddings[start + i] = batchEmbeddings[i];
        }
      }
      // Fill results and cache
      for (let i = 0; i < missingIndices.length; i++) {
        const embedding = allEmbeddings[i];
        results[missingIndices[i]] = embedding;
        this.cache.set(missingTexts[i], embedding);
      }
      return results;
    }

    const embeddings = await this._encodeBatch(missingTexts);

    // Fill results and cache
    for (let i = 0; i < missingIndices.length; i++) {
      const embedding = embeddings[i];
      results[missingIndices[i]] = embedding;
      this.cache.set(missingTexts[i], embedding);
    }

    return results;
  }

  async _encodeBatch(texts) {
    try {
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ texts }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      this.consecutiveFailures = 0;
      return data.embeddings;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpen = true;
        this.circuitOpenTime = Date.now();
      }
      throw err;
    }
  }

  /**
   * Check if the embedding service is available.
   */
  isAvailable() {
    return !this.circuitOpen;
  }
}

// Singleton instance
let _instance = null;

export function getEmbeddingClient() {
  if (!_instance) {
    _instance = new EmbeddingClient();
  }
  return _instance;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default EmbeddingClient;
