/**
 * Health snapshot builder.
 * ChromaDB and Embedding components removed — retrieval is BM25-only.
 */

export function buildHealthSnapshot({ collections, localmem, benchmarks }) {
  const allHealthy =
    (collections?.healthy !== false) &&
    (localmem?.healthy !== false);

  return {
    status: allHealthy ? 'healthy' : 'degraded',
    components: {
      collections: collections || { healthy: false },
      localmem: localmem || { healthy: false },
      benchmarks: benchmarks || { healthy: false },
      retrieval_mode: 'bm25_only',
    },
    timestamp: new Date().toISOString(),
  };
}

export default { buildHealthSnapshot };
