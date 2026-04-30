/**
 * Local memory store - provides high-level memory operations
 * with autoTriage, dailyWriteLimit, and timeline integration.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger, LOCALMEM_DIR, LOCALMEM_FACT_MAX_AGE_DAYS, LOCALMEM_SESSION_MAX_AGE_DAYS, PROJECT_ROOT, LOCALMEM_DAILY_WRITE_LIMIT } from '../config.js';
import { SqliteStore } from './sqlite-store.js';
import { ChatTurn, ChatSession, MemoryFact, isoNow, canonicalKeyForText, computeRelevanceScore, TRIAGE_CONFIRM_SIGNALS, TRIAGE_DISCARD_SIGNALS, TRIAGE_MIN_CONTENT_LENGTH, TRIAGE_MAX_CONTENT_LENGTH, RELEVANCE_WEIGHTS } from './models.js';
import { planKnowledgeUpdate } from './governance.js';

// ========== Saveable states ==========
// localMem has two states:
//   tentative — temporary, auto-extracted, expires after 7 days unless confirmed
//   kept      — permanent, user-confirmed, persists in SQLite indefinitely
// Discarding a memory = hard DELETE from the database.
// Wiki is independently managed by the LLMWiki compiler.
/** 允许保存的记忆状态：tentative（暂定）和 kept（已确认） */
const SAVEABLE_STATES = new Set([
  'tentative', 'kept',
]);

/** 用户显式要求记忆的关键词列表 */
const EXPLICIT_MEMORY_SIGNALS = [
  '记住', '记下来', '以后都这样', '这个规则', '别忘了',
  '记住这个', '以后注意', '固定规则', '以后统一',
  '这个很重要', '帮我存一下', '记一下', '这个别忘了',
  '帮我记着', '存一下', '留个底', '备注一下', '这个要留档',
  '决定', '确认', '以后', '规则', '禁止', '必须', '约定',
  '优先', '默认', '统一', '固定', '一直', '每次', '任何',
  'always', 'never', 'must', 'from now on', 'make sure',
  'remember this', 'note this', 'keep this',
  'decide', 'confirm', 'rule', 'forbid', 'prohibit',
];

/**
 * 本地记忆存储，提供高层记忆操作（自动分诊、日写入限额、时间线集成）
 */
export class LocalMemoryStore {
  /**
   * @param {Object} options - 配置选项
   * @param {string} [options.rootDir] - 存储根目录，默认 LOCALMEM_DIR
   * @param {string} [options.projectRoot] - 项目根目录，用于路径提示过滤
   * @param {number} [options.factMaxAgeDays] - 事实最大保留天数
   */
  constructor(options = {}) {
    const rootDir = options.rootDir || LOCALMEM_DIR;
    this._root = path.resolve(rootDir);
    this._projectRoot = options.projectRoot || PROJECT_ROOT;
    this._dbPath = path.join(this._root, 'context-engine.db');
    this._statePath = path.join(this._root, 'meta', 'state.json');
    
    this._factMaxAgeDays = options.factMaxAgeDays || LOCALMEM_FACT_MAX_AGE_DAYS;
    this._lastCleanupAt = Date.now();
    this._cleanupInProgress = false;
    
    this._ensureLayout();
    this._store = new SqliteStore(this._dbPath);

    this._cleanupTimer = setInterval(() => {
      this._maybePeriodicCleanup();
    }, 60 * 60 * 1000);
    this._cleanupTimer.unref();
    setTimeout(() => this._maybePeriodicCleanup(), 5000).unref();
  }

  /**
   * 获取指定时间范围内的对话轮次（供批量 auto-triage 使用）
   * @param {number} hours - 查询最近多少小时的轮次，范围 1-168
   * @returns {Array<Object>} 轮次列表
   */
  getTurnsSince(hours) {
    const safeHours = Math.max(1, Math.min(168, parseInt(hours) || 24));
    return this._store.getTurnsSince(safeHours);
  }

  /**
   * 获取指定会话中指定时间之前的最近一条轮次
   * @param {string} sessionId - 会话 ID
   * @param {string} beforeTime - ISO 时间字符串
   * @returns {Object|null} 轮次对象
   */
  getPreviousTurn(sessionId, beforeTime) {
    return this._store.getPreviousTurn(sessionId, beforeTime);
  }

  /** 关闭数据库连接 */
  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._store) {
      this._store.close();
      this._store = null;
    }
  }

  /**
   * 追加一条对话轮次
   * @param {Object} options - 轮次选项
   * @param {string} options.session_id - 会话 ID
   * @param {string} options.role - 角色（user/assistant/system）
   * @param {string} options.content - 内容
   * @param {string} [options.project_id] - 项目 ID
   * @param {string} [options.title] - 标题
   * @param {string} [options.created_at] - 创建时间
   * @param {Object} [options.references] - 引用信息
   * @param {boolean} [options.skip_if_same_as_last] - 若与最后一条轮次相同则跳过
   * @returns {Object} 追加的轮次对象
   */
  appendTurn(options) {
    const { session_id, role, content, created_at, references, skip_if_same_as_last } = options;

    if (skip_if_same_as_last) {
      const lastTurn = this._store.getLastTurn ? this._store.getLastTurn(session_id) : null;
      if (lastTurn && lastTurn.role === role && lastTurn.content === content) {
        return lastTurn;
      }
    }

    return this._store.appendTurn(new ChatTurn({
      session_id,
      role,
      content,
      created_at,
      references,
    }));
  }

  /**
   * 获取或创建活跃会话：若指定 session_id 则查找该会话，否则按 project_id 查找活跃会话
   * @param {Object} [options] - 选项
   * @param {string} [options.project_id] - 项目 ID
   * @param {string} [options.title] - 会话标题
   * @param {string} [options.created_at] - 创建时间
   * @param {string} [options.session_id] - 指定会话 ID
   * @returns {string} 会话 ID
   */
  getOrCreateActiveSession(options = {}) {
    const { project_id, title, created_at, session_id } = options;

    let session;
    if (session_id) {
      session = this._store.getSession(session_id);
    } else {
      session = this._store.getActiveSession(project_id);
    }

    if (!session) {
      const newSession = this._store.createSession(new ChatSession({
        session_id: session_id || undefined,
        project_id,
        title,
        created_at,
      }));
      return newSession.session_id;
    }

    return session.session_id;
  }

  /**
   * 创建新会话
   * @param {Object} [options] - 选项
   * @param {string} [options.project_id] - 项目 ID
   * @param {string} [options.title] - 会话标题
   * @param {string} [options.created_at] - 创建时间
   * @param {string} [options.session_id] - 指定会话 ID
   * @returns {Object} 创建的会话对象
   */
  startNewSession(options = {}) {
    const { project_id, title, created_at, session_id } = options;
    return this._store.createSession(new ChatSession({
      session_id,
      project_id,
      title,
      created_at,
    }));
  }

  /** 重置活跃会话：关闭当前活跃会话并创建新会话 */
  resetActiveSession() {
    const active = this._store.getActiveSession();
    if (active) {
      this._store.updateSession(active.session_id, { status: 'closed' });
    }
    return this._store.createSession(new ChatSession({}));
  }

  /**
   * 查询记忆（简单版）
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @param {string} [sessionId] - 会话 ID（未使用）
   * @returns {Array<Object>} 匹配的记忆条目列表
   */
  queryMemory(query, topK = 3, sessionId = null) {
    return this._store.queryMemory(query, topK, sessionId);
  }

  /**
   * 列出所有活跃记忆事实
   * @param {number} [limit=1000] - 返回数量上限
   * @returns {Array<Object>} 活跃记忆事实列表
   */
  listActiveFacts(limit = 1000) {
    return this._store.listActiveFacts(limit);
  }

  /**
   * 完整记忆查询，返回命中结果、暂定条目、新鲜度信息和弃权信号
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @param {string} [sessionId] - 会话 ID（⚠️ 当前未实现会话范围过滤，查询始终为全局范围，保留供未来扩展）
   * @returns {{ hits: Array, tentative_items: Array, freshness: Object, abstention_signals: Object, memory_context: Object }}
   */
  queryMemoryFull(query, topK = 3, sessionId = null) {
    const hits = this._store.queryMemory(query, topK, sessionId);
    for (const hit of hits) {
      hit._relevanceScore = computeRelevanceScore(query, hit, RELEVANCE_WEIGHTS.search);
    }
    if (hits.length > 0) {
      const queryHash = crypto.createHash('sha256').update(query.trim().toLowerCase()).digest('hex').slice(0, 12);
      for (const hit of hits) {
        this._store.addQueryHash(hit.memory_id, queryHash);
      }
    }
    const tentativeItems = this._store.listMemoryByState('tentative', topK);
    const freshness = this._freshnessPayload(hits);
    const computedConfidence = this._computeConfidence(query, hits);
    const memoryContext = {
      query,
      matched_sessions: this._buildMatchedSessions(sessionId, query, topK),
      matched_turns: this._store.queryTurns(query, topK, sessionId),
      aliases: [...new Set(hits.flatMap(item => item.aliases || []))],
      path_hints: [...new Set(hits.flatMap(item => item.path_hints || []))],
      collection_hints: [...new Set(hits.flatMap(item => item.collection_hints || []))],
      recency_hint: hits[0]?.updated_at || null,
      confidence: computedConfidence,
      memory_intent: false,
      confidence_applied: true,
      lookup_performed: true,
      skipped_reason: null,
      timeline_summary: { memory_ids: hits.map(h => h.memory_id), event_count: 0, recent_events: [] },
      abstained_memories: [],
      temporal_range: null,
      temporal_parse_source: null,
      temporal_fallback: false,
      previous_versions: [],
      freshness_level: freshness.level,
      staleness_note: freshness.note,
      age_days: freshness.age_days,
      confidence_level: this._confidenceLevel(computedConfidence),
      never_seen_entities: [],
      should_abstain: hits.length === 0,
      abstain_reason: hits.length === 0 ? 'no_v2_hits' : '',
      evidence_chains: [],
      reasoning_hints: { abstain: hits.length === 0 },
      agentic_rerank_applied: false,
    };
    return {
      hits,
      tentative_items: tentativeItems,
      freshness,
      abstention_signals: {
        should_abstain: hits.length === 0,
        reason: hits.length === 0 ? 'no_v2_hits' : '',
        never_seen_entities: [],
        abstained_memories: [],
      },
      memory_context: memoryContext,
    };
  }

  /**
   * 记忆上下文查询，返回匹配结果和上下文信息，并注入检索洞察到当前会话
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @param {string} [sessionId] - 会话 ID
   * @returns {Object} 记忆上下文对象，包含 aliases、path_hints、freshness_level 等
   */
  queryMemoryContext(query, topK = 3, sessionId = null) {
    let insightSessionId = sessionId;
    if (!sessionId) {
      const activeSession = this._store.getActiveSession ? this._store.getActiveSession() : null;
      insightSessionId = activeSession?.session_id || null;
    }
    const hits = this._store.queryMemory(query, topK * 2, sessionId);
    const matchedTurns = this._store.queryTurns(query, topK, sessionId);
    const matchedSessions = this._buildMatchedSessions(sessionId, query, topK);
    const freshness = this._freshnessPayload(hits);
    const memoryIds = hits.map(h => h.memory_id);
    const aliases = [...new Set(hits.flatMap(item => item.aliases || []))];
    const pathHints = [...new Set(hits.flatMap(item => item.path_hints || []))];
    const collectionHints = [...new Set(hits.flatMap(item => item.collection_hints || []))];

    if (insightSessionId) {
      const insight = this._buildRetrievalInsight({ query, hits, freshness });
      if (insight) {
        try {
          const recentInsightCount = this._store.getRecentInsightCount(insightSessionId);
          if (recentInsightCount < 3) {
            this.appendTurn({
              session_id: insightSessionId,
              role: 'system',
              content: `[检索洞察] ${insight}`,
              references: { synthetic: 'retrieval_summary', insight_type: 'memory_query' },
            });
          }
        } catch (err) {
          logger.warn(`Insight injection failed: ${err.message}`);
        }
      }
    }

    const computedConfidence = this._computeConfidence(query, hits);
    const computedLevel = this._confidenceLevel(computedConfidence);

    return {
      query,
      hits,
      matched_sessions: matchedSessions,
      matched_turns: matchedTurns,
      aliases,
      path_hints: pathHints,
      collection_hints: collectionHints,
      recency_hint: hits[0]?.updated_at || null,
      confidence: computedConfidence,
      memory_intent: false,
      confidence_applied: hits.length > 0,
      lookup_performed: true,
      skipped_reason: null,
      timeline_summary: { memory_ids: memoryIds, event_count: 0, recent_events: [] },
      abstained_memories: [],
      temporal_range: null,
      temporal_parse_source: null,
      temporal_fallback: false,
      previous_versions: [],
      freshness_level: freshness.level,
      staleness_note: freshness.note,
      age_days: freshness.age_days,
      confidence_level: computedLevel,
      never_seen_entities: [],
      should_abstain: hits.length === 0,
      abstain_reason: hits.length === 0 ? 'no_v2_hits' : '',
      evidence_chains: [],
      reasoning_hints: { abstain: hits.length === 0 },
      agentic_rerank_applied: false,
      summary: {
        total_hits: hits.length,
        session_hits: matchedTurns.length,
        memory_hits: hits.length,
        has_high_confidence: computedConfidence >= 0.7,
        has_relevant_sessions: matchedTurns.length > 0,
        has_relevant_memories: hits.length > 0,
        session_filter_applied: Boolean(sessionId),
      },
    };
  }

  _buildMatchedSessions(sessionId, query, topK = 3) {
    const turns = this._store.queryTurns(query, topK, sessionId);
    if (turns.length === 0) return [];
    const grouped = new Map();
    for (const turn of turns) {
      if (!grouped.has(turn.session_id)) grouped.set(turn.session_id, []);
      grouped.get(turn.session_id).push(turn);
    }
    return [...grouped.entries()].map(([id, matchedTurns]) => {
      const session = this._store.getSession(id);
      return {
        session_id: id,
        title: session?.title || '',
        project_id: session?.project_id || 'default',
        matched_turns: matchedTurns,
      };
    });
  }

  /**
   * 保存一条记忆，支持日写入限额检查、路径提示过滤和去重
   * @param {Object} options - 保存选项
   * @param {string} options.session_id - 会话 ID
   * @param {string} options.content - 记忆内容
   * @param {string[]} [options.aliases] - 别名列表
   * @param {string[]} [options.path_hints] - 路径提示列表
   * @param {string[]} [options.collection_hints] - 集合提示列表
   * @param {string} [options.state] - 状态（tentative/kept）
   * @param {string} [options.source] - 来源（manual/auto_triage/user_explicit/auto_draft）
   * @param {string} [options.created_at] - 创建时间
   * @returns {Object} 保存后的记忆对象，日限额到达时返回 rate_limited 状态
   */
  saveMemory(options) {
    this._maybePeriodicCleanup();
    const {
      session_id,
      content,
      aliases,
      path_hints,
      collection_hints,
      state,
      source,
      created_at,
    } = options;

    const normalizedState = (state || 'tentative').trim() || 'tentative';
    if (!SAVEABLE_STATES.has(normalizedState)) {
      throw new Error(`Unsupported state: ${normalizedState}. Valid states: tentative, kept`);
    }

    // Daily write limit for auto sources
    if (['auto_triage', 'auto_draft'].includes(source)) {
      const dailyCount = this._store.getDailyWriteCount ? this._store.getDailyWriteCount() : 0;
      if (dailyCount >= LOCALMEM_DAILY_WRITE_LIMIT) {
        logger.warn(`Daily write limit reached (${dailyCount}/${LOCALMEM_DAILY_WRITE_LIMIT}), skipping auto memory`);
        return {
          memory_id: '',
          content: content.trim(),
          state: normalizedState,
          status: 'rate_limited',
        };
      }
    }

    const memoryId = crypto.randomUUID();
    const now = created_at || isoNow();

    const filteredPathHints = this._filterPathHints(path_hints || []);
    const normalizedAliases = [...new Set(aliases || [])];
    const normalizedCollectionHints = [...new Set(collection_hints || [])];
    const canonicalKey = canonicalKeyForText(content.trim());

    const existingByCk = this._store.getMemoryByCanonicalKey(canonicalKey);
    if (existingByCk && existingByCk.memory_id !== memoryId) {
      return {
        memory_id: existingByCk.memory_id,
        content: content.trim(),
        state: normalizedState,
        status: 'duplicate',
        duplicate_of: existingByCk.memory_id,
      };
    }

    const saved = this._store.saveMemory(new MemoryFact({
      memory_id: memoryId,
      session_id: session_id,
      content: content.trim(),
      canonical_key: canonicalKey,
      state: normalizedState,
      aliases: normalizedAliases,
      path_hints: filteredPathHints,
      collection_hints: normalizedCollectionHints,
      source: source || 'manual',
      created_at: now,
    }));

    if (session_id && this._store.updateSession) {
      this._store.updateSession(session_id, { updated_at: now });
    }
    this._writeState({ last_memory_id: memoryId, last_updated_at: now });

    // Timeline event
    let timelineEventSaved = true;
    try {
      this._store.addEvent({
        memory_id: memoryId,
        event_type: 'memory_created',
        created_at: now,
        event_data: { state: normalizedState, source: source },
      });
    } catch (error) {
      logger.warn(`Failed to append timeline event: ${error}`);
      timelineEventSaved = false;
    }

    return { ...saved, timeline_event_saved: timelineEventSaved };
  }

  /**
   * 获取单条记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Object|null} 记忆对象，不存在时返回 null
   */
  getMemory(memoryId) {
    return this._store.getMemory(memoryId);
  }

  /**
   * 更新记忆内容
   * @param {string} memoryId - 记忆 ID
   * @param {string} content - 新内容
   * @returns {boolean} 是否更新成功
   */
  updateMemoryContent(memoryId, content) {
    const updated = this._store.updateMemoryContent(memoryId, content);
    if (updated) {
      const now = isoNow();
      this._writeState({ last_memory_id: memoryId, last_updated_at: now });
      return this._store.getMemory(memoryId);
    }
    return null;
  }

  /**
   * 删除记忆（硬删除），先记录删除事件再执行删除
   * @param {string} memoryId - 记忆 ID
   * @returns {boolean} 是否删除成功
   */
  deleteMemory(memoryId) {
    // Record event before deletion (memory won't exist after)
    this._store.addEvent({
      memory_id: memoryId,
      event_type: 'memory_deleted',
      created_at: isoNow(),
      event_data: {},
    });
    return this._store.deleteMemory(memoryId);
  }

  /**
   * 获取存储统计信息
   * @returns {Object} 统计摘要，包含 total、active、tentative、kept、sessions、active_session_id
   */
  stats() {
    const stats = this._store.statsSummary ? this._store.statsSummary() : {};
    return {
      ...stats,
      active_session_id: this._store.activeSessionId ? this._store.activeSessionId() : null,
    };
  }

  /**
   * 获取记忆时间线事件
   * @param {Object} [options] - 查询选项
   * @param {string} [options.memory_id] - 按 ID 过滤的记忆
   * @param {number} [options.limit=50] - 返回数量上限
   * @returns {Object} 时间线对象，包含 filters、event_count、events
   */
  getMemoryTimeline(options = {}) {
    const { memory_id, session_id, limit = 50 } = options;
    const events = this._store.getTimeline(memory_id, limit);
    return {
      filters: { memory_id, session_id, limit },
      event_count: events.length,
      events: events.map(e => ({
        event_id: e.id,
        memory_id: e.memory_id,
        event_type: e.event_type,
        created_at: e.created_at,
        payload: e.payload_json ? JSON.parse(e.payload_json) : {},
      })),
    };
  }

  importTranscriptSession({ transcriptPath, transcriptId, transcriptsRoot: _transcriptsRoot, projectId, title, createdAt, sessionId }) {
    const session = this.startNewSession({
      project_id: projectId,
      title: title || `Import: ${transcriptPath || transcriptId || 'transcript'}`,
      created_at: createdAt,
      session_id: sessionId,
    });

    if (!transcriptPath) {
      return {
        session_id: session.session_id,
        imported_turn_count: 0,
        status: 'created_empty_session',
        warning: 'No transcript_path was provided. Only an empty session was created.',
      };
    }

    const turns = this._parseTranscriptFile(transcriptPath);
    for (const turn of turns) {
      this.appendTurn({
        session_id: session.session_id,
        role: turn.role,
        content: turn.content,
        created_at: turn.created_at || createdAt,
        references: { imported_from: transcriptPath, transcript_id: transcriptId || null },
      });
    }

    return {
      session_id: session.session_id,
      imported_turn_count: turns.length,
      status: turns.length > 0 ? 'imported' : 'created_empty_session',
      warning: turns.length === 0 ? 'Transcript file was parsed but no turns were found.' : undefined,
    };
  }

  _parseTranscriptFile(transcriptPath) {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    if (transcriptPath.endsWith('.jsonl')) {
      return content.split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .map(item => ({
          role: this._normalizeRole(item.role || item.type || 'user'),
          content: String(item.content || item.text || item.message || '').trim(),
          created_at: item.created_at || item.timestamp || null,
        }))
        .filter(turn => turn.content);
    }
    if (transcriptPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      const items = Array.isArray(parsed) ? parsed : (parsed.turns || parsed.messages || []);
      return items.map(item => ({
        role: this._normalizeRole(item.role || item.type || 'user'),
        content: String(item.content || item.text || item.message || '').trim(),
        created_at: item.created_at || item.timestamp || null,
      })).filter(turn => turn.content);
    }
    return this._parseMarkdownTranscript(content);
  }

  _parseMarkdownTranscript(content) {
    const turns = [];
    const sections = content.split(/\n(?=#{1,6}\s+)/);
    for (const section of sections) {
      const match = section.match(/^#{1,6}\s*(user|assistant|system|用户|助手|系统)\b[^\n]*\n([\s\S]*)$/i);
      if (!match) continue;
      const body = match[2].trim();
      if (!body) continue;
      turns.push({ role: this._normalizeRole(match[1]), content: body });
    }
    if (turns.length > 0) return turns;
    const lineTurns = [];
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(user|assistant|system|用户|助手|系统)\s*[:：]\s*(.+)$/i);
      if (match) {
        lineTurns.push({ role: this._normalizeRole(match[1]), content: match[2].trim() });
      }
    }
    return lineTurns;
  }

  _normalizeRole(role) {
    const value = String(role || '').toLowerCase();
    if (value === 'assistant' || value === '助手') return 'assistant';
    if (value === 'system' || value === '系统') return 'system';
    return 'user';
  }

  // ========== Memory Choice (tentative → kept, or discard = DELETE) ==========

  /**
   * 保存用户对记忆的决策：keep（tentative→kept 永久保留）或 discard（硬删除）
   * @param {Object} params - 决策参数
   * @param {string} params.memoryId - 记忆 ID
   * @param {string} params.choice - 决策类型（keep/discard）
   * @param {string} [params.updatedAt] - 更新时间
   * @returns {Object} 决策结果对象
   */
  saveMemoryChoice({ memoryId, choice, updatedAt }) {
    const current = this._store.getMemory(memoryId);
    if (!current) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    if (choice === 'discard') {
      // Hard delete — remove from database entirely
      this._store.deleteMemory(memoryId);
      return { memory_id: memoryId, choice: 'discard', status: 'deleted' };
    }

    if (choice === 'keep') {
      // Confirm: tentative → kept (permanent)
      const now = updatedAt || isoNow();
      this._store.updateMemoryState(memoryId, 'kept', {
        updated_at: now,
        last_choice: choice,
      });
      const updated = this._store.getMemory(memoryId);
      return { ...updated, choice };
    }

    throw new Error(`Unsupported choice: ${choice}. Valid choices: keep, discard`);
  }





  /**
   * 计算命中结果的新鲜度信息
   * @param {Array<Object>} hits - 命中的记忆列表
   * @returns {{ level: string, note: string, age_days: number|null }} 新鲜度级别（fresh/recent/stale/old/none/unknown）
   */
  _freshnessPayload(hits) {
    if (!hits || hits.length === 0) {
      return { level: 'none', note: 'No memory hits', age_days: null };
    }
    const now = Date.now();
    let minAge = Infinity;
    for (const hit of hits) {
      if (hit.updated_at) {
        const age = (now - new Date(hit.updated_at).getTime()) / (1000 * 60 * 60 * 24);
        if (age < minAge) minAge = age;
      }
    }
    if (minAge === Infinity) {
      return { level: 'unknown', note: 'Unable to determine freshness', age_days: null };
    }
    if (minAge < 1) return { level: 'fresh', note: 'Recently updated', age_days: Math.round(minAge * 10) / 10 };
    if (minAge < 7) return { level: 'recent', note: 'Updated within a week', age_days: Math.round(minAge) };
    if (minAge < 30) return { level: 'stale', note: 'Updated within a month', age_days: Math.round(minAge) };
    return { level: 'old', note: 'Not updated recently', age_days: Math.round(minAge) };
  }

  /**
   * 构建检索洞察文本，用于注入到会话中
   * @param {Object} params - 参数
   * @param {string} params.query - 查询文本
   * @param {Array} params.hits - 命中结果
   * @param {Object} params.freshness - 新鲜度信息
   * @returns {string} 洞察文本
   */
  _buildRetrievalInsight({ query, hits, freshness }) {
    const parts = [];
    const hasHits = hits.length > 0;

    if (!hasHits) {
      parts.push(`记忆查询未命中任何结果（query: "${(query || '').slice(0, 60)}..."）。可能原因：记忆库为空、查询文本不匹配，或这是一个全新话题。`);
    } else {
      parts.push(`记忆查询命中 ${hits.length} 条结果，新鲜度 ${freshness.level}。`);
    }

    if (freshness.level === 'stale' || freshness.level === 'old') {
      parts.push(`注意：命中记忆已 ${freshness.age_days} 天未更新，可能已过时。`);
    }

    return parts.join(' ');
  }

  /**
   * 定期清理过期数据（每 24 小时执行一次）：清理旧轮次、旧会话、旧事件、过期暂定记忆
   */
  _maybePeriodicCleanup() {
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    if (this._lastCleanupAt && (now - this._lastCleanupAt) < twentyFourHours) {
      return;
    }
    if (this._cleanupInProgress) return;
    this._cleanupInProgress = true;
    this._lastCleanupAt = now;
    try {
      const sessionAge = LOCALMEM_SESSION_MAX_AGE_DAYS || 60;
      const turnResult = this._store.cleanupOldTurns(sessionAge);
      const sessionResult = this._store.cleanupOldSessions(sessionAge);
      const eventResult = this._store.cleanupOldEvents(30);
      const tentativeResult = this._store.cleanupExpiredTentative(7);
      logger.info(
        `Periodic cleanup: turns=${turnResult.deleted}, sessions=${sessionResult.deleted}, ` +
        `events=${eventResult.deleted}, tentative=${tentativeResult.deleted}`
      );
      this._cleanupConsecutiveFails = 0;
    } catch (err) {
      this._cleanupConsecutiveFails = (this._cleanupConsecutiveFails || 0) + 1;
      logger.warn(`Periodic cleanup failed (${this._cleanupConsecutiveFails} consecutive): ${err.message}`);
      if (this._cleanupConsecutiveFails >= 3) {
        logger.error(`Periodic cleanup has failed ${this._cleanupConsecutiveFails} times in a row - data may accumulate`);
      }
    } finally {
      this._cleanupInProgress = false;
    }
  }

  runMaintenanceCleanup() {
    const previousCleanupAt = this._lastCleanupAt;
    this._lastCleanupAt = 0;
    try {
      this._maybePeriodicCleanup();
      return { ran: true, previous_cleanup_at: previousCleanupAt };
    } catch (err) {
      return { ran: false, error: err.message, previous_cleanup_at: previousCleanupAt };
    }
  }

  /**
   * Auto-triage a conversation turn for memory extraction (async, with governance).
   */
  async autoTriageTurn(options) {
    const { session_id, role, content, previous_content, persist = true, side_llm_gateway } = options;
    const candidates = [];

    if (role === 'assistant' && this._shouldKeepCandidate(content) && this._isKnowledgeAssertion(content)) {
      const aliases = this._extractAliasesFromContent(content);
      if (persist) {
        const saved = await this.saveMemoryWithGovernance({
          session_id,
          content: content.trim(),
          aliases,
          state: 'tentative',
          source: 'auto_triage',
            sideLlmGateway: side_llm_gateway,
        });
        candidates.push(saved);
      } else {
        candidates.push({
          memory_id: `tentative:${session_id}:${canonicalKeyForText(content).slice(0, 12)}`,
          session_id,
          content: content.trim(),
          aliases,
          state: 'tentative',
          canonical_key: canonicalKeyForText(content),
        });
      }
    }

    if (role === 'user' && this._containsExplicitMemoryRequest(content)) {
      const extracted = this._extractMemoryFromUserMessage(content, previous_content);
      if (extracted && this._shouldKeepCandidate(extracted)) {
        const aliases = this._extractAliasesFromContent(extracted);
        if (persist) {
          const saved = await this.saveMemoryWithGovernance({
            session_id,
            content: extracted,
            aliases,
            state: 'tentative',
            source: 'user_explicit',
            sideLlmGateway: side_llm_gateway,
          });
          saved._user_feedback = `我已记住：${extracted.slice(0, 50)}`;
          if (extracted.length >= 500) {
            saved._user_feedback += '（内容较长，已截断保存）';
          }
          candidates.push(saved);
        } else {
          candidates.push({
            memory_id: `tentative:${session_id}:${canonicalKeyForText(extracted).slice(0, 12)}`,
            session_id,
            content: extracted,
            aliases,
            state: 'tentative',
            source: 'user_explicit',
            sideLlmGateway: side_llm_gateway,
            canonical_key: canonicalKeyForText(extracted),
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Save memory with governance conflict detection.
   * For manual sources, falls back to plain saveMemory.
   */
  async saveMemoryWithGovernance(options) {
    const source = options.source || 'manual';
    const isAutoSource = ['auto_triage', 'auto_draft'].includes(source);
    const sideLlmGateway = options.sideLlmGateway || null;

    if (!isAutoSource) {
      return this.saveMemory(options);
    }

    const candidateContent = (options.content || '').trim();
    const tokenRe = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g;
    const allTokens = candidateContent.toLowerCase().match(tokenRe) || [];
    const keywords = allTokens.filter(t => t.length > 1).slice(0, 5);

    let facts;
    if (keywords.length > 0) {
      const allFacts = this._store.listActiveFacts(500);
      facts = allFacts.filter(f => {
        const content = (f.content || '').toLowerCase();
        return keywords.some(kw => content.includes(kw));
      });
      if (facts.length < 3) facts = allFacts.slice(0, 50);
    } else {
      facts = this._store.listActiveFacts(50);
    }

    const plan = await planKnowledgeUpdate({
      content: options.content || '',
      aliases: options.aliases || [],
      path_hints: options.path_hints || [],
      collection_hints: options.collection_hints || [],
      facts,
      sideLlmGateway,
    });

    if (plan.strategy === 'keep_existing') {
      return {
        memory_id: plan.suggestedMemoryId,
        content: options.content,
        state: options.state || 'tentative',
        status: 'governed_kept',
        governance: plan,
      };
    }

    if (plan.strategy === 'supersede_existing' && plan.suggestedMemoryId) {
      return this.supersedeMemory(plan.suggestedMemoryId, options);
    }

    if (plan.strategy === 'resolve_conflict') {
      // Save as tentative with conflict flag for manual resolution
      const saved = this.saveMemory({
        ...options,
        state: 'tentative',
      });
      saved.governance = plan;
      saved.governance_note = `语义冲突检测到 ${plan.conflictMemoryIds.length} 条相关记忆，建议人工审阅`;
      return saved;
    }

    // create_new
    return this.saveMemory(options);
  }

  /**
   * 替代旧记忆：删除旧记忆并插入新记忆，记录替代事件
   * @param {string} oldMemoryId - 旧记忆 ID
   * @param {Object} options - 新记忆选项
   * @returns {Object} 替代结果，包含 oldMemoryId 和 newMemory
   */
  supersedeMemory(oldMemoryId, options) {
    const memoryId = crypto.randomUUID();
    const now = options.created_at || isoNow();
    const newMemory = new MemoryFact({
      memory_id: memoryId,
      session_id: options.session_id,
      content: options.content.trim(),
      canonical_key: canonicalKeyForText(options.content.trim()),
      state: options.state || 'kept',
      aliases: [...new Set(options.aliases || [])],
      path_hints: this._filterPathHints(options.path_hints || []),
      collection_hints: [...new Set(options.collection_hints || [])],
      source: options.source || 'manual',
      created_at: now,
    });
    return this._store.supersedeMemory(oldMemoryId, newMemory);
  }

  /**
   * Plan a knowledge update without persisting (dry-run governance).
   */
  async planKnowledgeUpdateDryRun(options) {
    const facts = this._store.listActiveFacts(500);
    return planKnowledgeUpdate({
      content: options.content || '',
      aliases: options.aliases || [],
      path_hints: options.path_hints || [],
      collection_hints: options.collection_hints || [],
      facts,
    });
  }

  /**
   * 判断内容是否值得保留为记忆候选（长度、信号词过滤）
   * @param {string} content - 待判断内容
   * @param {Object} [sideLlmGateway] - 侧边 LLM 网关（预留参数）
   * @returns {boolean} 是否值得保留
   */
  _shouldKeepCandidate(content) {
    if (!content || content.length < TRIAGE_MIN_CONTENT_LENGTH) return false;
    const cleaned = content.trim();
    if (cleaned.length > TRIAGE_MAX_CONTENT_LENGTH) return false;

    if (TRIAGE_DISCARD_SIGNALS.some(s => cleaned.toLowerCase().includes(s.toLowerCase()))) return false;
    if (TRIAGE_CONFIRM_SIGNALS.some(s => cleaned.toLowerCase().includes(s.toLowerCase()))) return true;

    if (cleaned.includes('规则') || cleaned.includes('约定') ||
        cleaned.toLowerCase().includes('always') || cleaned.toLowerCase().includes('never')) {
      return true;
    }

    const TIME_SENSITIVE_PATTERNS = [
      /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
      /\d{1,2}:\d{2}(:\d{2})?/,
      /[\u4e00-\u9fff]{0,4}(开盘|收盘|午间|盘中|盘后|简报|速评|复盘|行情|涨跌|涨幅|跌幅|上涨|下跌|涨停|跌停)/,
      /[\u4e00-\u9fff]{0,4}(梦境|Dream|dream|浅睡|深睡|REM)/,
      /[\u4e00-\u9fff]{0,4}(systemd|service|daemon|超时|timeout)/,
    ];
    if (TIME_SENSITIVE_PATTERNS.some(p => p.test(cleaned))) return false;

    const ASSISTANT_VALUE_PATTERNS = [
      /【.*】/,
      /(禁止|必须|优先|默认|统一|固定).{5,30}/,
      /^(##|###)\s+.+\n[\s\S]{50,}/,
    ];
    return ASSISTANT_VALUE_PATTERNS.some(p => p.test(cleaned));
  }

  _isKnowledgeAssertion(content) {
    const cleaned = content.trim();

    if (/^已(修复|完成|更新|删除|创建|推送)/.test(cleaned)) return false;

    if (cleaned.startsWith('```') && cleaned.endsWith('```')) return false;

    if (cleaned.length < 15) return false;

    if (/(禁止|必须|优先|默认|统一|固定|约定|规则).{3,}/.test(cleaned)) return true;

    if (/【[^】]+】/.test(cleaned)) return true;

    const mdMatch = /^(##|###)\s+(.+)\n([\s\S]{30,})/.exec(cleaned);
    if (mdMatch) return true;

    return false;
  }

  /**
   * 检测文本中是否包含显式记忆请求关键词（含隐性偏好、决策信号）
   * @param {string} text - 用户文本
   * @returns {boolean} 是否包含记忆请求信号
   */
  _containsExplicitMemoryRequest(text) {
    const lowered = text.toLowerCase();
    // 1. 原有显式信号
    if (EXPLICIT_MEMORY_SIGNALS.some(s => lowered.includes(s.toLowerCase()))) return true;
    
    // 2. 隐性偏好信号（组合匹配）
    const IMPLICIT_PREFERENCE_PATTERNS = [
      /不要\s*.{2,20}(美股|港股|推送|覆盖|包含|看)/,
      /不用\s*.{2,20}(美股|港股|指数|数据|看|管)/,
      /以后.{0,5}(都|统一|只|默认).{2,20}/,
      /只.{0,3}(保留|看|发|推送|包含).{2,20}/,
      /太(长|啰嗦|复杂).{0,10}(以后|下次|统一)/,
      /固定.{0,5}(标题|格式|时间|来源|规则)/,
      /默认.{0,5}(只|不|用).{2,20}/,
      /统一.{0,5}(只|不|用|改).{2,20}/,
    ];
    if (IMPLICIT_PREFERENCE_PATTERNS.some(p => p.test(text))) return true;
    
    // 3. 决策信号
    const DECISION_PATTERNS = [
      /^我.{0,5}(决定|确认|同意|选|用).{2,30}/,
      /^(就|按|用|选).{2,30}(这个|方案|这个规则)/,
      /^(确定|定了|可以|行).{0,10}$/,
    ];
    if (DECISION_PATTERNS.some(p => p.test(text))) return true;
    
    return false;
  }

  /**
   * 从用户消息中提取记忆内容，若含显式记忆请求且存在上文则优先提取上文
   * @param {string} content - 当前用户消息
   * @param {string} [previousContent] - 上一条消息内容
   * @returns {string|null} 提取的记忆内容，不适合记忆时返回 null
   */
  _extractMemoryFromUserMessage(content, previousContent = '') {
    const cleaned = this._cleanUserMessage(content);
    if (cleaned.length > 500) return cleaned.slice(0, 500);

    if (this._containsExplicitMemoryRequest(content) && previousContent) {
      return previousContent.trim().slice(0, 300);
    }
    if (this._containsExplicitMemoryRequest(content)) {
      return cleaned.slice(0, 300);
    }
    return null;
  }

  /**
   * 清洗用户消息：移除系统提醒、附件标签、代码块
   * @param {string} text - 原始消息文本
   * @returns {string} 清洗后的文本
   */
  _cleanUserMessage(text) {
    const hasCodeBlock = text.includes('```');
    let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
    cleaned = cleaned.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '');
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    cleaned = cleaned.trim();
    if (!cleaned) return text.trim();
    if (hasCodeBlock) cleaned += ' [代码块已省略]';
    return cleaned;
  }

  /**
   * 过滤路径提示：去除无效路径并去重
   * @param {string[]} pathHints - 原始路径提示列表
   * @returns {string[]} 过滤去重后的路径提示列表
   */
  _filterPathHints(pathHints) {
    return (pathHints || []).filter((hint, index, self) => {
      if (!hint) return false;
      // 只保留相对路径，拒绝绝对路径、上级目录跳转和敏感目录
      if (path.isAbsolute(hint)) return false;
      if (hint.includes('..')) return false;
      if (hint.includes('node_modules')) return false;
      return self.indexOf(hint) === index;
    });
  }

  /**
   * 从内容中提取别名（动态中文词 + 标题标签 + 代码标识符）
   * @param {string} content - 记忆内容
   * @returns {string[]} 别名列表
   */
  _extractAliasesFromContent(content) {
    const aliases = [];
    
    // 1. 【xxx】主题标签
    const brackets = content.match(/【([^】]+)】/g) || [];
    aliases.push(...brackets.map(m => m.slice(1, -1).trim()));
    
    // 2. 大驼峰/蛇形命名（内联正则）
    const CAMEL_CASE_RE = /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9]*(?:Service|Action|Mapper|ConfigManager|Impl|Exception|Result|Type|Helper|Controller|Manager|Handler|Factory|Builder|Constants|Config)(?![A-Za-z0-9_])/g;
    const SNAKE_CASE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;
    for (const pattern of [CAMEL_CASE_RE, SNAKE_CASE_RE]) {
      const matches = String(content).match(pattern) || [];
      for (const match of matches) {
        if (!aliases.includes(match)) aliases.push(match);
      }
    }
    
    // 3. 动态中文词提取（无需维护词表）
    const dynamicKeywords = this._extractChineseKeywords(content);
    aliases.push(...dynamicKeywords);
    
    return [...new Set(aliases)].slice(0, 10);
  }

  /**
   * 从内容中提取中文关键词（2-6字连续中文字符 + 词频统计）
   * @param {string} text - 原始文本
   * @returns {string[]} 高频中文关键词列表
   */
  _extractChineseKeywords(text) {
    if (!text) return [];
    
    const STOPWORDS = new Set([
      '的', '了', '是', '我', '你', '在', '有', '个', '为', '与', '及', '或',
      '一个', '没有', '可以', '进行', '处理', '相关', '问题', '方案', '新增',
      '这个', '那个', '这样', '然后', '现在', '今天', '明天',
      '什么', '怎么', '如何', '为什么', '是否', '多少', '哪些',
    ]);
    
    // 提取所有 2-6 字连续中文字符串
    const matches = text.match(/[\u4e00-\u9fff]{2,6}/g) || [];
    
    // 统计词频
    const freq = {};
    for (const word of matches) {
      if (STOPWORDS.has(word)) continue;
      freq[word] = (freq[word] || 0) + 1;
    }
    
    // 按频率排序，取前 5 个
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /** 确保存储目录和状态文件存在 */
  _ensureLayout() {
    if (!fs.existsSync(this._root)) {
      fs.mkdirSync(this._root, { recursive: true });
    }

    const metaDir = path.join(this._root, 'meta');

    if (!fs.existsSync(metaDir)) {
      fs.mkdirSync(metaDir, { recursive: true });
    }

    if (!fs.existsSync(this._statePath)) {
      fs.writeFileSync(this._statePath, JSON.stringify({}, null, 2), 'utf8');
    }
  }



  // ========== Review API ==========

  /**
   * 列出待审核记忆（state='tentative'）
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 待审核记忆列表
   */
  listReviews(limit = 50) {
    return this._store.listMemoryByState('tentative', limit);
  }

  /**
   * 提升待审核记忆为永久（kept）
   * @param {string} memoryId - 记忆 ID
   * @param {Object} [evaluation] - 可选的评估结果
   * @returns {Object} 操作结果
   */
  promoteReview(memoryId, evaluation = null) {
    const memory = this._store.getMemory(memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.state !== 'tentative') throw new Error(`Memory is not in tentative state: ${memory.state}`);

    const autoPromoted = Boolean(
      evaluation && typeof evaluation.score === 'number' && evaluation.score >= 0.8
    );

    if (evaluation) {
      this._store.evaluateMemory(memoryId, evaluation);
    }
    this._store.updateMemoryState(memoryId, 'kept');
    this._store.addEvent({
      memory_id: memoryId,
      event_type: autoPromoted ? 'review_auto_promoted' : 'review_promoted',
      created_at: new Date().toISOString(),
      event_data: {
        evaluation,
        previous_state: 'tentative',
        auto_promoted: autoPromoted,
        score: evaluation?.score ?? null,
      },
    });
    return {
      success: true,
      memory_id: memoryId,
      action: 'promoted',
      state: 'kept',
      auto_promoted: autoPromoted,
      score: evaluation?.score ?? null,
    };
  }

  /**
   * 丢弃待审核记忆（硬删除）
   * @param {string} memoryId - 记忆 ID
   * @returns {Object} 操作结果
   */
  discardReview(memoryId) {
    const memory = this._store.getMemory(memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);

    this._store.addEvent({
      memory_id: memoryId,
      event_type: 'review_discarded',
      created_at: new Date().toISOString(),
      event_data: { previous_state: memory.state },
    });
    this._store.deleteMemory(memoryId);
    return { success: true, memory_id: memoryId, action: 'discarded' };
  }

  /**
   * 评估待审核记忆（存储 LLM 评估结果，不修改状态）
   * @param {string} memoryId - 记忆 ID
   * @param {Object} evaluation - 评估结果 { score, reasoning, recommendation }
   * @returns {Object} 操作结果
   */
  evaluateReview(memoryId, evaluation) {
    const memory = this._store.getMemory(memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);

    this._store.evaluateMemory(memoryId, evaluation);
    this._store.addEvent({
      memory_id: memoryId,
      event_type: 'review_evaluated',
      created_at: new Date().toISOString(),
      event_data: { evaluation },
    });
    return { success: true, memory_id: memoryId, evaluation };
  }

  /**
   * 写入状态文件（合并更新）
   * @param {Object} [extra] - 需要更新的额外状态字段
   */
  _writeState(extra = {}) {
    let current = {};
    try {
      if (fs.existsSync(this._statePath)) {
        current = JSON.parse(fs.readFileSync(this._statePath, 'utf8'));
      }
    } catch (error) {
      logger.warn(`Failed to read state file: ${error}`);
    }

    const updated = { ...current, ...extra };
    const tmpPath = this._statePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmpPath, this._statePath);
  }

  _computeConfidence(query, hits) {
    if (!hits || hits.length === 0) return 0.0;
    const topN = hits.slice(0, Math.min(3, hits.length));
    const scores = topN.map(h => computeRelevanceScore(query, h, RELEVANCE_WEIGHTS.confidence));
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  _confidenceLevel(confidence) {
    if (confidence >= 0.8) return 'high';
    if (confidence >= 0.5) return 'medium';
    if (confidence > 0) return 'low';
    return 'none';
  }
}

export default LocalMemoryStore;
