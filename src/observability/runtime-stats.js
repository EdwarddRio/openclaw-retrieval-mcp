/**
 * Runtime stats - persistent performance tracking.
 */

import fs from 'fs';
import path from 'path';
import { logger, RUNTIME_DIR } from '../config.js';

export class RuntimeStats {
  constructor() {
    this._statsDir = path.join(RUNTIME_DIR, 'stats');
    this._statsPath = path.join(this._statsDir, 'runtime.json');
    this._persistentStats = this._loadPersistentStats();
    this._startTime = Date.now();
  }

  _loadPersistentStats() {
    if (!fs.existsSync(this._statsPath)) {
      return this._createEmptyStats();
    }

    try {
      const content = fs.readFileSync(this._statsPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      logger.warn(`Failed to load runtime stats: ${error}`);
      return this._createEmptyStats();
    }
  }

  _createEmptyStats() {
    return {
      started_at: new Date().toISOString(),
      requests: { total: 0, search: 0, memory: 0, errors: 0 },
      latency: { search_ms: [], memory_ms: [], avg_search_ms: 0, avg_memory_ms: 0 },
      collections: {},
    };
  }

  incrementSearch(latencyMs) {
    this._persistentStats.requests.total++;
    this._persistentStats.requests.search++;
    this._persistentStats.latency.search_ms.push(latencyMs);
    this._updateLatency();
    this._savePersistentStats();
  }

  incrementMemory(latencyMs) {
    this._persistentStats.requests.total++;
    this._persistentStats.requests.memory++;
    this._persistentStats.latency.memory_ms.push(latencyMs);
    this._updateLatency();
    this._savePersistentStats();
  }

  incrementError() {
    this._persistentStats.requests.errors++;
    this._savePersistentStats();
  }

  updateCollectionStats(collectionName, stats) {
    this._persistentStats.collections[collectionName] = {
      ...stats,
      updated_at: new Date().toISOString(),
    };
    this._savePersistentStats();
  }

  getStats() {
    const uptimeMs = Date.now() - this._startTime;
    return {
      ...this._persistentStats,
      uptime_ms: uptimeMs,
      uptime_seconds: Math.floor(uptimeMs / 1000),
    };
  }

  _updateLatency() {
    if (this._persistentStats.latency.search_ms.length > 0) {
      const total = this._persistentStats.latency.search_ms.reduce((a, b) => a + b, 0);
      this._persistentStats.latency.avg_search_ms = Math.round(total / this._persistentStats.latency.search_ms.length);
    }
    if (this._persistentStats.latency.memory_ms.length > 0) {
      const total = this._persistentStats.latency.memory_ms.reduce((a, b) => a + b, 0);
      this._persistentStats.latency.avg_memory_ms = Math.round(total / this._persistentStats.latency.memory_ms.length);
    }
  }

  _savePersistentStats() {
    try {
      if (!fs.existsSync(this._statsDir)) {
        fs.mkdirSync(this._statsDir, { recursive: true });
      }
      fs.writeFileSync(this._statsPath, JSON.stringify(this._persistentStats, null, 2), 'utf8');
    } catch (error) {
      logger.warn(`Failed to save runtime stats: ${error}`);
    }
  }
}

export default RuntimeStats;
