/**
 * Memory routes.
 * Handles all /api/memory/* endpoints.
 */

import { sanitizeQuery } from '../api/sanitize.js';
import { MemoryQueryRequest, MemoryQueryContextRequest, MemorySaveRequest, SessionTurnRequest, StartMemorySessionRequest, AutoTriageRequest, GovernancePlanUpdateRequest } from '../api/contract.js';
import { validateBody, isPathInsideRoot } from '../middleware/validation.js';
import fs from 'fs';
import path from 'path';

/**
 * Register memory routes
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 * @param {Object} context - Shared context
 */
export async function memoryRoutes(fastify, context) {
  const { knowledgeBase, queryExporter, metrics, sideLlmGateway, PROJECT_ROOT, logger } = context;

  /** 查询记忆 */
  fastify.post('/api/memory/query', { preHandler: [validateBody(MemoryQueryRequest)] }, async (request, reply) => {
    const { query, top_k, include_wiki } = request.body;
    const sq = sanitizeQuery(String(query));
    if (!sq.valid) {
      logger.warn(`query: rejected metadata wrapper query (reason=${sq.reason})`);
      metrics.sanitizeRejectedCount += 1;
      reply.code(422);
      return {
        success: false,
        error: 'query_contains_only_metadata',
        message: '收到的查询仅包含 OpenClaw 元数据包装块，未包含用户消息内容，无法执行语义搜索',
        should_skip_middleware: true,
        reason: sq.reason,
        diagnostic: {
          issue: 'query_contains_only_metadata',
          hint: 'OpenClaw should pass user message content, not the metadata wrapper',
          original_query_prefix: String(query).slice(0, 120),
        },
      };
    }
    const effectiveQuery = sq.cleaned;
    if (sq.reason !== 'ok') {
      logger.info(`query: cleaned metadata from query (reason=${sq.reason}, len=${effectiveQuery.length})`);
      metrics.sanitizeMetadataCount += 1;
    }
    const result = await knowledgeBase.queryMemory(effectiveQuery, top_k);
    const freshness = result.freshness || { level: 'unknown', note: '', age_days: null };

    if (include_wiki) {
      const wikiResults = knowledgeBase.wikiSearch(effectiveQuery, top_k || 3);

      const memItems = (result.hits || result.items || []).map(r => ({
        id: r.memory_id,
        content: r.content || '',
        source_type: 'memory',
        state: r.state,
        score: r._relevanceScore || 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      const wikiItems = (wikiResults || []).map(r => ({
        id: r.pageName,
        content: r.snippet || '',
        source_type: 'wiki',
        state: 'kept',
        score: r.score || 0,
        created_at: null,
        updated_at: null,
      }));

      const dedupedWikiItems = wikiItems.filter(w => {
        const title = (w.id || '').replace('.md', '');
        if (!title) return true;
        return !memItems.some(m =>
          (m.content || '').toLowerCase().includes(title.toLowerCase())
        );
      });

      const merged = [...memItems, ...dedupedWikiItems]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, top_k || 5);

      return {
        query: effectiveQuery,
        hits: merged,
        total: merged.length,
        include_wiki: true,
        freshness_level: freshness.level,
        tentative_count: (result.tentative_items || []).length,
      };
    }

    return {
      query: effectiveQuery,
      hits: (result.hits || []).map(h => ({
        id: h.memory_id,
        content: h.content || '',
        source_type: 'memory',
        state: h.state,
        score: h._relevanceScore || 0,
        created_at: h.created_at,
        updated_at: h.updated_at,
      })),
      total: (result.hits || []).length,
      tentative_items: (result.tentative_items || []).map(t => ({
        id: t.memory_id,
        content: t.content || '',
        state: t.state,
        source: t.source,
        created_at: t.created_at,
      })),
      freshness_level: freshness.level,
      abstention_signals: result.abstention_signals || {},
    };
  });

  /** 查询记忆上下文（含会话关联），可选导出调试信息 */
  fastify.post('/api/memory/query-context', { preHandler: [validateBody(MemoryQueryContextRequest)] }, async (request, reply) => {
    const { query, top_k, session_id, include_debug } = request.body;
    const sq = sanitizeQuery(String(query));
    if (!sq.valid) {
      logger.warn(`query-context: rejected metadata wrapper query (reason=${sq.reason})`);
      metrics.sanitizeRejectedCount += 1;
      reply.code(422);
      return {
        success: false,
        error: 'query_contains_only_metadata',
        message: '收到的查询仅包含 OpenClaw 元数据包装块，未包含用户消息内容，无法执行语义搜索',
        should_skip_middleware: true,
        reason: sq.reason,
        diagnostic: {
          issue: 'query_contains_only_metadata',
          hint: 'OpenClaw should pass user message content, not the metadata wrapper',
          original_query_prefix: String(query).slice(0, 120),
        },
      };
    }
    const effectiveQuery = sq.cleaned;
    if (sq.reason !== 'ok') {
      logger.info(`query-context: cleaned metadata from query (reason=${sq.reason}, len=${effectiveQuery.length})`);
      metrics.sanitizeMetadataCount += 1;
    }
    const result = await knowledgeBase.queryMemoryContext(effectiveQuery, top_k, session_id);
    if (include_debug && queryExporter) {
      await queryExporter.exportQueryContext({ query: effectiveQuery, result });
    }
    const memHits = (result.hits || []).map(h => ({
      id: h.memory_id,
      content: h.content || '',
      source_type: 'memory',
      state: h.state,
      score: h._relevanceScore || 0,
      created_at: h.created_at,
      updated_at: h.updated_at,
    }));

    const response = {
      query: effectiveQuery,
      hits: memHits,
      total: memHits.length,
      matched_sessions: result.matched_sessions || [],
      matched_turns: result.matched_turns || [],
      freshness_level: result.freshness_level || 'unknown',
      context: {
        aliases: result.aliases || [],
        path_hints: result.path_hints || [],
        collection_hints: result.collection_hints || [],
        confidence: result.confidence || 0,
        confidence_level: result.confidence_level || 'none',
        should_abstain: result.should_abstain || false,
        abstain_reason: result.abstain_reason || '',
        recency_hint: result.recency_hint || null,
        summary: result.summary || {},
      },
    };
    metrics.lastQueryContext = {
      query: effectiveQuery,
      total: memHits.length,
      matched_turn_count: (result.matched_turns || []).length,
      confidence: result.confidence || 0,
      should_abstain: result.should_abstain || false,
      at: new Date().toISOString(),
    };
    logger.info(`Query-context summary: query="${effectiveQuery.slice(0, 80)}" hits=${memHits.length} matched_turns=${(result.matched_turns || []).length} confidence=${result.confidence || 0}`);
    return response;
  });

  /** 获取记忆时间线 */
  fastify.get('/api/memory/timeline', async (request, reply) => {
    const { memory_id, session_id, limit } = request.query;
    const result = await knowledgeBase.memoryTimeline({ memoryId: memory_id, sessionId: session_id, limit: parseInt(limit) || 50 });
    return { success: true, data: result };
  });

  /** 追加一轮对话到当前会话 */
  fastify.post('/api/memory/turn', { preHandler: [validateBody(SessionTurnRequest)] }, async (request, reply) => {
    const { session_id, role, content, previous_role, previous_content, project_id, title, created_at, references } = request.body;
    const result = await knowledgeBase.appendSessionTurn({
      sessionId: session_id, role, content, projectId: project_id, title, createdAt: created_at, references,
    });

    if (!metrics.autoTriageDisabled) {
      knowledgeBase.memoryFacade.localMemory.autoTriageTurn({
        session_id, role, content, previous_role, previous_content, persist: true, side_llm_gateway: sideLlmGateway,
      }).then((candidates) => {
        metrics.autoTriageSuccessCount += 1;
        metrics.autoTriageConsecutiveFails = 0;
        metrics.autoTriageDisabled = false;
        metrics.autoTriageDisabledAt = null;
        recordAutoTriageResult({ status: 'success', candidates: candidates || [] });
      }).catch(err => {
        metrics.autoTriageFailCount += 1;
        metrics.autoTriageConsecutiveFails += 1;
        recordAutoTriageResult({ status: 'failed', error: err });
        logger.warn(`autoTriage failed for turn (${metrics.autoTriageConsecutiveFails} consecutive): ${err.message}`);
        try {
          const store = knowledgeBase?.memoryFacade?.localMemory?._store;
          if (store?.addEvent) {
            store.addEvent({
              memory_id: 'auto_triage',
              event_type: 'auto_triage_failure',
              created_at: new Date().toISOString(),
              event_data: { consecutiveFails: metrics.autoTriageConsecutiveFails, totalFails: metrics.autoTriageFailCount, error: err.message },
            });
          }
        } catch (logErr) {
          logger.warn(`Failed to persist autoTriage failure event: ${logErr.message}`);
        }
        if (metrics.autoTriageConsecutiveFails >= 5 && !metrics.autoTriageDisabled) {
          metrics.autoTriageDisabled = true;
          metrics.autoTriageDisabledAt = new Date().toISOString();
          try {
            const store = knowledgeBase?.memoryFacade?.localMemory?._store;
            if (store?.addEvent) {
              store.addEvent({
                memory_id: 'auto_triage',
                event_type: 'auto_triage_disabled',
                created_at: new Date().toISOString(),
                event_data: { disabled_at: metrics.autoTriageDisabledAt, consecutiveFails: metrics.autoTriageConsecutiveFails },
              });
            }
          } catch (logErr) {
            logger.warn(`Failed to persist auto_triage_disabled event: ${logErr.message}`);
          }
          const alertPath = path.join(PROJECT_ROOT, 'memory', 'autoTriage-alert.json');
          try {
            fs.writeFileSync(alertPath, JSON.stringify({
              alert: 'autoTriage_consecutive_failures',
              consecutiveFails: metrics.autoTriageConsecutiveFails,
              totalFails: metrics.autoTriageFailCount,
              lastError: err.message,
              disabled: true,
              timestamp: new Date().toISOString(),
            }, null, 2));
          } catch (writeErr) {
            logger.warn(`Failed to write autoTriage alert file: ${writeErr.message}`);
          }
        }
      });
    } else {
      logger.debug(`autoTriage skipped (disabled since ${metrics.autoTriageDisabledAt})`);
    }

    return {
      success: true,
      ...result,
      auto_triage: metrics.autoTriageDisabled
        ? { mode: 'async', accepted: false, disabled: true, disabled_at: metrics.autoTriageDisabledAt }
        : { mode: 'async', accepted: true, semantic_compare_enabled: Boolean(sideLlmGateway) },
    };
  });

  /** 单条 autoTriage：对一条 turn 执行自动沉淀判断 */
  fastify.post('/api/memory/auto-triage', { preHandler: [validateBody(AutoTriageRequest)] }, async (request, reply) => {
    const { session_id, role, content, previous_role, previous_content } = request.body;
    const candidates = await knowledgeBase.memoryFacade.localMemory.autoTriageTurn({
      session_id, role, content, previous_role, previous_content, persist: true, side_llm_gateway: sideLlmGateway,
    });
    recordAutoTriageResult({ status: 'success', candidates });
    return { success: true, candidates, count: candidates.length, semantic_compare_enabled: Boolean(sideLlmGateway) };
  });

  /** 批量 autoTriage：处理指定时间范围内的 turns */
  fastify.post('/api/memory/auto-triage/batch', async (request, reply) => {
    const { hours = 24 } = request.body || {};
    const localMemory = knowledgeBase.memoryFacade.localMemory;
    const turns = localMemory.getTurnsSince(hours);

    const results = [];
    let dailyLimitReached = false;
    for (const turn of turns) {
      if (dailyLimitReached) break;
      const prevTurn = localMemory.getPreviousTurn(turn.session_id, turn.created_at);

      const candidates = await localMemory.autoTriageTurn({
        session_id: turn.session_id,
        role: turn.role,
        content: turn.content,
        previous_role: prevTurn?.role,
        previous_content: prevTurn?.content,
        persist: true,
        side_llm_gateway: sideLlmGateway,
      });
      for (const c of candidates) {
        if (c.status === 'rate_limited') {
          dailyLimitReached = true;
          break;
        }
      }
      if (candidates.length > 0) {
        results.push({ turn_id: turn.id, candidates });
      }
    }
    return {
      success: true,
      processed: turns.length,
      extracted: results.length,
      daily_limit_reached: dailyLimitReached,
      semantic_compare_enabled: Boolean(sideLlmGateway),
      results,
    };
  });

  /** 启动新的记忆会话 */
  fastify.post('/api/memory/session/start', { preHandler: [validateBody(StartMemorySessionRequest)] }, async (request, reply) => {
    const { project_id, title, created_at, session_id } = request.body;
    const result = await knowledgeBase.startMemorySession({ projectId: project_id, title, createdAt: created_at, sessionId: session_id });
    return { success: true, session_id: result };
  });

  /** 重置当前活跃会话 */
  fastify.post('/api/memory/session/reset', async (request, reply) => {
    const result = await knowledgeBase.resetMemorySession();
    return { success: true, ...result };
  });

  /** 导入外部对话记录为会话 */
  fastify.post('/api/memory/session/import-transcript', async (request, reply) => {
    const { transcript_path, transcript_id, transcripts_root, project_id, title, created_at, session_id } = request.body;
    if (transcript_path) {
      const resolved = path.resolve(transcript_path);
      let realPath;
      try {
        realPath = fs.realpathSync(resolved);
      } catch {
        reply.code(403);
        return { success: false, error: 'Access denied' };
      }
      let allowedRoot;
      try {
        allowedRoot = fs.realpathSync(path.resolve(PROJECT_ROOT));
      } catch {
        reply.code(500);
        return { success: false, error: 'PROJECT_ROOT is not readable' };
      }
      if (!isPathInsideRoot(allowedRoot, realPath)) {
        reply.code(403);
        return { success: false, error: 'Access denied' };
      }
      if (!resolved.endsWith('.md') && !resolved.endsWith('.json') && !resolved.endsWith('.jsonl')) {
        reply.code(400);
        return { success: false, error: 'Only .md, .json, .jsonl files are allowed' };
      }
    }
    const result = await knowledgeBase.importTranscriptSession({
      transcriptPath: transcript_path, transcriptId: transcript_id, transcriptsRoot: transcripts_root,
      projectId: project_id, title, createdAt: created_at, sessionId: session_id,
    });
    return {
      success: result.status === 'imported',
      session_id: result.session_id,
      imported_turn_count: result.imported_turn_count || 0,
      status: result.status,
      warning: result.warning,
    };
  });

  /** 保存记忆（可选走治理流程） */
  fastify.post('/api/memory/save', { preHandler: [validateBody(MemorySaveRequest)] }, async (request, reply) => {
    const { session_id, content, state, aliases, path_hints, collection_hints, source, use_governance } = request.body;
    const options = {
      session_id, content, state, aliases, path_hints, collection_hints, source: source || 'manual',
    };
    const result = use_governance
      ? await knowledgeBase.saveMemoryWithGovernance(options)
      : knowledgeBase.saveMemory(options);
    return { success: true, ...result };
  });

  /** 获取单条记忆 */
  fastify.get('/api/memory/:id', async (request, reply) => {
    const { id } = request.params;
    const memory = await knowledgeBase.getMemory(id);
    if (!memory) {
      reply.code(404);
      return { success: false, error: 'Memory not found' };
    }
    return { success: true, data: memory };
  });

  /** 更新记忆内容 */
  fastify.put('/api/memory/:id', async (request, reply) => {
    const { id } = request.params;
    const { content } = request.body || {};
    if (!content || content.trim().length === 0) {
      reply.code(400);
      return { success: false, error: 'content is required' };
    }
    const existing = await knowledgeBase.getMemory(id);
    if (!existing) {
      reply.code(404);
      return { success: false, error: 'Memory not found' };
    }
    const updated = await knowledgeBase.updateMemoryContent(id, content);
    if (!updated) {
      reply.code(404);
      return { success: false, error: 'Memory not found or update failed' };
    }
    return { success: true, data: updated };
  });

  /** 删除记忆 */
  fastify.delete('/api/memory/:id', async (request, reply) => {
    const { id } = request.params;
    const existing = await knowledgeBase.getMemory(id);
    if (!existing) {
      reply.code(404);
      return { success: false, error: 'Memory not found' };
    }
    await knowledgeBase.deleteMemory(id);
    return { success: true, memory_id: id, action: 'deleted' };
  });

  /** 治理流程：预览知识更新计划（不实际写入） */
  fastify.post('/api/memory/governance/plan-update', { preHandler: [validateBody(GovernancePlanUpdateRequest)] }, async (request, reply) => {
    const { content, aliases, path_hints, collection_hints } = request.body;
    const result = await knowledgeBase.planKnowledgeUpdateDryRun({
      content, aliases, path_hints, collection_hints,
    });
    return { success: true, ...result };
  });

  /** 列出待审核记忆 */
  fastify.get('/api/memory/reviews', async (request, reply) => {
    const { limit } = request.query;
    const items = knowledgeBase.listReviews(parseInt(limit) || 50);
    return { success: true, data: { reviews: items, count: items.length } };
  });

  /** 评估待审核记忆 */
  fastify.post('/api/memory/reviews/:id/evaluate', async (request, reply) => {
    const { id } = request.params;
    const { evaluation } = request.body;
    const result = knowledgeBase.evaluateReview(id, evaluation);
    return { success: true, ...result };
  });

  /** 提升待审核记忆为永久 */
  fastify.post('/api/memory/reviews/:id/promote', async (request, reply) => {
    const { id } = request.params;
    const { evaluation } = request.body || {};
    const result = knowledgeBase.promoteReview(id, evaluation || null);
    return { success: true, ...result };
  });

  /** 丢弃待审核记忆 */
  fastify.post('/api/memory/reviews/:id/discard', async (request, reply) => {
    const { id } = request.params;
    const result = knowledgeBase.discardReview(id);
    return { success: true, ...result };
  });

  // Helper function for autoTriage
  function recordAutoTriageResult({ status, candidates = [], error = null }) {
    metrics.lastAutoTriage = {
      status,
      candidate_count: candidates.length,
      error: error ? error.message : null,
      at: new Date().toISOString(),
    };
  }
}

export default memoryRoutes;
