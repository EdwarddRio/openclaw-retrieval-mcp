/**
 * Maximal Marginal Relevance (MMR) reranking.
 * Token-based Jaccard MMR with intent awareness.
 */

import { tokenize } from './tokenizer.js';

const MMR_DISABLED_INTENTS = new Set(['exactsymbol', 'path']);

function _tokenSet(text) {
  return new Set(tokenize(text));
}

/**
 * Calculate Jaccard similarity between two token sets.
 */
export function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA || !tokensB || tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Determine if MMR should be applied based on query characteristics and result duplicates.
 */
export function shouldApplyMmr(results, options = {}) {
  const {
    queryIntent = null,
    minResults = 3,
    duplicateFloor = 0.35,
    disabledIntents = null,
  } = options;

  const disabled = disabledIntents || MMR_DISABLED_INTENTS;
  const intent = String(queryIntent || '').toLowerCase().trim();
  if (disabled.has(intent)) {
    return { applied: false, reason: 'intentDisabled' };
  }
  if (!results || results.length < Math.max(minResults, 1)) {
    return { applied: false, reason: 'tooFewResults' };
  }

  const tokenSets = results.map(result => _tokenSet(result.content || ''));
  let duplicatePairs = 0;
  let totalPairs = 0;

  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      totalPairs++;
      if (jaccardSimilarity(tokenSets[i], tokenSets[j]) >= duplicateFloor) {
        duplicatePairs++;
      }
    }
  }

  const duplicateRatio = totalPairs > 0 ? duplicatePairs / totalPairs : 0;
  if (duplicateRatio <= 0) {
    return { applied: false, reason: 'lowDuplicateRatio', duplicateRatio: 0 };
  }
  return {
    applied: true,
    reason: 'duplicateCandidates',
    duplicateRatio: Math.round(duplicateRatio * 10000) / 10000,
  };
}

/**
 * Token-based MMR reranking using Jaccard similarity on tokenized content.
 */
export function mmrRerank(results, options = {}) {
  const {
    lambda = 0.7,
    threshold = 0.85,
    topK = null,
    queryIntent = null,
    minResults = 3,
    duplicateFloor = 0.35,
    disabledIntents = null,
  } = options;

  if (!results || results.length <= 1) return [...results];

  const decision = shouldApplyMmr(results, {
    queryIntent,
    minResults,
    duplicateFloor,
    disabledIntents,
  });
  if (!decision.applied) {
    const limit = topK || results.length;
    return [...results].slice(0, limit);
  }

  const k = topK || results.length;
  const maxScore = Math.max(...results.map(r => r.score || 0), 1);
  const tokenSets = results.map(result => _tokenSet(result.content || ''));

  const selectedIndices = [];
  const remaining = new Set(Array.from({ length: results.length }, (_, i) => i));

  selectedIndices.push(0);
  remaining.delete(0);

  while (selectedIndices.length < k && remaining.size > 0) {
    let bestIndex = -1;
    let bestMmrScore = -Infinity;

    for (const idx of remaining) {
      const relevance = (results[idx].score || 0) / maxScore;

      let maxSim = 0;
      for (const selIdx of selectedIndices) {
        const sim = jaccardSimilarity(tokenSets[idx], tokenSets[selIdx]);
        if (sim > maxSim) maxSim = sim;
      }

      let mmrScore;
      if (maxSim >= threshold) {
        mmrScore = lambda * relevance - (1 - lambda) * maxSim - 1;
      } else {
        mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      }

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIndex = idx;
      }
    }

    if (bestIndex < 0) break;

    selectedIndices.push(bestIndex);
    remaining.delete(bestIndex);
  }

  return selectedIndices.map(idx => results[idx]);
}

export default {
  mmrRerank,
  shouldApplyMmr,
  jaccardSimilarity,
};
