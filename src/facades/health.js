/**
 * Health facade - aggregates health status from all components.
 * localMem + LLMWiki architecture — no static_kb/BM25.
 */

import { buildDeploymentSummary } from '../config.js';

export class HealthFacade {
  constructor(memoryFacade, benchmarkFacade) {
    this.memoryFacade = memoryFacade;
    this.benchmarkFacade = benchmarkFacade;
  }

  async healthSnapshot() {
    const [localmem, benchmarks] = await Promise.all([
      this.healthLocalmem(),
      this.healthBenchmarks(),
    ]);

    const allHealthy = localmem.healthy;

    const staleFlags = [];
    if (benchmarks.available === false) staleFlags.push('benchmark_missing');
    else if (benchmarks.stale) staleFlags.push('benchmark_stale');

    const status = staleFlags.length > 0 ? 'stale' : 'ready';

    return {
      status: allHealthy ? status : 'degraded',
      localmem,
      benchmarks,
      deployment: buildDeploymentSummary(),
      stale_flags: staleFlags,
      timestamp: new Date().toISOString(),
    };
  }

  healthLocalmem() {
    try {
      const store = this.memoryFacade.localMemory;
      const stats = store.stats ? store.stats() : {};
      return {
        healthy: true,
        stats,
      };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }

  healthBenchmarks() {
    try {
      const latest = this.benchmarkFacade.latestBenchmark();
      return {
        healthy: true,
        latest_benchmark: latest,
      };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }
}

export default HealthFacade;
