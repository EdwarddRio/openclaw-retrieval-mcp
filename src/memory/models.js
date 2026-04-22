/**
 * Memory data models and utility functions.
 * Merged D version's complete MemoryFact (with aliases, path_hints, collection_hints),
 * triage constants, and utility functions with K version's simpler models.
 */

import crypto from 'crypto';

// ========== Chat Models ==========

export class ChatTurn {
  constructor(options = {}) {
    // Support both K version (destructured) and D version (options object) patterns
    this.turn_id = options.turn_id || crypto.randomUUID();
    this.session_id = options.session_id || '';
    this.seq_no = options.seq_no || 0;
    this.role = options.role || '';
    this.content = options.content || '';
    this.created_at = options.created_at || new Date().toISOString();
    this.created_at_ts = options.created_at_ts || Date.now();
    this.references = options.references || {};
  }
}

export class ChatSession {
  constructor(options = {}) {
    this.session_id = options.session_id || crypto.randomUUID();
    if (!this.session_id) this.session_id = crypto.randomUUID();
    this.project_id = options.project_id || 'default';
    this.session_date = options.session_date || '';
    this.started_at = options.started_at || options.created_at || new Date().toISOString();
    this.created_at = options.created_at || new Date().toISOString();
    this.updated_at = options.updated_at || new Date().toISOString();
    this.title = options.title || '';
    this.summary = options.summary || '';
    this.tags = options.tags || [];
    this.turn_count = options.turn_count || 0;
    this.status = options.status || 'active';
    this.turns = options.turns || [];
  }
}

// ========== Memory Fact Model ==========

export class MemoryFact {
  constructor(options = {}) {
    // K version basic fields
    this.memory_id = options.memory_id || '';
    this.content = options.content || '';
    this.canonical_key = options.canonical_key || null;
    this.status = options.status || 'tentative';
    this.source_session_id = options.source_session_id || options.session_id || null;
    this.created_at = options.created_at || new Date().toISOString();
    this.updated_at = options.updated_at || new Date().toISOString();
    this.published_at = options.published_at || null;
    this.choice = options.choice || null;

    // D version extended fields
    this.session_id = options.session_id || options.source_session_id || '';
    this.source_turn_ids = options.source_turn_ids || [];
    this.state = options.state || 'local_only';
    this.normalized_text = options.normalized_text || '';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
    this.previous_versions = options.previous_versions || [];
    this.source = options.source || 'manual';
    this.output_path = options.output_path || null;
    this.slug = options.slug || null;
    this.wiki_title = options.wiki_title || null;
    this.last_choice = options.last_choice || null;
    this.last_review_action = options.last_review_action || null;
  }
}

// ========== Triage Constants (D version) ==========

export const MEMORY_INTENT_PHRASES = [
  '上次说的', '刚才提到的', '之前约定', '昨天讨论',
  '你还记得', '前面定过', '之前说过',
];

export const FACT_SIMILARITY_THRESHOLD = 0.82;
export const INFLUENCE_CONFIDENCE = 1.2;
export const INFLUENCE_CONFIDENCE_WITH_INTENT = 0.9;
export const VECTOR_WEIGHT = 2.0;

export const TRIAGE_CONFIRM_SIGNALS = [
  '以后都按这个来', '这个项目里固定这样', '记住这个', '优先看这个',
  '这个映射以后别忘', '记住', '记下来', '以后都这样', '固定规则', '以后注意',
];

export const TRIAGE_DISCARD_SIGNALS = [
  '试试看', '先不管', '暂时不用', '先跳过', '算了',
  '不确定', '可能不对', '随便看看',
];

export const TRIAGE_MIN_CONTENT_LENGTH = 10;
export const TRIAGE_MAX_CONTENT_LENGTH = 500;

// ========== Utility Functions (D version) ==========

export function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isoNow() {
  return new Date().toISOString().split('.')[0] + 'Z';
}

export function isoToEpochMs(value) {
  if (!value) return 0;
  return new Date(value).getTime();
}

export function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, x, i) => sum + x * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
  const normB = Math.sqrt(b.reduce((sum, x) => sum + x * x, 0));
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (normA * normB);
}

export function canonicalKeyForText(text) {
  const normalized = normalizeText(text);
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

export default {
  ChatTurn,
  ChatSession,
  MemoryFact,
  MEMORY_INTENT_PHRASES,
  FACT_SIMILARITY_THRESHOLD,
  TRIAGE_CONFIRM_SIGNALS,
  TRIAGE_DISCARD_SIGNALS,
  TRIAGE_MIN_CONTENT_LENGTH,
  TRIAGE_MAX_CONTENT_LENGTH,
  normalizeText,
  isoNow,
  isoToEpochMs,
  cosineSimilarity,
  canonicalKeyForText,
};
