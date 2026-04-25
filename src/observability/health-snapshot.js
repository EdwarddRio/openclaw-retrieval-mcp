/**
 * Health snapshot builder.
 * Architecture: localMem (SQLite) + LLMWiki (keyword search, compiled pages).
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
