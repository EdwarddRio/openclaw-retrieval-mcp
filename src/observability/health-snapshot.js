/**
 * Health snapshot builder.
 * Architecture: localMem (SQLite) + LLMWiki (keyword search, compiled pages).
 */

/**
 * 构建系统健康快照
 * @param {object} params - 各组件的健康状态
 * @param {object} [params.localmem] - localmem 组件健康状态
 * @param {object} [params.benchmarks] - benchmark 组件健康状态
 * @param {object} [params.wiki] - wiki 组件健康状态
 * @returns {object} 包含 status/components/timestamp 的健康快照
 */
export function buildHealthSnapshot({ localmem, benchmarks, wiki }) {
  const allHealthy =
    (localmem?.healthy !== false) &&
    (benchmarks?.healthy !== false);

  return {
    status: allHealthy ? 'healthy' : 'degraded',
    components: {
      localmem: localmem || { healthy: false },
      benchmarks: benchmarks || { healthy: false },
      wiki: wiki || { healthy: false },
      retrieval_mode: 'wiki_search',
    },
    timestamp: new Date().toISOString(),
  };
}

export default { buildHealthSnapshot };
