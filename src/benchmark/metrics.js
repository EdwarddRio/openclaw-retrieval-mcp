/**
 * Benchmark metrics: hit rate, recall, diversity.
 * Aligned with rule-engine evaluation/metrics.py.
 */

import { tokenize } from '../retrieval/tokenizer.js';

/**
 * Compute hit rate: fraction of expected hits that appear in results.
 */
export function computeHitRate(results, expectedHits) {
  if (!expectedHits || expectedHits.length === 0) return null;
  let hits = 0;
  for (const expected of expectedHits) {
    const pattern = expected.toLowerCase();
    const matched = results.some(r => {
      const source = String(r.source || '').toLowerCase();
      const title = String(r.title || '').toLowerCase();
      const content = String(r.content || '').toLowerCase();
      return source.includes(pattern) || title.includes(pattern) || content.includes(pattern);
    });
    if (matched) hits++;
  }
  return hits / expectedHits.length;
}

/**
 * Compute recall: fraction of expected recalls that appear in results.
 * (synonymous with hit rate in many contexts, but kept separate for semantic clarity)
 */
export function computeRecall(results, expectedRecalls) {
  if (!expectedRecalls || expectedRecalls.length === 0) return null;
  return computeHitRate(results, expectedRecalls);
}

/**
 * Compute diversity using Jaccard dissimilarity of token sets.
 * Higher = more diverse.
 */
export function computeDiversity(results) {
  if (!results || results.length <= 1) return 1.0;

  const tokenSets = results.map(r => {
    const text = `${r.title || ''} ${r.content || ''}`;
    return new Set(tokenize(text));
  });

  let totalDissimilarity = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const a = tokenSets[i];
      const b = tokenSets[j];
      const intersection = new Set([...a].filter(x => b.has(x)));
      const union = new Set([...a, ...b]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      totalDissimilarity += 1 - jaccard;
      pairs++;
    }
  }

  return pairs > 0 ? totalDissimilarity / pairs : 1.0;
}

/**
 * Aggregate metrics across cases.
 */
export function aggregateMetrics(caseResults) {
  const hitRates = caseResults.map(c => c.hit_rate).filter(v => v !== null);
  const recalls = caseResults.map(c => c.recall).filter(v => v !== null);
  const diversities = caseResults.map(c => c.diversity).filter(v => v !== null);
  const passRates = caseResults.map(c => c.passed);

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    case_count: caseResults.length,
    pass_count: passRates.filter(Boolean).length,
    pass_rate: passRates.length ? passRates.filter(Boolean).length / passRates.length : 0,
    avg_hit_rate: avg(hitRates),
    avg_recall: avg(recalls),
    avg_diversity: avg(diversities),
    min_hit_rate: hitRates.length ? Math.min(...hitRates) : 0,
    max_hit_rate: hitRates.length ? Math.max(...hitRates) : 0,
  };
}
