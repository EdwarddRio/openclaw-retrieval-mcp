/**
 * Memory governance - conflict detection and knowledge update planning.
 * Architecture: localMem + LLMWiki. Semantic (embedding-based) detection removed.
 */

const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g;
const CAMEL_CASE_RE = /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9]*(?:Service|Action|Mapper|ConfigManager|Impl|Exception|Result|Type|Helper|Controller|Manager|Handler|Factory|Builder|Constants|Config)(?![A-Za-z0-9_])/g;
const SNAKE_CASE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

const TOPIC_STOPWORDS = new Set([
  '以后', '必须', '统一', '不要', '优先', '默认', '约定', '建议', '应该', '需要', '可以',
  '当前', '这个', '那个', '这样', '进行', '处理', '相关', '问题', '方案', '新增',
]);

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
    return {
      strategy: 'supersede_existing',
      suggestedMemoryId: relatedMemoryIds[0],
      relatedMemoryIds,
      conflictMemoryIds: [relatedMemoryIds[0]],
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

function _normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _normalizePath(pathHint) {
  return String(pathHint || '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
}

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
