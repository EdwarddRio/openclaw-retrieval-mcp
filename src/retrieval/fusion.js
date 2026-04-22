/**
 * Reciprocal Rank Fusion (RRF) implementation.
 * Full RRF with perCollection, crossCollection, listWeights, and minListWeight.
 */

import { RRF_K } from '../config.js';

// ========== Result key helper ==========

function resultKey(result) {
  if (result.chunkId) return String(result.chunkId);
  return `${result.collection || ''}::${result.source || ''}::${result.title || ''}::${result.docType || ''}::${String(result.content || '').slice(0, 120)}`;
}

// ========== Core RRF ==========

/**
 * Fuse multiple ranked lists using RRF with configurable weights.
 */
export function rrfFuse(resultLists, rrfK = 60, keyFn = null, listWeights = null, minListWeight = 0.25) {
  if (!resultLists || resultLists.length === 0) return [];

  const keyFunction = keyFn || resultKey;
  const scores = new Map();
  const best = new Map();

  const weights = listWeights || [];
  for (let listIndex = 0; listIndex < resultLists.length; listIndex++) {
    const results = resultLists[listIndex];
    const weight = listIndex < weights.length ? weights[listIndex] : 1;
    if (weight <= 0 || weight < minListWeight) continue;

    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      if (!item) continue;
      const key = keyFunction(item);
      const currentScore = scores.get(key) || 0;
      scores.set(key, currentScore + (weight / (rrfK + rank + 1)));

      const existing = best.get(key);
      if (!existing || (item.score || 0) > (existing.score || 0)) {
        best.set(key, item);
      }
    }
  }

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const fused = [];
  for (const [key, score] of sorted) {
    const entry = { ...best.get(key) };
    entry.score = Math.round(score * 1000000) / 1000000;
    fused.push(entry);
  }
  return fused;
}

/**
 * Fuse results within each collection separately.
 */
export function fusePerCollection(variantResults, rrfK = 60, listWeightsByCollection = null) {
  const fused = {};
  for (const [collection, lists] of Object.entries(variantResults)) {
    if (!lists || lists.length === 0) {
      fused[collection] = [];
      continue;
    }
    fused[collection] = rrfFuse(
      lists,
      rrfK,
      null,
      listWeightsByCollection ? listWeightsByCollection[collection] : null,
    );
  }
  return fused;
}

/**
 * Fuse results across collections.
 */
export function fuseCrossCollection(perCollection, rrfK = 60) {
  const lists = Object.values(perCollection).filter(results => results && results.length > 0);
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0];

  function crossKey(result) {
    if (result.chunkId) return String(result.chunkId);
    return `${result.source || ''}::${result.title || ''}::${result.docType || ''}::${String(result.content || '').slice(0, 120)}`;
  }

  return rrfFuse(lists, rrfK, crossKey);
}

/**
 * Two-stage fusion: first fuse within each collection, then across collections.
 */
export function twoStageFuse(variantResults, rrfK = RRF_K, variantWeightsByCollection = null) {
  const perCol = fusePerCollection(variantResults, rrfK, variantWeightsByCollection);
  return fuseCrossCollection(perCol, rrfK);
}

export default {
  rrfFuse,
  fusePerCollection,
  fuseCrossCollection,
  twoStageFuse,
  resultKey,
};
