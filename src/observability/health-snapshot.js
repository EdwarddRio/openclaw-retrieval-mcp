/**
 * Health snapshot builder.
 */

export function buildHealthSnapshot({ collections, localmem, benchmarks, chroma, embedding }) {
  const allHealthy =
    (collections?.healthy !== false) &&
    (localmem?.healthy !== false) &&
    (chroma?.healthy !== false) &&
    (embedding?.healthy !== false);

  return {
    status: allHealthy ? 'healthy' : 'degraded',
    components: {
      collections: collections || { healthy: false },
      localmem: localmem || { healthy: false },
      benchmarks: benchmarks || { healthy: false },
      chroma: chroma || { healthy: false },
      embedding: embedding || { healthy: false },
    },
    timestamp: new Date().toISOString(),
  };
}

export default { buildHealthSnapshot };
