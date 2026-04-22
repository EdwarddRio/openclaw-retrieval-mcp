/**
 * Health facade - aggregates health status from all components.
 */

import { getChromaClient } from '../vector/chroma-client.js';
import { getEmbeddingClient } from '../vector/embedding-client.js';
import { buildDeploymentSummary } from '../config.js';

export class HealthFacade {
  constructor(searchFacade, memoryFacade, benchmarkFacade) {
    this.searchFacade = searchFacade;
    this.memoryFacade = memoryFacade;
    this.benchmarkFacade = benchmarkFacade;
  }

  async healthSnapshot() {
    const [collections, localmem, benchmarks, chromaHealth, embeddingHealth] = await Promise.all([
      this.healthCollections(),
      this.healthLocalmem(),
      this.healthBenchmarks(),
      getChromaClient().health(),
      getEmbeddingClient().health(),
    ]);

    const allHealthy = collections.healthy && localmem.healthy && chromaHealth.healthy && embeddingHealth.healthy;

    // Build governance summary
    const reviewItems = this.memoryFacade.listMemoryReviews ? this.memoryFacade.listMemoryReviews(200) : [];
    const wikiCandidateCount = reviewItems.filter(item => item.state === 'wiki_candidate').length;
    const governance = {
      pending_review_count: reviewItems.length,
      wiki_candidate_count: wikiCandidateCount,
    };

    const staleFlags = [];
    if (benchmarks.available === false) staleFlags.push('benchmark_missing');
    else if (benchmarks.stale) staleFlags.push('benchmark_stale');
    if (governance.pending_review_count > 0) staleFlags.push('review_queue_backlog');

    const degraded = Object.values(collections.collections || {}).some(c => c.state === 'warming' || c.state === 'error' || c.degraded);
    const status = degraded ? 'degraded' : (staleFlags.length > 0 ? 'stale' : 'ready');

    return {
      status: allHealthy ? status : 'degraded',
      collections,
      localmem,
      governance,
      benchmarks,
      chroma: chromaHealth,
      embedding: embeddingHealth,
      deployment: buildDeploymentSummary(),
      runtime_stats: { available: false },
      stale_flags: staleFlags,
      timestamp: new Date().toISOString(),
    };
  }

  async healthCollections() {
    try {
      const stats = await this.searchFacade.stats();
      return {
        healthy: true,
        collections: stats,
      };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
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
