/**
 * Memory governance - conflict detection, knowledge update planning,
 * and semantic deduplication ported from rule-engine/memory/governance.py.
 */

import { getEmbeddingClient } from '../vector/embedding-client.js';

const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g;
const CAMEL_CASE_RE = /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9]*(?:Service|Action|Mapper|ConfigManager|Impl|Exception|Result|Type|Helper|Controller|Manager|Handler|Factory|Builder|Constants|Config)(?![A-Za-z0-9_])/g;
const SNAKE_CASE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

const TOPIC_STOPWORDS = new Set([
  '以后', '必须', '统一', '不要', '优先', '默认', '约定', '建议', '应该', '需要', '可以',
  '当前', '这个', '那个', '这样', '进行', '处理', '相关', '问题', '方案', '新增',
]);

const MEMORY_STATE_PRIORITY = {
  tentative: 1,
  local_only: 2,
  manual_only: 2,
  candidate_on_reuse: 3,
  review_candidate: 4,
  wiki_candidate: 4,
  published: 5,
  discarded: 0,
};

const SEMANTIC_MATCH_THRESHOLD = 0.83;
const SEMANTIC_CONFLICT_MARGIN = 0.03;
const SEMANTIC_MAX_CONFLICT_CANDIDATES = 3;

// In-memory embedding cache (ephemeral, process lifetime)
const SEMANTIC_EMBEDDING_CACHE = new Map();

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
  semanticEnabled = true,
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

  // Fallback to semantic (embedding-based) detection when lexical signals are weak
  if (semanticEnabled) {
    const semanticMatches = await _semanticRelatedFacts(candidateProfile, facts);
    if (semanticMatches.length === 1) {
      const mid = semanticMatches[0].memory_id || '';
      return {
        strategy: 'supersede_existing',
        suggestedMemoryId: mid,
        relatedMemoryIds: mid ? [mid] : [],
        conflictMemoryIds: mid ? [mid] : [],
      };
    }

    if (semanticMatches.length > 1) {
      const mids = semanticMatches
        .map(m => m.memory_id)
        .filter(Boolean);
      return {
        strategy: 'resolve_conflict',
        suggestedMemoryId: '',
        relatedMemoryIds: mids,
        conflictMemoryIds: mids,
      };
    }
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
// Semantic conflict detection (embedding-based)
// ------------------------------------------------------------------

async function _semanticRelatedFacts(candidateProfile, facts) {
  const activeFacts = facts.filter(
    f => (!f.status || f.status === 'active') && f.memory_id,
  );
  if (activeFacts.length === 0) return [];

  const candidateText = candidateProfile.semanticText;
  if (!candidateText) return [];

  const enrichedFacts = await _enrichFactsWithSemanticCache(activeFacts);
  const embeddings = await _encodeSemanticTexts([candidateText]);
  const candidateEmbedding = embeddings.get(candidateText);
  if (!candidateEmbedding) return [];

  const scoredMatches = [];
  for (const fact of enrichedFacts) {
    const factEmbedding = fact.semantic_embedding;
    if (!factEmbedding || factEmbedding.length === 0) continue;
    const similarity = _cosineSimilarity(candidateEmbedding, factEmbedding);
    if (similarity < SEMANTIC_MATCH_THRESHOLD) continue;
    scoredMatches.push({ memory_id: fact.memory_id, score: similarity });
  }

  scoredMatches.sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id));
  if (scoredMatches.length === 0) return [];
  if (scoredMatches.length === 1) return scoredMatches;

  const margin = scoredMatches[0].score - scoredMatches[1].score;
  if (margin >= SEMANTIC_CONFLICT_MARGIN) {
    return [scoredMatches[0]];
  }

  const topScore = scoredMatches[0].score;
  return scoredMatches
    .filter(m => topScore - m.score <= SEMANTIC_CONFLICT_MARGIN)
    .slice(0, SEMANTIC_MAX_CONFLICT_CANDIDATES);
}

async function _enrichFactsWithSemanticCache(facts, cachedFacts = []) {
  const cachedById = new Map();
  for (const cf of cachedFacts) {
    if (cf.memory_id) cachedById.set(cf.memory_id, cf);
  }

  const enriched = [];
  const missingTexts = [];

  for (const fact of facts) {
    const enrichedFact = { ...fact };
    const semanticText = _buildSemanticText(
      fact.content || '',
      fact.aliases || [],
      fact.path_hints || [],
      fact.collection_hints || [],
    );
    enrichedFact.semantic_text = semanticText;

    const cached = cachedById.get(fact.memory_id);
    let cachedEmbedding = null;
    if (cached && cached.semantic_text === semanticText) {
      cachedEmbedding = cached.semantic_embedding;
    }

    if (cachedEmbedding && cachedEmbedding.length > 0) {
      enrichedFact.semantic_embedding = cachedEmbedding;
    } else if (semanticText) {
      enrichedFact.semantic_embedding = [];
      missingTexts.push(semanticText);
    } else {
      enrichedFact.semantic_embedding = [];
    }
    enriched.push(enrichedFact);
  }

  const uniqueMissing = [...new Set(missingTexts)];
  if (uniqueMissing.length > 0) {
    const encoded = await _encodeSemanticTexts(uniqueMissing);
    for (const fact of enriched) {
      if (fact.semantic_embedding && fact.semantic_embedding.length > 0) continue;
      const text = fact.semantic_text;
      const emb = encoded.get(text);
      if (emb) {
        fact.semantic_embedding = emb;
      }
    }
  }

  return enriched;
}

async function _encodeSemanticTexts(texts) {
  const missingTexts = texts.filter(t => t && !SEMANTIC_EMBEDDING_CACHE.has(t));
  if (missingTexts.length > 0) {
    try {
      const client = getEmbeddingClient();
      const embeddings = await client.encode(missingTexts);
      for (let i = 0; i < missingTexts.length; i++) {
        SEMANTIC_EMBEDDING_CACHE.set(missingTexts[i], embeddings[i]);
      }
    } catch (err) {
      // Degrade gracefully: return whatever is already cached
    }
  }

  const result = new Map();
  for (const text of texts) {
    const emb = SEMANTIC_EMBEDDING_CACHE.get(text);
    if (emb) result.set(text, emb);
  }
  return result;
}

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

function _cosineSimilarity(left, right) {
  let numerator = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = Number(left[i]);
    const r = Number(right[i]);
    numerator += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0.0;
  return numerator / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
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
// Session review candidate extraction (lightweight heuristics)
// ------------------------------------------------------------------

const AUTO_DRAFT_TRIGGERS = new Set([
  '约定', '以后', '必须', '统一', '不要', '优先看', '注意', '关键', '重要', '核心',
  '原因', '解决', '修复', '改为', '改为使用', '移除', '删除', '新增', '变更', '架构', '决策',
]);

const AUTO_DRAFT_NOISE_MARKERS = [
  '```', '<attached_files>', '<system_reminder>', 'Question ', 'Selected option',
  'Retrieval summary', 'TODO', 'COMPLETED', 'IN_PROGRESS', 'PENDING',
];

const USER_MEMORY_DIRECTIVES = new Set(['记住', '约定', '统一', '固定', '必须', '不要', '别忘', '请按']);

export function extractSessionReviewCandidates(turns) {
  const candidates = [];
  const seen = new Set();
  for (const turn of turns) {
    const role = turn.role || '';
    if (role !== 'assistant' && role !== 'user') continue;
    const content = String(turn.content || '').trim();
    if (!content) continue;
    const references = turn.references || {};
    for (const candidateContent of _extractCandidateSentences(content, role)) {
      const normalized = _normalizeText(candidateContent);
      if (normalized.length < 6 || seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push({
        content: candidateContent,
        normalized_text: normalized,
        aliases: _extractAliases(candidateContent),
        path_hints: [...(references.path_hints || [])],
        collection_hints: [...(references.collection_hints || [])],
        source_turn_ids: [turn.turn_id || ''],
      });
    }
  }
  return candidates;
}

function _extractCandidateSentences(content, role) {
  const candidates = [];
  for (const rawSegment of _splitCandidateSegments(content)) {
    const summarized = _summarizeCandidateContent(rawSegment);
    if (_shouldKeepCandidateSentence(rawSegment, summarized, role)) {
      candidates.push(summarized);
    }
  }
  return candidates;
}

function _splitCandidateSegments(content) {
  const segments = [];
  for (const raw of String(content).split(/[。\n；;]+/)) {
    const segment = raw.trim().replace(/^(?:[-*]\s*|\d+\.\s*)/, '').trim();
    if (segment) segments.push(segment);
  }
  return segments;
}

function _summarizeCandidateContent(content) {
  let sentence = String(content).split(/[。\n；;]/, 2)[0].trim();
  sentence = sentence.replace(/^(?:[-*]\s*|\d+\.\s*)/, '');
  sentence = sentence.replace(/^(约定[:：]\s*|以后\s*)/, '');
  return sentence || String(content).trim();
}

function _shouldKeepCandidateSentence(rawSegment, candidateContent, role) {
  if (_looksLikeNoiseSentence(rawSegment)) return false;
  const aliases = _extractAliases(candidateContent);
  const hasPath = /(?:[A-Za-z]:[\\/]|[\\/]|(?:\.\w{1,8}\b))/.test(rawSegment);
  const hasAnchor = aliases.length > 0 || hasPath;
  const hasTrigger = [...AUTO_DRAFT_TRIGGERS].some(t => rawSegment.includes(t));
  const hasFactSignal = /\b(?:确认|字段|映射|入口|实现|路径|类名|配置|结束时间|开始时间|开关|对应|接口|Service|Action|Mapper|Redis|数据库|缓存|配置表|数据源|分页|乐观锁|事务|异常|GameException|JsonResult|ResultType)\b/.test(rawSegment);

  if (role === 'user') {
    const hasDirective = [...USER_MEMORY_DIRECTIVES].some(m => rawSegment.includes(m));
    return hasDirective && (hasTrigger || hasFactSignal || hasAnchor);
  }
  return hasTrigger || hasFactSignal || hasAnchor;
}

function _looksLikeNoiseSentence(rawSegment) {
  const normalized = _normalizeText(rawSegment);
  if (normalized.length < 6) return true;
  if (rawSegment.includes('?') || rawSegment.includes('？')) return true;
  if (rawSegment.startsWith('##') || rawSegment.startsWith('###') || rawSegment.startsWith('```') || rawSegment.startsWith('>')) return true;
  if (/\breview-[a-z0-9x]{3,}\b/i.test(rawSegment)) return true;
  if (/^\[\d+\]\s+.+\([^)]+\)\s+-\s+.+$/.test(rawSegment.trim())) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:[\(\[\{].+|['"].+|[A-Za-z_][A-Za-z0-9_]*(?:\s*[+\-*/].+)?)$/.test(rawSegment.trim())) return true;
  if (AUTO_DRAFT_NOISE_MARKERS.some(m => normalized.includes(m.toLowerCase()))) return true;
  return false;
}
