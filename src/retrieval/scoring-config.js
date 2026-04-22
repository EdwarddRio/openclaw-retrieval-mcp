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
    this.rulesProfileFileAggregationWeight = options.rulesProfileFileAggregationWeight ?? 0.12;
    this.rulesProfileFileAggregationCap = options.rulesProfileFileAggregationCap ?? 0.015;
    this.rulesProfilePathMatchBonus = options.rulesProfilePathMatchBonus ?? 0.002;

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
    return new ScoringConfig({
      denseDefaultWeight: envFloat('SCORING_DENSE_DEFAULT_WEIGHT', 1.0),
      bm25DefaultWeight: envFloat('SCORING_BM25_DEFAULT_WEIGHT', 1.0),
      denseExactWeight: envFloat('SCORING_DENSE_EXACT_WEIGHT', 0.45),
      bm25ExactWeight: envFloat('SCORING_BM25_EXACT_WEIGHT', 2.2),
      densePathWeight: envFloat('SCORING_DENSE_PATH_WEIGHT', 0.4),
      bm25PathWeight: envFloat('SCORING_BM25_PATH_WEIGHT', 2.0),
      denseErrorWeight: envFloat('SCORING_DENSE_ERROR_WEIGHT', 0.75),
      bm25ErrorWeight: envFloat('SCORING_BM25_ERROR_WEIGHT', 1.5),
      denseConfigWeight: envFloat('SCORING_DENSE_CONFIG_WEIGHT', 0.6),
      bm25ConfigWeight: envFloat('SCORING_BM25_CONFIG_WEIGHT', 1.8),
      variantPrimaryWeight: envFloat('SCORING_VARIANT_PRIMARY_WEIGHT', 1.0),
      variantSimplifiedWeight: envFloat('SCORING_VARIANT_SIMPLIFIED_WEIGHT', 0.92),
      variantExactSymbolWeight: envFloat('SCORING_VARIANT_EXACT_SYMBOL_WEIGHT', 1.35),
      variantSymbolContextWeight: envFloat('SCORING_VARIANT_SYMBOL_CONTEXT_WEIGHT', 0.88),
      variantSplitSymbolWeight: envFloat('SCORING_VARIANT_SPLIT_SYMBOL_WEIGHT', 0.78),
      variantAliasWeight: envFloat('SCORING_VARIANT_ALIAS_WEIGHT', 0.85),
      symbolTitleExact: envFloat('SCORING_SYMBOL_TITLE_EXACT', 0.06),
      symbolTitleContains: envFloat('SCORING_SYMBOL_TITLE_CONTAINS', 0.04),
      symbolSourceContains: envFloat('SCORING_SYMBOL_SOURCE_CONTAINS', 0.035),
      symbolContentContains: envFloat('SCORING_SYMBOL_CONTENT_CONTAINS', 0.02),
      symbolSplitContent: envFloat('SCORING_SYMBOL_SPLIT_CONTENT', 0.012),
      tokenTitleWeight: envFloat('SCORING_TOKEN_TITLE_WEIGHT', 0.008),
      tokenSourceWeight: envFloat('SCORING_TOKEN_SOURCE_WEIGHT', 0.004),
      tokenContentWeight: envFloat('SCORING_TOKEN_CONTENT_WEIGHT', 0.004),
      tokenHitCap: envInt('SCORING_TOKEN_HIT_CAP', 6),
      codeIntentBonus: envFloat('SCORING_CODE_INTENT_BONUS', 0.015),
      ruleIntentBonus: envFloat('SCORING_RULE_INTENT_BONUS', 0.01),
      pathHintBonus: envFloat('SCORING_PATH_HINT_BONUS', 0.03),
      collectionHintBonus: envFloat('SCORING_COLLECTION_HINT_BONUS', 0.012),
      exactMatchBonus: envFloat('SCORING_EXACT_MATCH_BONUS', 0.02),
      fileAggregationWeight: envFloat('SCORING_FILE_AGG_WEIGHT', 0.35),
      fileAggregationCap: envFloat('SCORING_FILE_AGG_CAP', 0.04),
      rulesProfileFileAggregationWeight: envFloat('SCORING_RULES_PROFILE_FILE_AGG_WEIGHT', 0.12),
      rulesProfileFileAggregationCap: envFloat('SCORING_RULES_PROFILE_FILE_AGG_CAP', 0.015),
      rulesProfilePathMatchBonus: envFloat('SCORING_RULES_PATH_MATCH_BONUS', 0.002),
      rrfK: envInt('SCORING_RRF_K', 60),
      mmrEnabled: envBool('SCORING_MMR_ENABLED', true),
      mmrLambda: envFloat('SCORING_MMR_LAMBDA', 0.7),
      mmrThreshold: envFloat('SCORING_MMR_THRESHOLD', 0.85),
      mmrMinResults: envInt('SCORING_MMR_MIN_RESULTS', 3),
      mmrDuplicateFloor: envFloat('SCORING_MMR_DUPLICATE_FLOOR', 0.35),
      mmrDisableExactIntent: envBool('SCORING_MMR_DISABLE_EXACT_INTENT', true),
      mmrDisablePathIntent: envBool('SCORING_MMR_DISABLE_PATH_INTENT', true),
    });
  }
}

const DEFAULT_SCORING = ScoringConfig.load();

export { DEFAULT_SCORING };
export default ScoringConfig;
