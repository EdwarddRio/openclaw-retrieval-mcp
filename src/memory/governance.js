/**
 * Memory governance - conflict detection and knowledge update planning.
 * Architecture: localMem + LLMWiki. Semantic (embedding-based) detection removed.
 */

import { logger, LLM_SEMANTIC_COMPARE_TIMEOUT_MS } from '../config.js';

/** 分词正则：匹配英文/数字/下划线片段或中文字符片段 */
const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g;
/** 主题分词停用词，这些词在主题匹配时被忽略 */
const TOPIC_STOPWORDS = new Set([
  '当前', '这个', '那个', '这样', '进行', '处理', '相关', '问题', '方案', '新增',
]);

/** 记忆状态优先级排序权重，kept > tentative */
const MEMORY_STATE_PRIORITY = {
  tentative: 1,
  kept: 2,
};

/**
 * Plan how a new memory candidate should be integrated into the knowledge base.
 *
 * @param {Object} params
 * @param {string} params.content
 * @param {string[]} params.aliases
 * @param {string[]} params.pathHints
 * @param {string[]} params.collectionHints
 * @param {Array<Record<string, any>>} params.facts - existing active memory facts
 * @returns {Promise<{strategy: string, suggestedMemoryId: string, relatedMemoryIds: string[], conflictMemoryIds: string[]}>}
 */
export async function planKnowledgeUpdate({
  content,
  aliases = [],
  pathHints = [],
  collectionHints = [],
  facts = [],
  sideLlmGateway = null,
}) {
  const candidateProfile = _topicProfile(content, aliases, pathHints, collectionHints);
  const relatedFacts = [];
  const exactMatches = [];

  for (const fact of facts) {
    if (fact.status && fact.status !== 'active') continue;
    const relation = _topicRelation(candidateProfile, fact);
    if (!relation.sameTopic) continue;
    fact._relationScore = _computeRelationScore(candidateProfile, fact);
    relatedFacts.push(fact);
    if (relation.sameText) {
      exactMatches.push(fact);
    }
  }

  const sortedRelated = _sortedFacts(relatedFacts);
  const sortedExact = _sortedFacts(exactMatches);
  sortedRelated.sort((a, b) => (b._relationScore || 0) - (a._relationScore || 0));
  const relatedMemoryIds = sortedRelated
    .map(f => f.memory_id)
    .filter(Boolean);

  if (sortedExact.length > 0) {
    return {
      strategy: 'keep_existing',
      suggestedMemoryId: sortedExact[0].memory_id || '',
      relatedMemoryIds,
      conflictMemoryIds: [],
    };
  }

  if (relatedMemoryIds.length === 1) {
    const onlyFact = sortedRelated[0];
    const score = onlyFact._relationScore || 0;

    if (score >= 0.7) {
      if (sideLlmGateway) {
        const llmDecision = await _llmSemanticCompare({
          candidate: content,
          existing: onlyFact.content || '',
          sideLlmGateway,
        });
        if (llmDecision.sameIntent) {
          return {
            strategy: 'keep_existing',
            suggestedMemoryId: relatedMemoryIds[0],
            relatedMemoryIds,
            conflictMemoryIds: [],
          };
        }
        if (llmDecision.confidence >= 0.6) {
          return {
            strategy: 'supersede_existing',
            suggestedMemoryId: relatedMemoryIds[0],
            relatedMemoryIds,
            conflictMemoryIds: [relatedMemoryIds[0]],
          };
        }
      }
      const exactOverlap = candidateProfile.normalizedText &&
        (onlyFact.content || '').toLowerCase().includes(candidateProfile.normalizedText);
      if (exactOverlap) {
        return {
          strategy: 'supersede_existing',
          suggestedMemoryId: relatedMemoryIds[0],
          relatedMemoryIds,
          conflictMemoryIds: [relatedMemoryIds[0]],
        };
      }
      return {
        strategy: 'resolve_conflict',
        suggestedMemoryId: '',
        relatedMemoryIds,
        conflictMemoryIds: relatedMemoryIds,
      };
    }

    return {
      strategy: 'create_new',
      suggestedMemoryId: '',
      relatedMemoryIds,
      conflictMemoryIds: [],
    };
  }

  if (relatedMemoryIds.length > 1) {
    if (sideLlmGateway) {
      const llmDecision = await _llmSemanticCompare({
        candidate: content,
        existing: sortedRelated[0].content || '',
        sideLlmGateway,
      });
      if (llmDecision.sameIntent) {
        return {
          strategy: 'keep_existing',
          suggestedMemoryId: sortedRelated[0].memory_id || '',
          relatedMemoryIds,
          conflictMemoryIds: [],
        };
      }
    }
    return {
      strategy: 'resolve_conflict',
      suggestedMemoryId: '',
      relatedMemoryIds,
      conflictMemoryIds: relatedMemoryIds,
    };
  }

  return {
    strategy: 'create_new',
    suggestedMemoryId: '',
    relatedMemoryIds: [],
    conflictMemoryIds: [],
  };
}

// ------------------------------------------------------------------
// Relation score computation
// ------------------------------------------------------------------

function _computeRelationScore(candidateProfile, fact) {
  const factProfile = _topicProfile(
    fact.content || '',
    fact.aliases || [],
    fact.path_hints || [],
    fact.collection_hints || [],
  );

  const aliasOverlap = _setIntersect(candidateProfile.aliases, factProfile.aliases);
  const pathOverlap = _setIntersect(candidateProfile.paths, factProfile.paths);
  const collectionOverlap = _setIntersect(candidateProfile.collections, factProfile.collections);
  const tokenOverlap = _setIntersect(candidateProfile.tokens, factProfile.tokens);

  let score = 0;

  if (aliasOverlap.size > 0) score += 0.35 * Math.min(aliasOverlap.size / Math.max(candidateProfile.aliases.size, 1), 1);
  if (pathOverlap.size > 0) score += 0.25 * Math.min(pathOverlap.size / Math.max(candidateProfile.paths.size, 1), 1);
  if (collectionOverlap.size > 0) score += 0.15;

  const tokenRatio = tokenOverlap.size / Math.max(candidateProfile.tokens.size, 1);
  score += 0.10 * tokenRatio;

  const left = candidateProfile.normalizedText;
  const right = factProfile.normalizedText;
  if (left && right && (left.includes(right) || right.includes(left))) {
    score += 0.15;
  }

  return Math.min(score, 1.0);
}

// ------------------------------------------------------------------
// Topic profile & relation
// ------------------------------------------------------------------

/**
 * 构建主题画像，包含归一化文本、别名、路径、集合、语义文本和 token 集合
 * @param {string} content - 记忆内容
 * @param {string[]} aliases - 别名列表
 * @param {string[]} pathHints - 路径提示列表
 * @param {string[]} collectionHints - 集合提示列表
 * @returns {{ normalizedText: string, aliases: Set<string>, paths: Set<string>, collections: Set<string>, semanticText: string, tokens: Set<string> }}
 */
function _topicProfile(content, aliases, pathHints, collectionHints) {
  return {
    normalizedText: _normalizeText(content),
    aliases: new Set(aliases.filter(Boolean).map(_normalizeText)),
    paths: new Set(pathHints.filter(Boolean).map(_normalizePath)),
    collections: new Set(collectionHints.filter(Boolean).map(_normalizeText)),
    semanticText: _buildSemanticText(content, aliases, pathHints, collectionHints),
    tokens: new Set(_topicTokens(content, aliases, pathHints, collectionHints)),
  };
}

/**
 * 判断候选记忆与已有事实是否属于同一主题，以及文本是否完全相同
 * @param {Object} candidateProfile - 候选记忆的主题画像
 * @param {Object} fact - 已有记忆事实
 * @returns {{ sameTopic: boolean, sameText: boolean }}
 */
function _topicRelation(candidateProfile, fact) {
  const factProfile = _topicProfile(
    fact.content || '',
    fact.aliases || [],
    fact.path_hints || [],
    fact.collection_hints || [],
  );

  const sameText = Boolean(
    candidateProfile.normalizedText &&
    candidateProfile.normalizedText === factProfile.normalizedText,
  );

  if (sameText) {
    return { sameTopic: true, sameText: true };
  }

  const aliasOverlap = _setIntersect(candidateProfile.aliases, factProfile.aliases);
  const pathOverlap = _setIntersect(candidateProfile.paths, factProfile.paths);
  const collectionOverlap = _setIntersect(candidateProfile.collections, factProfile.collections);
  const tokenOverlap = _setIntersect(candidateProfile.tokens, factProfile.tokens);

  let sameTopic = aliasOverlap.size > 0 || pathOverlap.size > 0;
  if (!sameTopic && tokenOverlap.size >= 3) {
    sameTopic = true;
  }
  if (!sameTopic && tokenOverlap.size >= 2) {
    const overlapRatio = tokenOverlap.size / Math.max(candidateProfile.tokens.size, 1);
    if (overlapRatio >= 0.25) sameTopic = true;
  }
  if (!sameTopic && collectionOverlap.size > 0) {
    sameTopic = true;
  }
  if (!sameTopic) {
    const left = candidateProfile.normalizedText;
    const right = factProfile.normalizedText;
    sameTopic = Boolean(left && right && (left.includes(right) || right.includes(left)));
  }

  return { sameTopic, sameText: false };
}

// ------------------------------------------------------------------
// Semantic conflict detection — REMOVED
// Embedding-based detection was disabled when static_kb/ChromaDB was removed.
// Lexical/token matching in planKnowledgeUpdate handles conflict detection.
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * 将内容、别名、路径提示、集合提示拼接为语义文本，用于主题匹配
 * @param {string} content - 记忆内容
 * @param {string[]} aliases - 别名列表
 * @param {string[]} pathHints - 路径提示列表
 * @param {string[]} collectionHints - 集合提示列表
 * @returns {string} 拼接后的语义文本
 */
function _buildSemanticText(content, aliases, pathHints, collectionHints) {
  const parts = [];
  if (content) parts.push(content.trim());
  for (const alias of aliases) {
    if (alias) parts.push(alias.trim());
  }
  for (const pathHint of pathHints) {
    if (!pathHint) continue;
    const base = pathHint.replace(/\\/g, '/');
    const lastSlash = base.lastIndexOf('/');
    const stem = lastSlash >= 0 ? base.slice(lastSlash + 1) : base;
    const dot = stem.lastIndexOf('.');
    parts.push(dot > 0 ? stem.slice(0, dot) : stem);
  }
  for (const collection of collectionHints) {
    if (collection) parts.push(collection.trim());
  }
  return parts.filter(Boolean).join(' ').trim();
}

/**
 * 从内容、别名、路径、集合中提取主题 token，过滤停用词和单字符
 * @param {string} content - 记忆内容
 * @param {string[]} aliases - 别名列表
 * @param {string[]} pathHints - 路径提示列表
 * @param {string[]} collectionHints - 集合提示列表
 * @returns {string[]} 去重后的小写 token 列表
 */
function _topicTokens(content, aliases, pathHints, collectionHints) {
  const values = [content];
  values.push(...aliases.filter(Boolean));
  values.push(...collectionHints.filter(Boolean));
  for (const pathHint of pathHints) {
    if (!pathHint) continue;
    const base = pathHint.replace(/\\/g, '/');
    const lastSlash = base.lastIndexOf('/');
    const stem = lastSlash >= 0 ? base.slice(lastSlash + 1) : base;
    const dot = stem.lastIndexOf('.');
    values.push(dot > 0 ? stem.slice(0, dot) : stem);
    values.push(base);
  }

  const tokens = [];
  for (const value of values) {
    const matches = String(value).match(TOKEN_RE) || [];
    for (const token of matches) {
      if (token.length <= 1) continue;
      const lowered = token.toLowerCase();
      if (lowered.length <= 1 || TOPIC_STOPWORDS.has(lowered)) continue;
      if (!tokens.includes(lowered)) tokens.push(lowered);
    }
  }
  return tokens;
}

/**
 * 归一化文本：合并空白、去除首尾空白、转小写
 * @param {string} text - 原始文本
 * @returns {string} 归一化后的文本
 */
function _normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 归一化路径：反斜杠转正斜杠、去除首尾空白、转小写
 * @param {string} pathHint - 原始路径
 * @returns {string} 归一化后的路径
 */
function _normalizePath(pathHint) {
  return String(pathHint || '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
}

/**
 * 对记忆事实排序：优先级(kept>tentative) > 命中次数 > 更新时间 > ID
 * @param {Array<Object>} facts - 待排序的记忆事实列表
 * @returns {Array<Object>} 排序后的列表
 */
function _sortedFacts(facts) {
  return [...facts].sort((a, b) => {
    const pa = MEMORY_STATE_PRIORITY[a.state] || 0;
    const pb = MEMORY_STATE_PRIORITY[b.state] || 0;
    if (pa !== pb) return pb - pa;
    const ha = Number(a.hit_count || 0);
    const hb = Number(b.hit_count || 0);
    if (ha !== hb) return hb - ha;
    const ua = a.updated_at || a.created_at || '';
    const ub = b.updated_at || b.created_at || '';
    if (ua !== ub) return ub.localeCompare(ua);
    return (a.memory_id || '').localeCompare(b.memory_id || '');
  });
}

/**
 * 计算两个 Set 的交集
 * @param {Set} a - 集合 A
 * @param {Set} b - 集合 B
 * @returns {Set} 交集结果
 */
function _setIntersect(a, b) {
  const result = new Set();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

// ------------------------------------------------------------------
// Session review candidate extraction has been removed.
// Wiki promotion path (wiki_candidate → published) no longer exists.
// localMem now serves as permanent SQLite storage only.
// Wiki is independently managed by the LLMWiki compiler.
// ------------------------------------------------------------------

/**
 * LLM 语义兜底：判断两条记忆是否表达同一意图
 * @param {Object} params
 * @param {string} params.candidate - 候选记忆内容
 * @param {string} params.existing - 已有记忆内容
 * @param {Object} params.sideLlmGateway - LLM 网关（需支持 chat/completions）
 * @returns {Promise<{sameIntent: boolean, confidence: number}>}
 */
async function _llmSemanticCompare({ candidate, existing, sideLlmGateway }) {
  try {
    const prompt = `判断以下两条记忆是否表达同一意图或规则。只输出 JSON：\n\n候选："${candidate.slice(0, 200)}"\n已有："${existing.slice(0, 200)}"\n\n输出格式：{"sameIntent": true/false, "confidence": 0.0-1.0}`;
    
    const model = sideLlmGateway.defaultModel || 'k2p6';
    const chatPromise = sideLlmGateway.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 100,
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LLM gateway timeout after ${LLM_SEMANTIC_COMPARE_TIMEOUT_MS}ms`)), LLM_SEMANTIC_COMPARE_TIMEOUT_MS)
    );
    const response = await Promise.race([chatPromise, timeoutPromise]);
    
    const text = response?.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[^}]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        sameIntent: parsed.sameIntent === true || parsed.sameIntent === 'true',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : parseFloat(parsed.confidence) || 0.5,
      };
    }
  } catch (err) {
    logger.warn(`[governance] LLM semantic compare failed (model: ${sideLlmGateway.defaultModel || 'k2p6'}): ${err.message}`);
  }
  return { sameIntent: false, confidence: 0 };
}
