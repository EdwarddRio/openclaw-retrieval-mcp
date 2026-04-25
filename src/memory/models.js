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
   * @param {string} [options.state] - 状态（tentative/kept）
   * @param {string} [options.normalized_text] - 归一化文本
   * @param {string[]} [options.aliases] - 别名列表
   * @param {string[]} [options.path_hints] - 路径提示列表
   * @param {string[]} [options.collection_hints] - 集合提示列表
   * @param {Array} [options.previous_versions] - 历史版本列表
   * @param {string} [options.source] - 来源类型（manual/auto_triage/user_explicit/auto_draft）
   * @param {string} [options.last_choice] - 最近一次用户决策
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
    this.state = options.state || 'tentative';
    this.normalized_text = options.normalized_text || '';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
    this.previous_versions = options.previous_versions || [];
    this.source = options.source || 'manual';
    this.last_choice = options.last_choice || null;
  }
}

// ========== Triage Constants (D version) ==========

/** 记忆意图短语，用于检测用户是否在引用过去的记忆 */
export const MEMORY_INTENT_PHRASES = [
  '上次说的', '刚才提到的', '之前约定', '昨天讨论',
  '你还记得', '前面定过', '之前说过',
];

export const FACT_SIMILARITY_THRESHOLD = 0.82; /** 事实相似度判定阈值 */
export const INFLUENCE_CONFIDENCE = 1.2;       /** 置信度影响因子 */
export const INFLUENCE_CONFIDENCE_WITH_INTENT = 0.9; /** 带意图的置信度影响因子 */
export const VECTOR_WEIGHT = 2.0;               /** 向量搜索权重（保留常量，embedding 已移除） */

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

export const TRIAGE_MIN_CONTENT_LENGTH = 10;  /** 分诊最小内容长度，低于此值不保留 */
export const TRIAGE_MAX_CONTENT_LENGTH = 500;  /** 分诊最大内容长度，超过此值不保留 */

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

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} a - 向量 A
 * @param {number[]} b - 向量 B
 * @returns {number} 余弦相似度，范围 [-1, 1]
 */
export function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, x, i) => sum + x * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
  const normB = Math.sqrt(b.reduce((sum, x) => sum + x * x, 0));
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (normA * normB);
}

/**
 * 根据文本生成规范键（SHA1 哈希），用于记忆去重
 * @param {string} text - 原始文本
 * @returns {string} SHA1 哈希的十六进制字符串
 */
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
