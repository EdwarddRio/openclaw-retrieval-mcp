/**
 * Benchmark metrics: hit rate, recall, diversity.
 * Aligned with rule-engine evaluation/metrics.py.
 */

/**
 * Simple tokenizer for benchmark diversity computation.
 * Replaces the removed retrieval/tokenizer.js dependency.
 */
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
}

/**
 * 计算命中率：期望命中项在结果中出现的比例
 * @param {Array} results - 搜索结果列表
 * @param {string[]} expectedHits - 期望命中的模式列表
 * @returns {number|null} 命中率 (0-1)，无期望时返回 null
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
 * 计算召回率：期望召回项在结果中出现的比例
 * （与命中率语义相似，但保留独立接口以区分语义）
 * @param {Array} results - 搜索结果列表
 * @param {string[]} expectedRecalls - 期望召回的模式列表
 * @returns {number|null} 召回率 (0-1)，无期望时返回 null
 */
export function computeRecall(results, expectedRecalls) {
  if (!expectedRecalls || expectedRecalls.length === 0) return null;
  return computeHitRate(results, expectedRecalls);
}

/**
 * 使用 Jaccard 相异度计算结果多样性
 * 值越高表示结果越多样化
 * @param {Array} results - 搜索结果列表
 * @returns {number} 多样性分数 (0-1)
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
 * 汇总所有用例的指标，计算平均值和极值
 * @param {Array} caseResults - 各用例结果列表
 * @returns {Object} 汇总指标（含 case_count, pass_rate, avg_hit_rate 等）
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
