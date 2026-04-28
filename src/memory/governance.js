/**
 * Memory governance - conflict detection and knowledge update planning.
 * Architecture: localMem + LLMWiki. Semantic (embedding-based) detection removed.
 */

/** 分词正则：匹配英文/数字/下划线片段或中文字符片段 */
const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g;
/** 大驼峰类名正则：匹配常见后缀（Service、Manager、Config 等）的 Java 风格类名 */
const CAMEL_CASE_RE = /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9]*(?:Service|Action|Mapper|ConfigManager|Impl|Exception|Result|Type|Helper|Controller|Manager|Handler|Factory|Builder|Constants|Config)(?![A-Za-z0-9_])/g;
/** 蛇形命名正则：匹配 snake_case 标识符 */
const SNAKE_CASE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

/** 主题分词停用词，这些词在主题匹配时被忽略 */
const TOPIC_STOPWORDS = new Set([
  '以后', '必须', '统一', '不要', '优先', '默认', '约定', '建议', '应该', '需要', '可以',
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
}) {
  const candidateProfile = _topicProfile(content, aliases, pathHints, collectionHints);
  const relatedFacts = [];
  const exactMatches = [];

  for (const fact of facts) {
    if (fact.status && fact.status !== 'active') continue;
    const relation = _topicRelation(candidateProfile, fact);
    if (!relation.sameTopic) continue;
    relatedFacts.push(fact);
    if (relation.sameText) {
      exactMatches.push(fact);
    }
  }

  const sortedRelated = _sortedFacts(relatedFacts);
  const sortedExact = _sortedFacts(exactMatches);
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
    // 相关性不足，降级为人工审阅
    return {
      strategy: 'resolve_conflict',
      suggestedMemoryId: '',
      relatedMemoryIds,
      conflictMemoryIds: relatedMemoryIds,
    };
  }

  if (relatedMemoryIds.length > 1) {
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
  if (!sameTopic && tokenOverlap.size >= 2 && collectionOverlap.size > 0) {
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
 * 从文本中提取别名（大驼峰类名和蛇形命名标识符）
 * @param {string} text - 原始文本
 * @returns {string[]} 去重后的别名列表
 */
function _extractAliases(text) {
  const aliases = [];
  for (const pattern of [CAMEL_CASE_RE, SNAKE_CASE_RE]) {
    const matches = String(text).match(pattern) || [];
    for (const match of matches) {
      if (!aliases.includes(match)) aliases.push(match);
    }
  }
  return aliases;
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
