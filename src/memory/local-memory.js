/**
 * Local memory store - provides high-level memory operations
 * with autoTriage, dailyWriteLimit, and timeline integration.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { logger, LOCALMEM_DIR, LOCALMEM_FACT_MAX_AGE_DAYS, PROJECT_ROOT } from '../config.js';
import { SqliteStore } from './sqlite-store.js';
import { ChatTurn, ChatSession, MemoryFact, isoNow, canonicalKeyForText, TRIAGE_CONFIRM_SIGNALS, TRIAGE_DISCARD_SIGNALS, TRIAGE_MIN_CONTENT_LENGTH, TRIAGE_MAX_CONTENT_LENGTH } from './models.js';
import { planKnowledgeUpdate } from './governance.js';

// ========== Saveable states ==========
// localMem has two states:
//   tentative — temporary, auto-extracted, expires after 7 days unless confirmed
//   kept      — permanent, user-confirmed, persists in SQLite indefinitely
// Discarding a memory = hard DELETE from the database.
// Wiki is independently managed by the LLMWiki compiler.
const SAVEABLE_STATES = new Set([
  'tentative', 'kept',
]);

const EXPLICIT_MEMORY_SIGNALS = [
  '记住', '记下来', '以后都这样', '这个规则', '别忘了',
  '记住这个', '以后注意', '固定规则', '以后统一',
  '这个很重要', '帮我存一下', '记一下', '这个别忘了',
  '帮我记着', '存一下', '留个底', '备注一下', '这个要留档',
  'always', 'never', 'must', 'from now on', 'make sure',
  'remember this', 'note this', 'keep this',
];

export class LocalMemoryStore {
  constructor(options = {}) {
    const rootDir = options.rootDir || LOCALMEM_DIR;
    this._root = path.resolve(rootDir);
    this._projectRoot = options.projectRoot || PROJECT_ROOT;
    this._dbPath = path.join(this._root, 'memory.db');
    this._statePath = path.join(this._root, 'meta', 'state.json');
    
    this._factMaxAgeDays = options.factMaxAgeDays || LOCALMEM_FACT_MAX_AGE_DAYS;
    
    this._ensureLayout();
    this._store = new SqliteStore(this._dbPath);
  }

  close() {
    this._store.close();
  }

  appendTurn(options) {
    const { session_id, role, content, project_id, title, created_at, references, skip_if_same_as_last } = options;

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

  startNewSession(options = {}) {
    const { project_id, title, created_at, session_id } = options;
    return this._store.createSession(new ChatSession({
      session_id,
      project_id,
      title,
      created_at,
    }));
  }

  resetActiveSession() {
    const active = this._store.getActiveSession();
    if (active) {
      this._store.updateSession(active.session_id, { status: 'closed' });
    }
    return this._store.createSession(new ChatSession({}));
  }

  queryMemory(query, topK = 3, sessionId = null) {
    return this._store.queryMemory(query, topK);
  }

  listActiveFacts(limit = 1000) {
    return this._store.listActiveFacts(limit);
  }

  queryMemoryFull(query, topK = 3, sessionId = null) {
    this._maybePeriodicCleanup();
    const hits = this._store.queryMemory(query, topK);
    const tentativeItems = this._store.listMemoryByState('tentative', topK);
    const freshness = this._freshnessPayload(hits);
    const memoryContext = {
      query,
      matched_sessions: [],
      matched_turns: [],
      aliases: [...new Set(hits.flatMap(item => item.aliases || []))],
      path_hints: [...new Set(hits.flatMap(item => item.path_hints || []))],
      collection_hints: [...new Set(hits.flatMap(item => item.collection_hints || []))],
      recency_hint: hits[0]?.updated_at || null,
      confidence: hits[0] ? 1.0 : 0.0,
      memory_intent: false,
      confidence_applied: false,
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
      confidence_level: hits.length > 0 ? 'medium' : 'low',
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

  queryMemoryContext(query, topK = 3, sessionId = null) {
    this._maybePeriodicCleanup();
    // 如果未传 sessionId，尝试获取当前活跃会话
    if (!sessionId) {
      const activeSession = this._store.getActiveSession ? this._store.getActiveSession() : null;
      sessionId = activeSession?.session_id || null;
    }
    const hits = this._store.queryMemory(query, topK * 2);
    const freshness = this._freshnessPayload(hits);
    const memoryIds = hits.map(h => h.memory_id);
    const aliases = [...new Set(hits.flatMap(item => item.aliases || []))];
    const pathHints = [...new Set(hits.flatMap(item => item.path_hints || []))];
    const collectionHints = [...new Set(hits.flatMap(item => item.collection_hints || []))];

    if (sessionId) {
      const insight = this._buildRetrievalInsight({ query, hits, freshness });
      if (insight) {
        try {
          this.appendTurn({
            session_id: sessionId,
            role: 'system',
            content: `[检索洞察] ${insight}`,
            references: { synthetic: 'retrieval_summary', insight_type: 'memory_query' },
          });
        } catch (err) {
          logger.warn(`Insight injection failed: ${err.message}`);
        }
      }
    }

    return {
      query,
      matched_sessions: [],
      matched_turns: [],
      aliases,
      path_hints: pathHints,
      collection_hints: collectionHints,
      recency_hint: hits[0]?.updated_at || null,
      confidence: hits[0] ? 1.0 : 0.0,
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
      confidence_level: hits.length > 0 ? 'medium' : 'low',
      never_seen_entities: [],
      should_abstain: hits.length === 0,
      abstain_reason: hits.length === 0 ? 'no_v2_hits' : '',
      evidence_chains: [],
      reasoning_hints: { abstain: hits.length === 0 },
      agentic_rerank_applied: false,
      summary: {
        total_hits: hits.length,
        session_hits: 0,
        memory_hits: hits.length,
        has_high_confidence: hits.length > 0,
        has_relevant_sessions: false,
        has_relevant_memories: hits.length > 0,
      },
    };
  }

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
    if (['auto_triage', 'user_explicit', 'auto_draft'].includes(source)) {
      const dailyCount = this._store.getDailyWriteCount ? this._store.getDailyWriteCount() : 0;
      if (dailyCount >= 20) {
        logger.warn(`Daily write limit reached (${dailyCount}), skipping auto memory`);
        return {
          memory_id: '',
          content: content.trim(),
          state: normalizedState,
          status: 'rate_limited',
        };
      }
    }

    const memoryId = `${session_id}-${crypto.randomBytes(4).toString('hex')}`;
    const now = created_at || isoNow();

    const filteredPathHints = this._filterPathHints(path_hints || []);
    const normalizedAliases = [...new Set(aliases || [])];
    const normalizedCollectionHints = [...new Set(collection_hints || [])];
    const canonicalKey = canonicalKeyForText(content.trim());

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

    this._store.updateSession && this._store.updateSession(session_id, { updated_at: now });
    this._writeState({ last_memory_id: memoryId, last_updated_at: now });

    // Timeline event
    try {
      this._store.addEvent({
        memory_id: memoryId,
        event_type: 'memory_created',
        created_at: now,
        event_data: { state: normalizedState, source: source },
      });
    } catch (error) {
      logger.warn(`Failed to append timeline event: ${error}`);
    }

    return saved;
  }

  getMemory(memoryId) {
    return this._store.getMemory(memoryId);
  }

  updateMemoryContent(memoryId, content) {
    const updated = this._store.updateMemoryContent(memoryId, content);
    if (updated) {
      const now = isoNow();
      this._writeState({ last_memory_id: memoryId, last_updated_at: now });
    }
    return updated;
  }

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

  stats() {
    const stats = this._store.statsSummary ? this._store.statsSummary() : {};
    return {
      ...stats,
      active_session_id: this._store.activeSessionId ? this._store.activeSessionId() : null,
    };
  }

  getMemoryTimeline(options = {}) {
    const { memory_id, limit = 50 } = options;
    const events = this._store.getTimeline(memory_id, limit);
    return {
      filters: { memory_id, limit },
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

  // ========== Memory Choice (tentative → kept, or discard = DELETE) ==========

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
    if (minAge < 1) return { level: 'fresh', note: 'Recently updated', age_days: Math.floor(minAge) };
    if (minAge < 7) return { level: 'recent', note: 'Updated within a week', age_days: Math.floor(minAge) };
    if (minAge < 30) return { level: 'stale', note: 'Updated within a month', age_days: Math.floor(minAge) };
    return { level: 'old', note: 'Not updated recently', age_days: Math.floor(minAge) };
  }

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

  _maybePeriodicCleanup() {
    const now = Date.now();
    const sixHours = 6 * 60 * 60 * 1000;
    if (this._lastCleanupAt && (now - this._lastCleanupAt) < sixHours) {
      return;
    }
    this._lastCleanupAt = now;
    try {
      const sessionAge = Math.min(this._factMaxAgeDays || 180, 60);
      const turnResult = this._store.cleanupOldTurns(sessionAge);
      const sessionResult = this._store.cleanupOldSessions(sessionAge);
      const eventResult = this._store.cleanupOldEvents(30);
      const tentativeResult = this._store.cleanupExpiredTentative(7);
      logger.info(
        `Periodic cleanup: turns=${turnResult.deleted}, sessions=${sessionResult.deleted}, ` +
        `events=${eventResult.deleted}, tentative=${tentativeResult.deleted}`
      );
    } catch (err) {
      logger.warn(`Periodic cleanup failed: ${err.message}`);
    }
  }

  /**
   * Auto-triage a conversation turn for memory extraction (async, with governance).
   */
  async autoTriageTurn(options) {
    const { session_id, role, content, previous_role, previous_content, persist = true, side_llm_gateway } = options;
    const candidates = [];

    if (role === 'assistant' && this._shouldKeepCandidate(content, side_llm_gateway)) {
      if (persist) {
        const saved = await this.saveMemoryWithGovernance({
          session_id,
          content: content.trim(),
          state: 'tentative',
          source: 'auto_triage',
        });
        candidates.push(saved);
      } else {
        candidates.push({
          memory_id: `tentative:${session_id}:${canonicalKeyForText(content).slice(0, 12)}`,
          session_id,
          content: content.trim(),
          state: 'tentative',
          canonical_key: canonicalKeyForText(content),
        });
      }
    }

    if (role === 'user' && this._containsExplicitMemoryRequest(content)) {
      const extracted = this._extractMemoryFromUserMessage(content, previous_content);
      if (extracted && this._shouldKeepCandidate(extracted, side_llm_gateway)) {
        if (persist) {
          const saved = await this.saveMemoryWithGovernance({
            session_id,
            content: extracted,
            state: 'tentative',
            source: 'user_explicit',
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
            state: 'tentative',
            source: 'user_explicit',
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
    const isAutoSource = ['auto_triage', 'user_explicit', 'auto_draft'].includes(source);

    if (!isAutoSource) {
      return this.saveMemory(options);
    }

    const facts = this._store.listActiveFacts(500);
    const plan = await planKnowledgeUpdate({
      content: options.content || '',
      aliases: options.aliases || [],
      path_hints: options.path_hints || [],
      collection_hints: options.collection_hints || [],
      facts,
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

  supersedeMemory(oldMemoryId, options) {
    const memoryId = `${options.session_id || 'manual'}-${crypto.randomBytes(4).toString('hex')}`;
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

  _shouldKeepCandidate(content, sideLlmGateway) {
    if (!content || content.length < TRIAGE_MIN_CONTENT_LENGTH) return false;
    const cleaned = content.trim();
    if (cleaned.length > TRIAGE_MAX_CONTENT_LENGTH) return false;

    if (TRIAGE_DISCARD_SIGNALS.some(s => cleaned.toLowerCase().includes(s.toLowerCase()))) return false;
    if (TRIAGE_CONFIRM_SIGNALS.some(s => cleaned.toLowerCase().includes(s.toLowerCase()))) return true;

    if (cleaned.includes('规则') || cleaned.includes('约定') ||
        cleaned.toLowerCase().includes('always') || cleaned.toLowerCase().includes('never')) {
      return true;
    }

    return cleaned.length >= 30;
  }

  _containsExplicitMemoryRequest(text) {
    const lowered = text.toLowerCase();
    return EXPLICIT_MEMORY_SIGNALS.some(s => lowered.includes(s.toLowerCase()));
  }

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

  _filterPathHints(pathHints) {
    return (pathHints || []).filter(hint => {
      if (!hint || !path.isAbsolute(hint)) return true;
      try {
        path.relative(this._projectRoot, path.resolve(hint));
        return true;
      } catch {
        return false;
      }
    }).filter((hint, index, self) => self.indexOf(hint) === index);
  }

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
    fs.writeFileSync(this._statePath, JSON.stringify(updated, null, 2), 'utf8');
  }
}

export default LocalMemoryStore;
