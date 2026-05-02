/**
 * Memory data models and utility functions.
 * Merged D version's complete MemoryFact (with aliases, path_hints, collection_hints),
 * triage constants, and utility functions with K version's simpler models.
 */

import crypto from 'crypto';

// ========== Chat Models ==========

/**
 * 对话轮次模型，记录单条用户/助手/系统消息
 */
export class ChatTurn {
  /**
   * @param {Object} [options] - 轮次选项
   * @param {string} [options.turn_id] - 轮次 ID，默认自动生成
   * @param {string} [options.session_id] - 所属会话 ID
   * @param {number} [options.seq_no] - 序号
   * @param {string} [options.role] - 角色（user/assistant/system）
   * @param {string} [options.content] - 内容
   * @param {string} [options.created_at] - 创建时间
   * @param {number} [options.created_at_ts] - 创建时间戳（毫秒）
   * @param {Object} [options.references] - 引用信息
   */
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

/**
 * 对话会话模型，管理一组对话轮次
 */
export class ChatSession {
  /**
   * @param {Object} [options] - 会话选项
   * @param {string} [options.session_id] - 会话 ID，默认自动生成
   * @param {string} [options.project_id] - 项目 ID
   * @param {string} [options.session_date] - 会话日期
   * @param {string} [options.started_at] - 开始时间
   * @param {string} [options.created_at] - 创建时间
   * @param {string} [options.updated_at] - 更新时间
   * @param {string} [options.title] - 标题
   * @param {string} [options.summary] - 摘要
   * @param {string[]} [options.tags] - 标签列表
   * @param {number} [options.turn_count] - 轮次计数
   * @param {string} [options.status] - 状态（active/closed）
   * @param {Array} [options.turns] - 轮次列表
   */
  constructor(options = {}) {
    this.session_id = options.session_id || crypto.randomUUID();
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

/**
 * 记忆事实模型，存储一条确认或暂定的知识
 */
export class MemoryFact {
  /**
   * @param {Object} [options] - 记忆选项
   * @param {string} [options.memory_id] - 记忆 ID
   * @param {string} [options.content] - 记忆内容
   * @param {string} [options.canonical_key] - 规范键（用于去重）
   * @param {string} [options.status] - 状态（active/archived）
   * @param {string} [options.source_session_id] - 来源会话 ID
   * @param {string} [options.created_at] - 创建时间
   * @param {string} [options.updated_at] - 更新时间
   * @param {string} [options.choice] - 用户决策
   * @param {string} [options.session_id] - 关联会话 ID
   * @param {string[]} [options.source_turn_ids] - 来源轮次 ID 列表
   * @param {string} [options.state] - @deprecated 使用 category+weight 替代
   * @param {string} [options.normalized_text] - 归一化文本
   * @param {string[]} [options.aliases] - 别名列表
   * @param {string[]} [options.path_hints] - 路径提示列表
   * @param {string[]} [options.collection_hints] - 集合提示列表
   * @param {Array} [options.previous_versions] - 历史版本列表
   * @param {string} [options.source] - 来源类型（manual/auto_triage/user_explicit/auto_draft/dream-cycle）
   * @param {string} [options.last_choice] - 最近一次用户决策
   * @param {string} [options.category] - 记忆分类（fact|preference|project|instruction|episodic）
   * @param {string} [options.weight] - 权重（STRONG|MEDIUM|WEAK）
   * @param {string} [options.weight_set_at] - weight最后变更时间（衰减计时基准）
   * @param {string} [options.expires_at] - 过期时间（null=永不过期）
   */
  constructor(options = {}) {
    // Basic fields
    this.memory_id = options.memory_id || '';
    this.content = options.content || '';
    this.canonical_key = options.canonical_key || null;
    this.status = options.status || 'active';
    this.source_session_id = options.source_session_id || options.session_id || null;
    this.created_at = options.created_at || new Date().toISOString();
    this.updated_at = options.updated_at || new Date().toISOString();
    this.choice = options.choice || null;

    // Extended fields
    this.session_id = options.session_id || options.source_session_id || '';
    this.source_turn_ids = options.source_turn_ids || [];
    this.state = options.state || 'tentative'; // @deprecated: 使用 category+weight 替代
    this.normalized_text = options.normalized_text || '';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
    this.previous_versions = options.previous_versions || [];
    this.source = options.source || 'manual';
    this.last_choice = options.last_choice || null;

    // New fields for weight-based lifecycle (v3.3)
    this.category = options.category || 'general'; // fact|preference|project|instruction|episodic
    this.weight = options.weight || 'MEDIUM'; // STRONG|MEDIUM|WEAK
    this.weight_set_at = options.weight_set_at || null; // ISO时间，weight变更时更新
    this.expires_at = options.expires_at || null; // ISO时间，null=永不过期
  }
}

// ========== Triage Constants (D version) ==========

/** 记忆意图短语，用于检测用户是否在引用过去的记忆 */
export const MEMORY_INTENT_PHRASES = [
  '上次说的', '刚才提到的', '之前约定', '昨天讨论',
  '你还记得', '前面定过', '之前说过',
];

export const FACT_SIMILARITY_THRESHOLD = 0.82;
export const INFLUENCE_CONFIDENCE_WITH_INTENT = 0.9;

/** 分诊确认信号关键词，匹配时优先保留为记忆 */
export const TRIAGE_CONFIRM_SIGNALS = [
  '以后都按这个来', '这个项目里固定这样', '记住这个', '优先看这个',
  '这个映射以后别忘', '记住', '记下来', '以后都这样', '固定规则', '以后注意',
];

/** 分诊丢弃信号关键词，匹配时不应保留为记忆 */
export const TRIAGE_DISCARD_SIGNALS = [
  '试试看', '先不管', '暂时不用', '先跳过', '算了',
  '不确定', '可能不对', '随便看看',
];

// ========== Weight & Category Constants (v3.3) ==========

/** 记忆权重枚举 */
export const WEIGHT = {
  STRONG: 'STRONG',
  MEDIUM: 'MEDIUM',
  WEAK: 'WEAK',
};

/** 记忆分类枚举 */
export const CATEGORY = {
  FACT: 'fact',
  PREFERENCE: 'preference',
  PROJECT: 'project',
  INSTRUCTION: 'instruction',
  EPISODIC: 'episodic',
  GENERAL: 'general',
};

/** 权重优先级（用于排序和冲突检测） */
export const WEIGHT_PRIORITY = {
  STRONG: 3,
  MEDIUM: 2,
  WEAK: 1,
};

/** 衰减间隔配置（毫秒） */
export const DECAY_INTERVALS = {
  STRONG_TO_MEDIUM: 14 * 24 * 60 * 60 * 1000,  // 14天
  MEDIUM_TO_WEAK: 7 * 24 * 60 * 60 * 1000,      // 7天
  WEAK_TO_DELETE: 3 * 24 * 60 * 60 * 1000,       // 3天
};

export const TRIAGE_MIN_CONTENT_LENGTH = parseInt(process.env.TRIAGE_MIN_CONTENT_LENGTH || '10', 10);
export const TRIAGE_MAX_CONTENT_LENGTH = parseInt(process.env.TRIAGE_MAX_CONTENT_LENGTH || '500', 10);

export const RELEVANCE_WEIGHTS = {
  search: { hitRate: 0.5, position: 0.2, count: 0.15, freshness: 0.15 },
  confidence: { hitRate: 0.4, position: 0.2, count: 0.2, freshness: 0.2 },
};

// ========== Utility Functions (D version) ==========

/**
 * 归一化文本：合并空白、去除首尾空白、转小写
 * @param {string} text - 原始文本
 * @returns {string} 归一化后的文本
 */
export function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 获取当前 ISO 时间字符串（精确到秒）
 * @returns {string} ISO 格式时间字符串，如 "2025-01-01T00:00:00Z"
 */
export function isoNow() {
  return new Date().toISOString().split('.')[0] + 'Z';
}

/**
 * 将 ISO 时间字符串转换为 Unix 毫秒时间戳
 * @param {string} value - ISO 时间字符串
 * @returns {number} 毫秒时间戳，无效输入返回 0
 */
export function isoToEpochMs(value) {
  if (!value) return 0;
  return new Date(value).getTime();
}

export function canonicalKeyForText(text) {
  const normalized = normalizeText(text);
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

export function computeRelevanceScore(query, item, weights = { hitRate: 0.5, position: 0.2, count: 0.15, freshness: 0.15 }) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;

  const content = (item.content || '').toLowerCase();
  let matchCount = 0;
  let totalPositions = 0;

  for (const term of terms) {
    const idx = content.indexOf(term);
    if (idx >= 0) {
      matchCount++;
      totalPositions += idx;
    }
  }

  const hitRate = matchCount / terms.length;
  const positionScore = matchCount > 0 ? 1 / (1 + totalPositions / 100) : 0;
  const countScore = Math.min(1, (item._hitCount || 1) / 3);
  const ageDays = item.updated_at
    ? (Date.now() - new Date(item.updated_at).getTime()) / (1000 * 60 * 60 * 24)
    : 999;
  const freshnessScore = 1 / (1 + ageDays / 30);

  return hitRate * (weights.hitRate || 0.5)
    + positionScore * (weights.position || 0.2)
    + countScore * (weights.count || 0.15)
    + freshnessScore * (weights.freshness || 0.15);
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
  WEIGHT,
  CATEGORY,
  WEIGHT_PRIORITY,
  DECAY_INTERVALS,
  normalizeText,
  isoNow,
  isoToEpochMs,
  canonicalKeyForText,
  computeRelevanceScore,
};
