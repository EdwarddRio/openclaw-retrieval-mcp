/**
 * Scoring configuration for search result ranking.
 */

import { logger } from '../config.js';

// ========== Environment variable helpers ==========

function envFloat(key, defaultValue) {
  const value = process.env[key];
  if (value !== undefined && value !== null) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  return defaultValue;
}

function envBool(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === null) return defaultValue;
  const lower = String(value).trim().toLowerCase();
  return !(lower === '0' || lower === 'false' || lower === 'no' || lower === 'off' || lower === '');
}

function envInt(key, defaultValue) {
  const value = process.env[key];
  if (value !== undefined && value !== null) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return defaultValue;
}

// ========== ScoringConfig Class ==========

export class ScoringConfig {
  constructor(options = {}) {
    // Dense/BM25 weights by intent
    this.denseDefaultWeight = options.denseDefaultWeight ?? 1.0;
    this.bm25DefaultWeight = options.bm25DefaultWeight ?? 1.0;
    this.denseExactWeight = options.denseExactWeight ?? 0.45;
    this.bm25ExactWeight = options.bm25ExactWeight ?? 2.2;
    this.densePathWeight = options.densePathWeight ?? 0.4;
    this.bm25PathWeight = options.bm25PathWeight ?? 2.0;
    this.denseErrorWeight = options.denseErrorWeight ?? 0.75;
    this.bm25ErrorWeight = options.bm25ErrorWeight ?? 1.5;
    this.denseConfigWeight = options.denseConfigWeight ?? 0.6;
    this.bm25ConfigWeight = options.bm25ConfigWeight ?? 1.8;

    // Variant weights
    this.variantPrimaryWeight = options.variantPrimaryWeight ?? 1.0;
    this.variantSimplifiedWeight = options.variantSimplifiedWeight ?? 0.92;
    this.variantExactSymbolWeight = options.variantExactSymbolWeight ?? 1.35;
    this.variantSymbolContextWeight = options.variantSymbolContextWeight ?? 0.88;
    this.variantSplitSymbolWeight = options.variantSplitSymbolWeight ?? 0.78;
    this.variantAliasWeight = options.variantAliasWeight ?? 0.85;

    // Symbol matching bonuses
    this.symbolTitleExact = options.symbolTitleExact ?? 0.06;
    this.symbolTitleContains = options.symbolTitleContains ?? 0.04;
    this.symbolSourceContains = options.symbolSourceContains ?? 0.035;
    this.symbolContentContains = options.symbolContentContains ?? 0.02;
    this.symbolSplitContent = options.symbolSplitContent ?? 0.012;

    // Token matching weights
    this.tokenTitleWeight = options.tokenTitleWeight ?? 0.008;
    this.tokenSourceWeight = options.tokenSourceWeight ?? 0.004;
    this.tokenContentWeight = options.tokenContentWeight ?? 0.004;
    this.tokenHitCap = options.tokenHitCap ?? 6;

    // Intent bonuses
    this.codeIntentBonus = options.codeIntentBonus ?? 0.015;
    this.ruleIntentBonus = options.ruleIntentBonus ?? 0.01;

    // Hint bonuses
    this.pathHintBonus = options.pathHintBonus ?? 0.03;
    this.collectionHintBonus = options.collectionHintBonus ?? 0.012;

    // Exact match bonus
    this.exactMatchBonus = options.exactMatchBonus ?? 0.02;

    // File aggregation
    this.fileAggregationWeight = options.fileAggregationWeight ?? 0.35;
    this.fileAggregationCap = options.fileAggregationCap ?? 0.04;
    // RRF K
    this.rrfK = options.rrfK ?? 60;

    // MMR parameters
    this.mmrEnabled = options.mmrEnabled ?? true;
    this.mmrLambda = options.mmrLambda ?? 0.7;
    this.mmrThreshold = options.mmrThreshold ?? 0.85;
    this.mmrMinResults = options.mmrMinResults ?? 3;
    this.mmrDuplicateFloor = options.mmrDuplicateFloor ?? 0.35;
    this.mmrDisableExactIntent = options.mmrDisableExactIntent ?? true;
    this.mmrDisablePathIntent = options.mmrDisablePathIntent ?? true;
  }

  static load() {
    // Only 5 core env vars; everything else uses hardcoded defaults.
    return new ScoringConfig({
      denseDefaultWeight: envFloat('SCORING_DENSE_DEFAULT_WEIGHT', 1.0),
      bm25DefaultWeight: envFloat('SCORING_BM25_DEFAULT_WEIGHT', 1.0),
      rrfK: envInt('SCORING_RRF_K', 60),
      mmrEnabled: envBool('SCORING_MMR_ENABLED', true),
      mmrLambda: envFloat('SCORING_MMR_LAMBDA', 0.7),
    });
  }
}

const DEFAULT_SCORING = ScoringConfig.load();

export { DEFAULT_SCORING };
export default ScoringConfig;
