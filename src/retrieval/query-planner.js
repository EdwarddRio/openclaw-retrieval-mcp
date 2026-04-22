/**
 * Query planner - intent detection, query variant generation, collection routing,
 * and result reranking.
 */

import { 
  CODE_QUERY_KEYWORDS, 
  COLLECTION_CANDIDATE_LIMIT, 
  DOC_TYPE_TO_COLLECTION, 
  INDEX_COLLECTIONS, 
  MAX_QUERY_VARIANTS 
} from '../config.js';
import { DEFAULT_SCORING } from './scoring-config.js';
import { tokenize } from './tokenizer.js';

// ========== Intent Detection Constants ==========

const CAMEL_CASE_RE = /\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const SNAKE_CASE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;
const PATHISH_RE = /[\\\/]|\.java\b|\.py\b|\.ts\b|\.go\b|\.rs\b|\.mdc?\b/gi;
const STOP_PHRASES = [
  '这个实现在哪', '实现在哪', '在哪里', '在哪',
  '怎么实现', '如何实现', '配置规则', '相关规则',
];

const CODE_COLLECTION = 'code';
const RULES_COLLECTION = 'static_kb';

const CODE_SYMBOL_SUFFIXES = [
  'service', 'action', 'mapper', 'configmanager', 'impl',
  'controller', 'handler', 'manager', 'provider', 'factory',
  'repository', 'component', 'module', 'middleware',
];
const RULE_INTENT_KEYWORDS = ['规则', '规范', '约定', 'rule', 'convention'];
const ERROR_INTENT_KEYWORDS = ['报错', '异常', 'error', 'exception', 'traceback', 'stacktrace'];
const CONFIG_INTENT_KEYWORDS = ['配置', 'config', 'yaml', 'json', '.env'];
const SYMBOL_LOOKUP_HINTS = ['实现', '调用', '在哪里', '在哪', '函数', '方法', '类', 'symbol', 'def'];
const RULES_PROFILE_PATH_HINTS = [
  '.cursor/rules', '.mdc', 'memory.md', 'session-state.md', 'soul.md', 'user.md',
];
const RULES_PROFILE_HINTS = [
  'localmem', 'session', 'fact', 'governance', 'transcript',
  'reviewqueue', 'promotioncandidate', 'shouldabstain',
  'evidencechains', 'lazy', 'collection', '按需加载',
];
const RULES_PROFILE_STRONG_HINTS = [
  'cursor机器人', '志明', '称呼', '身份', 'savememory',
  'queryrules', 'querymemory', '记忆文件', '读取范围',
  '范围限制', '保持薄', '薄层',
];
const RULES_PROFILE_CANONICAL_VARIANTS = [
  { requiredHints: ['记忆文件', '范围'], anchor: 'memory scope' },
  { requiredHints: ['读取范围'], anchor: 'memory scope' },
  { requiredHints: ['范围限制'], anchor: 'memory scope' },
  { requiredHints: ['savememory', 'localmem'], anchor: 'savememory localmem' },
  { requiredHints: ['queryrules'], anchor: 'query rules' },
  { requiredHints: ['querymemory'], anchor: 'query memory' },
  { requiredHints: ['mcp', '保持薄'], anchor: 'mcp thin layer' },
  { requiredHints: ['mcp', '薄层'], anchor: 'mcp thin layer' },
];

// ========== SearchPlan Class ==========

export class SearchPlan {
  constructor(options) {
    this.rawQuery = options.rawQuery;
    this.normalizedQuery = options.normalizedQuery;
    this.variants = options.variants;
    this.variantWeights = options.variantWeights;
    this.symbols = options.symbols;
    this.collections = options.collections;
    this.docType = options.docType;
    this.candidateLimit = options.candidateLimit;
    this.queryIntent = options.queryIntent;
  }
}

// ========== Search Plan Builder ==========

export function buildSearchPlan(query, docType = null, topK = null, memoryContext = null) {
  const normalized = _normalizeQuery(query);
  const symbols = _extractSymbols(normalized);
  const filteredMemoryContext = _planningMemoryContext(memoryContext);
  const queryIntent = _classifyQueryIntent(normalized, symbols);
  const { variants, variantWeights } = _buildVariants(
    normalized,
    symbols,
    queryIntent,
    filteredMemoryContext,
  );
  
  const limitedVariants = variants.slice(0, MAX_QUERY_VARIANTS);
  const limitedVariantWeights = {};
  for (const variant of limitedVariants) {
    limitedVariantWeights[variant] = variantWeights[variant] || 1;
  }
  
  const collections = _routeCollections(
    normalized,
    docType,
    symbols,
    queryIntent,
    filteredMemoryContext,
  );
  
  const candidateLimit = Math.max(
    COLLECTION_CANDIDATE_LIMIT,
    (topK || 0) * 2 || COLLECTION_CANDIDATE_LIMIT,
  );
  
  return new SearchPlan({
    rawQuery: query,
    normalizedQuery: normalized,
    variants: limitedVariants,
    variantWeights: limitedVariantWeights,
    symbols,
    collections,
    docType,
    candidateLimit,
    queryIntent,
  });
}

// ========== Result Reranking ==========

export function rerankResults(plan, results, topK, memoryContext = null, scoring = null) {
  const cfg = scoring || DEFAULT_SCORING;
  const filteredMemoryContext = _planningMemoryContext(memoryContext);
  
  const seen = new Map();
  for (const result of results) {
    const key = _resultKey(result);
    const existing = seen.get(key);
    if (!existing || result.score > existing.score) {
      seen.set(key, { ...result });
    }
  }
  
  const fileGroups = new Map();
  for (const result of seen.values()) {
    const { rerankScore, breakdown } = _rerankScore(plan, result, filteredMemoryContext, cfg);
    const enriched = { ...result, _rerankScore: rerankScore, _scoreBreakdown: breakdown };
    const fileKey = _fileKey(enriched);
    if (!fileGroups.has(fileKey)) {
      fileGroups.set(fileKey, []);
    }
    fileGroups.get(fileKey).push(enriched);
  }
  
  const ranked = [];
  let aggWeight = cfg.fileAggregationWeight;
  let aggCap = cfg.fileAggregationCap;
  
  if (_isRulesProfilePlan(plan)) {
    aggWeight = cfg.rulesProfileFileAggregationWeight;
    aggCap = cfg.rulesProfileFileAggregationCap;
  }
  
  for (const group of fileGroups.values()) {
    group.sort((a, b) => b._rerankScore - a._rerankScore);
    const primary = { ...group[0] };
    
    let siblingBonus = 0;
    for (let i = 1; i < group.length; i++) {
      siblingBonus += group[i]._rerankScore;
    }
    siblingBonus = Math.min(siblingBonus * aggWeight, aggCap);
    
    primary.matchedChunks = group.length;
    primary.score = Math.round((primary._rerankScore + siblingBonus) * 10000) / 10000;
    primary.scoreBreakdown = { ...primary._scoreBreakdown };
    if (siblingBonus) {
      primary.scoreBreakdown.fileAggregationBonus = Math.round(siblingBonus * 10000) / 10000;
    }
    delete primary._rerankScore;
    delete primary._scoreBreakdown;
    ranked.push(primary);
  }
  
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK);
}

// ========== Internal Helper Functions ==========

function _planningMemoryContext(memoryContext) {
  if (!memoryContext) return {};
  if (memoryContext.confidenceApplied !== false) {
    return { ...memoryContext };
  }
  return {
    ...memoryContext,
    aliases: [],
    pathHints: [],
    collectionHints: [],
  };
}

function _normalizeQuery(query) {
  let normalized = query.replace(/`/g, ' ').replace(/"/g, ' ').replace(/'/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

function _extractSymbols(query) {
  const symbols = [];
  const patterns = [CAMEL_CASE_RE, SNAKE_CASE_RE];
  for (const pattern of patterns) {
    const matches = query.match(pattern) || [];
    for (const match of matches) {
      if (!symbols.includes(match)) symbols.push(match);
    }
  }
  return symbols;
}

function _buildVariants(normalizedQuery, symbols, queryIntent, memoryContext = null) {
  const cfg = DEFAULT_SCORING;
  const variants = [normalizedQuery];
  const variantWeights = { [normalizedQuery]: cfg.variantPrimaryWeight };

  let simplified = normalizedQuery;
  for (const phrase of STOP_PHRASES) {
    simplified = simplified.replace(phrase, ' ');
  }
  simplified = simplified.replace(/\s+/g, ' ').trim();
  if (simplified && !variants.includes(simplified)) {
    variants.push(simplified);
    variantWeights[simplified] = cfg.variantSimplifiedWeight;
  }

  for (const anchorVariant of _rulesProfileAnchorVariants(normalizedQuery)) {
    if (!variants.includes(anchorVariant)) {
      variants.push(anchorVariant);
      variantWeights[anchorVariant] = cfg.variantAliasWeight;
    }
  }

  for (const symbol of symbols) {
    if (!variants.includes(symbol)) {
      variants.push(symbol);
      if (queryIntent === 'exactsymbol' || queryIntent === 'configkey') {
        variantWeights[symbol] = cfg.variantExactSymbolWeight;
      } else if (queryIntent === 'symbollookup') {
        variantWeights[symbol] = cfg.variantSymbolContextWeight;
      } else {
        variantWeights[symbol] = cfg.variantPrimaryWeight;
      }
    }

    const splitSymbol = _splitSymbol(symbol);
    if (splitSymbol && !variants.includes(splitSymbol)) {
      variants.push(splitSymbol);
      variantWeights[splitSymbol] = cfg.variantSplitSymbolWeight;
    }
  }

  const aliases = (memoryContext || {}).aliases || [];
  for (const alias of aliases) {
    if (alias && !variants.includes(alias)) {
      variants.push(alias);
      variantWeights[alias] = cfg.variantAliasWeight;
    }

    const splitAlias = _splitSymbol(alias);
    if (splitAlias && !variants.includes(splitAlias)) {
      variants.push(splitAlias);
      variantWeights[splitAlias] = cfg.variantSplitSymbolWeight;
    }
  }

  return { variants, variantWeights };
}

function _routeCollections(normalizedQuery, docType, symbols, queryIntent, memoryContext = null) {
  if (docType) {
    const target = DOC_TYPE_TO_COLLECTION[docType];
    if (target && target in INDEX_COLLECTIONS) return [target];
  }

  const collections = Object.entries(INDEX_COLLECTIONS)
    .filter(([_, config]) => !config.lazy)
    .map(([name, _]) => name);

  if (CODE_COLLECTION in INDEX_COLLECTIONS && !collections.includes(CODE_COLLECTION)) {
    const lowered = normalizedQuery.toLowerCase();
    if (queryIntent === 'exactsymbol' || queryIntent === 'path' || queryIntent === 'error') {
      collections.push(CODE_COLLECTION);
    } else if (CODE_QUERY_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) {
      collections.push(CODE_COLLECTION);
    } else if (symbols.some(_looksLikeCodeSymbol)) {
      collections.push(CODE_COLLECTION);
    }
  }

  const hintedCollections = (memoryContext || {}).collectionHints || [];
  for (const hintedCollection of hintedCollections) {
    if (hintedCollection && hintedCollection in INDEX_COLLECTIONS && !collections.includes(hintedCollection)) {
      collections.push(hintedCollection);
    }
  }

  return collections;
}

function _splitSymbol(symbol) {
  if (symbol.includes('_')) return symbol.replace(/_/g, ' ');
  const pieces = symbol.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) || [];
  return pieces.length > 1 ? pieces.join(' ') : '';
}

function _looksLikeCodeSymbol(symbol) {
  const lowered = symbol.toLowerCase();
  return CODE_SYMBOL_SUFFIXES.some(suffix => lowered.endsWith(suffix));
}

function _classifyQueryIntent(normalizedQuery, symbols) {
  const lowered = normalizedQuery.toLowerCase();
  const rulesProfileQuery = _isRulesProfileQuery(normalizedQuery);

  if (PATHISH_RE.test(normalizedQuery)) {
    if (_isRulesProfilePathLookup(normalizedQuery)) return 'rulelookup';
    return 'path';
  }

  if (ERROR_INTENT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) return 'error';

  if (symbols.length > 0) {
    const exactSymbolLookup = _isExactSymbolLookup(normalizedQuery, symbols);
    if (rulesProfileQuery && !exactSymbolLookup) return 'symbollookup';
    if (exactSymbolLookup) return 'exactsymbol';
    if (CONFIG_INTENT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) return 'configkey';
    if (rulesProfileQuery) return 'symbollookup';
    return 'exactsymbol';
  }

  if (CONFIG_INTENT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) return 'configkey';
  if (rulesProfileQuery) return 'rulelookup';
  if (RULE_INTENT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) return 'rulelookup';

  return 'naturallanguage';
}

function _isExactSymbolLookup(normalizedQuery, symbols) {
  const lowered = normalizedQuery.toLowerCase();
  if (symbols.length === 1 && normalizedQuery.trim() === symbols[0]) return true;
  if (SYMBOL_LOOKUP_HINTS.some(hint => lowered.includes(hint.toLowerCase()))) return true;
  return CODE_QUERY_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()));
}

function _isRulesProfilePathLookup(normalizedQuery) {
  const lowered = normalizedQuery.toLowerCase();
  return RULES_PROFILE_PATH_HINTS.some(hint => lowered.includes(hint.toLowerCase()));
}

function _isRulesProfileQuery(normalizedQuery) {
  const lowered = normalizedQuery.toLowerCase();
  let score = 0;

  for (const hint of RULES_PROFILE_PATH_HINTS) {
    if (lowered.includes(hint.toLowerCase())) score += 2;
  }
  for (const hint of RULES_PROFILE_STRONG_HINTS) {
    if (lowered.includes(hint.toLowerCase())) score += 2;
  }
  for (const hint of RULES_PROFILE_HINTS) {
    if (lowered.includes(hint.toLowerCase())) score += 1;
  }
  if (RULE_INTENT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) score += 1;

  return score >= 2;
}

function _rulesProfileAnchorVariants(normalizedQuery) {
  const lowered = normalizedQuery.toLowerCase();
  const anchors = [];

  for (const { requiredHints, anchor } of RULES_PROFILE_CANONICAL_VARIANTS) {
    const allHintsPresent = requiredHints.every(hint => lowered.includes(hint.toLowerCase()));
    if (allHintsPresent && !anchors.includes(anchor)) anchors.push(anchor);
  }

  return anchors;
}

function _matchedRulesProfilePathHints(normalizedQuery, source) {
  const loweredQuery = normalizedQuery.toLowerCase();
  const loweredSource = source.toLowerCase();
  return RULES_PROFILE_PATH_HINTS.filter(hint => 
    loweredQuery.includes(hint.toLowerCase()) && loweredSource.includes(hint.toLowerCase())
  );
}

function _resultKey(result) {
  if (result.chunkId) return String(result.chunkId);
  const contentFingerprint = String(result.content || '').slice(0, 120);
  return `${result.collection || ''}::${result.source || ''}::${result.title || ''}::${result.docType || ''}::${contentFingerprint}`;
}

function _fileKey(result) {
  return `${result.collection || ''}::${result.source || ''}`;
}

function _rerankScore(plan, result, memoryContext = null, scoring = null) {
  const cfg = scoring || DEFAULT_SCORING;
  let score = parseFloat(result.score || 0);
  const breakdown = { baseScore: Math.round(score * 10000) / 10000 };

  const title = String(result.title || '');
  const source = String(result.source || '');
  const content = String(result.content || '');
  const titleLower = title.toLowerCase();
  const sourceLower = source.toLowerCase();
  const contentLower = content.toLowerCase();
  const normalizedLower = (plan.normalizedQuery || '').toLowerCase();
  const rulesProfileQuery = _isRulesProfilePlan(plan);

  // Symbol matching
  const symbols = plan.symbols || [];
  for (const symbol of symbols) {
    const symbolLower = symbol.toLowerCase();
    const splitLower = _splitSymbol(symbol).toLowerCase();

    if (titleLower === symbolLower) {
      score += cfg.symbolTitleExact;
      breakdown.symbolTitleExact = Math.round((breakdown.symbolTitleExact || 0) + cfg.symbolTitleExact * 10000) / 10000;
    } else if (titleLower.includes(symbolLower)) {
      score += cfg.symbolTitleContains;
      breakdown.symbolTitleContains = Math.round((breakdown.symbolTitleContains || 0) + cfg.symbolTitleContains * 10000) / 10000;
    }

    if (sourceLower.includes(symbolLower) && !rulesProfileQuery) {
      score += cfg.symbolSourceContains;
      breakdown.symbolSourceContains = Math.round((breakdown.symbolSourceContains || 0) + cfg.symbolSourceContains * 10000) / 10000;
    }

    if (contentLower.includes(symbolLower)) {
      score += cfg.symbolContentContains;
      breakdown.symbolContentContains = Math.round((breakdown.symbolContentContains || 0) + cfg.symbolContentContains * 10000) / 10000;
    } else if (splitLower && contentLower.includes(splitLower)) {
      score += cfg.symbolSplitContent;
      breakdown.symbolSplitContent = Math.round((breakdown.symbolSplitContent || 0) + cfg.symbolSplitContent * 10000) / 10000;
    }
  }

  // Token matching
  const queryTokens = _queryTokens(plan);
  let titleHits = 0;
  let sourceHits = 0;
  let contentHits = 0;

  for (const token of queryTokens) {
    if (titleLower.includes(token)) titleHits++;
    if (sourceLower.includes(token)) sourceHits++;
    if (rulesProfileQuery && contentLower.includes(token)) contentHits++;
  }

  const titleBonus = Math.min(titleHits, cfg.tokenHitCap) * cfg.tokenTitleWeight;
  let sourceWeight = cfg.tokenSourceWeight;
  if (plan.queryIntent === 'symbollookup') sourceWeight = 0;
  const sourceBonus = Math.min(sourceHits, cfg.tokenHitCap) * sourceWeight;
  const contentBonus = Math.min(contentHits, cfg.tokenHitCap) * cfg.tokenContentWeight;

  score += titleBonus + sourceBonus + contentBonus;
  if (titleBonus) breakdown.tokenTitleHits = Math.round(titleBonus * 10000) / 10000;
  if (sourceBonus) breakdown.tokenSourceHits = Math.round(sourceBonus * 10000) / 10000;
  if (contentBonus) breakdown.tokenContentHits = Math.round(contentBonus * 10000) / 10000;

  // Intent bonuses
  if (result.collection === CODE_COLLECTION && _isCodeIntent(plan)) {
    score += cfg.codeIntentBonus;
    breakdown.codeIntentBonus = Math.round(cfg.codeIntentBonus * 10000) / 10000;
  }

  if (result.collection === RULES_COLLECTION) {
    const hasRuleKeyword = RULE_INTENT_KEYWORDS.some(keyword => 
      (plan.normalizedQuery || '').includes(keyword)
    );
    if (hasRuleKeyword) {
      score += cfg.ruleIntentBonus;
      breakdown.ruleIntentBonus = Math.round(cfg.ruleIntentBonus * 10000) / 10000;
    }
  }

  // Rules profile path matching
  const normalizedQuery = plan.normalizedQuery || '';
  if (_isRulesProfilePathLookup(normalizedQuery)) {
    const matchedPathHints = _matchedRulesProfilePathHints(normalizedQuery, source);
    if (matchedPathHints.length > 0) {
      const pathBonus = matchedPathHints.length * cfg.rulesProfilePathMatchBonus;
      score += pathBonus;
      breakdown.rulesProfilePathMatchBonus = Math.round(pathBonus * 10000) / 10000;
    }
  }

  // Memory context hints
  const pathHints = (memoryContext || {}).pathHints || [];
  if (source && pathHints.includes(source)) {
    score += cfg.pathHintBonus;
    breakdown.pathHintBonus = Math.round(cfg.pathHintBonus * 10000) / 10000;
  }

  const collectionHints = (memoryContext || {}).collectionHints || [];
  if (result.collection && collectionHints.includes(result.collection)) {
    score += cfg.collectionHintBonus;
    breakdown.collectionHintBonus = Math.round(cfg.collectionHintBonus * 10000) / 10000;
  }

  // Exact match bonus
  if (normalizedLower === titleLower || normalizedLower.includes(sourceLower)) {
    score += cfg.exactMatchBonus;
    breakdown.exactMatchBonus = Math.round(cfg.exactMatchBonus * 10000) / 10000;
  }

  return { rerankScore: score, breakdown };
}

function _queryTokens(plan) {
  const query = plan.normalizedQuery || '';
  return tokenize(query);
}

function _isRulesProfilePlan(plan) {
  const queryIntent = plan.queryIntent || '';
  return queryIntent === 'rulelookup' || queryIntent === 'symbollookup' || _isRulesProfileQuery(plan.normalizedQuery || '');
}

function _isCodeIntent(plan) {
  const queryIntent = plan.queryIntent || '';
  if (queryIntent === 'exactsymbol' || queryIntent === 'path' || queryIntent === 'error') return true;
  if (plan.collections && plan.collections.includes(CODE_COLLECTION)) return true;
  return (plan.symbols || []).some(_looksLikeCodeSymbol);
}

export default {
  buildSearchPlan,
  rerankResults,
  SearchPlan,
};
