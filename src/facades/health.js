/**
 * Health facade - aggregates health status from all components.
 * localMem + LLMWiki architecture — no static_kb/BM25.
 */

import { buildDeploymentSummary } from '../config.js';

export class HealthFacade {
  /**
   * 健康检查门面，聚合 localmem 和 benchmark 组件的健康状态
   * @param {object} memoryFacade - 记忆操作门面实例
   * @param {object} benchmarkFacade - 基准测试门面实例
   */
  constructor(memoryFacade, benchmarkFacade) {
    this.memoryFacade = memoryFacade;
    this.benchmarkFacade = benchmarkFacade;
  }

  /**
   * 生成完整健康快照，并行检查 localmem 和 benchmark
   * @returns {Promise<object>} 包含 status/localmem/benchmarks/deployment/stale_flags/timestamp 的快照
   */
  async healthSnapshot() {
    const [localmem, benchmarks] = await Promise.all([
      this.healthLocalmem(),
      this.healthBenchmarks(),
    ]);

    const allHealthy = localmem.healthy;

    const staleFlags = [];
    if (benchmarks.available === false) staleFlags.push('benchmark_missing');
    else if (benchmarks.stale) staleFlags.push('benchmark_stale');

    const governance = {
      pending_review_count: localmem.stats?.tentative || 0,
      wiki_candidate_count: 0,
    };
    if (governance.pending_review_count > 0) {
      staleFlags.push('review_queue_backlog');
    }

    const status = staleFlags.length > 0 ? 'stale' : 'ready';

    return {
      status: allHealthy ? status : 'degraded',
      localmem,
      benchmarks,
      governance,
      deployment: buildDeploymentSummary(),
      stale_flags: staleFlags,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 检查本地记忆模块健康状态
   * @returns {object} { healthy: boolean, stats?: object, db?: object, error?: string }
   */
  healthLocalmem() {
    try {
      const store = this.memoryFacade.localMemory;
      const stats = store.stats ? store.stats() : {};
      const dbHealth = store._store && store._store.healthCheck ? store._store.healthCheck() : null;
      const walInfo = store._store && store._store.getWalSize ? store._store.getWalSize() : null;
      const healthy = dbHealth ? dbHealth.healthy : true;
      return {
        healthy,
        stats,
        db: dbHealth ? { wal_size_mb: walInfo?.walSizeMb, tables: dbHealth.tables } : null,
      };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }

  /**
   * 检查基准测试模块健康状态
   * @returns {object} { healthy: boolean, latest_benchmark?: object, error?: string }
   */
  healthBenchmarks() {
    try {
      const latest = this.benchmarkFacade.latestBenchmark();
      let stale = false;
      if (latest?.executed_at) {
        const ageHours = (Date.now() - new Date(latest.executed_at).getTime()) / (1000 * 60 * 60);
        stale = ageHours > 24;
      }
      return {
        healthy: true,
        available: true,
        latest_benchmark: latest,
        stale,
      };
    } catch (err) {
      return { healthy: false, available: false, stale: false, error: err.message };
    }
  }
}

export default HealthFacade;
