/**
 * HTTP server entry point.
 * Fastify-based REST API.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
 */

import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { HTTP_HOST, HTTP_PORT, HTTP_SOCKET_PATH, API_SECRET, PROJECT_ROOT, SIDE_LLM_GATEWAY_URL, SIDE_LLM_GATEWAY_MODEL } from './config.js';
import { KnowledgeBase } from './knowledge-base.js';
import { KnowledgeBasePresenter } from './api/presenter.js';
import { QueryExporter } from './api/query-exporter.js';
import { MemoryQueryRequest, MemorySaveRequest, SessionTurnRequest, StartMemorySessionRequest, BenchmarkResultRequest } from './api/contract.js';

/**
 * Sanitize query input: strip OpenClaw inbound metadata wrapper.
 * OpenClaw occasionally passes the full "Conversation info (untrusted metadata):\n```json\n{...}" block
 * as the query instead of the user's actual message. This detects and rejects such queries.
 */
const METADATA_PREFIX_RE = /^Conversation info \(untrusted metadata\):/i;
function sanitizeQuery(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, cleaned: '', reason: 'empty_or_invalid' };
  const trimmed = raw.trim();
  if (METADATA_PREFIX_RE.test(trimmed)) {
    // Try to extract user message after the metadata JSON block
    const afterJson = trimmed.split(/```\s*\n?/).slice(2).join('```').trim();
    if (afterJson.length > 0) {
      return { valid: true, cleaned: afterJson, reason: 'extracted_from_metadata' };
    }
    return { valid: false, cleaned: '', reason: 'metadata_wrapper_only' };
  }
  return { valid: true, cleaned: trimmed, reason: 'ok' };
}

function validateBody(ValidatorClass) {
  return async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      return reply.code(400).send({ success: false, error: 'Request body is required' });
    }
    const instance = new ValidatorClass(request.body);
    const { valid, errors } = instance.validate();
    if (!valid) {
      return reply.code(400).send({ success: false, error: `Validation failed: ${errors.join(', ')}` });
    }
  };
}

const fastify = Fastify({
  logger: true,
});

function successResponse(data) {
  return { success: true, data };
}

function isPathInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 轻量级 Bearer Token 认证（未配置时跳过，兼容现有部署）
if (API_SECRET) {
  fastify.addHook('onRequest', async (request, reply) => {
    const auth = request.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_SECRET) {
      reply.code(401).send({ error: 'Unauthorized' });
      throw new Error('Unauthorized');
    }
  });
}

const queryExporter = new QueryExporter(); // 查询上下文调试导出器

// Initialize knowledge base
const knowledgeBase = new KnowledgeBase(); // 知识库组合门面，聚合所有子模块

// 侧边 LLM 网关客户端（用于治理语义比较）
let sideLlmGateway = null;
if (SIDE_LLM_GATEWAY_URL) {
  sideLlmGateway = {
    defaultModel: SIDE_LLM_GATEWAY_MODEL,
    async chat({ model, messages, temperature, max_tokens }) {
      const response = await fetch(`${SIDE_LLM_GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || SIDE_LLM_GATEWAY_MODEL, messages, temperature, max_tokens }),
      });
      if (!response.ok) throw new Error(`LLM gateway returned ${response.status}`);
      return response.json();
    },
  };
}

// ========== Memory Endpoints ==========

/** 查询记忆 */
fastify.post('/api/memory/query', { preHandler: [validateBody(MemoryQueryRequest)] }, async (request, reply) => {
  try {
    const { query, top_k, include_wiki } = request.body;
    const result = await knowledgeBase.queryMemory(query, top_k);
    const freshness = result.freshness || { level: 'unknown', note: '', age_days: null };

    if (include_wiki) {
      const wikiResults = knowledgeBase.wikiSearch(query, top_k || 3);

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
        query,
        hits: merged,
        total: merged.length,
        include_wiki: true,
        freshness_level: freshness.level,
        tentative_count: (result.tentative_items || []).length,
      };
    }

    return {
      query,
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
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 查询记忆上下文（含会话关联），可选导出调试信息 */
fastify.post('/api/memory/query-context', async (request, reply) => {
  try {
    const { query, top_k, session_id, include_debug } = request.body || {};
    if (!query || !String(query).trim()) {
      reply.code(400);
      return { success: false, error: 'query is required' };
    }
    const sq = sanitizeQuery(String(query));
    if (!sq.valid) {
      fastify.log.warn(`query-context: rejected metadata wrapper query (reason=${sq.reason})`);
      return {
        query: String(query).slice(0, 80),
        hits: [], total: 0,
        matched_sessions: [], matched_turns: [],
        freshness_level: 'none',
        context: { aliases: [], path_hints: [], collection_hints: [], confidence: 0, confidence_level: 'none', should_abstain: true, abstain_reason: 'metadata_wrapper_query', recency_hint: null, summary: {} },
      };
    }
    const effectiveQuery = sq.cleaned;
    if (sq.reason === 'extracted_from_metadata') {
      fastify.log.info(`query-context: extracted user message from metadata wrapper (len=${effectiveQuery.length})`);
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
    fastify.log.info(`Query-context summary: query="${effectiveQuery.slice(0, 80)}" hits=${memHits.length} matched_turns=${(result.matched_turns || []).length} confidence=${result.confidence || 0}`);
    return response;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 获取记忆时间线 */
fastify.get('/api/memory/timeline', async (request, reply) => {
  try {
    const { memory_id, session_id, limit } = request.query;
    const result = await knowledgeBase.memoryTimeline({ memoryId: memory_id, sessionId: session_id, limit: parseInt(limit) || 50 });
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 追加一轮对话到当前会话 */
fastify.post('/api/memory/turn', { preHandler: [validateBody(SessionTurnRequest)] }, async (request, reply) => {
  try {
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
        fastify.log.warn(`autoTriage failed for turn (${metrics.autoTriageConsecutiveFails} consecutive): ${err.message}`);
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
          fastify.log.warn(`Failed to persist autoTriage failure event: ${logErr.message}`);
        }
        if (metrics.autoTriageConsecutiveFails >= 5 && !metrics.autoTriageDisabled) {
          metrics.autoTriageDisabled = true;
          metrics.autoTriageDisabledAt = new Date().toISOString();
          knowledgeBase.memoryFacade.localMemory.store.storeMemoryEvent({
            event_type: 'auto_triage_disabled',
            payload_json: JSON.stringify({ disabled_at: metrics.autoTriageDisabledAt, consecutiveFails: metrics.autoTriageConsecutiveFails }),
          }).catch(logErr => {
            fastify.log.warn(`Failed to persist auto_triage_disabled event: ${logErr.message}`);
          });
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
            fastify.log.warn(`Failed to write autoTriage alert file: ${writeErr.message}`);
          }
        }
      });
    } else {
      fastify.log.debug(`autoTriage skipped (disabled since ${metrics.autoTriageDisabledAt})`);
    }

    return {
      success: true,
      ...result,
      auto_triage: metrics.autoTriageDisabled
        ? { mode: 'async', accepted: false, disabled: true, disabled_at: metrics.autoTriageDisabledAt }
        : { mode: 'async', accepted: true, semantic_compare_enabled: Boolean(sideLlmGateway) },
    };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 单条 autoTriage：对一条 turn 执行自动沉淀判断 */
fastify.post('/api/memory/auto-triage', async (request, reply) => {
  try {
    const { session_id, role, content, previous_role, previous_content } = request.body || {};
    if (!session_id || !role || !content) {
      reply.code(400);
      return { success: false, error: 'session_id, role, content are required' };
    }
    const candidates = await knowledgeBase.memoryFacade.localMemory.autoTriageTurn({
      session_id, role, content, previous_role, previous_content, persist: true, side_llm_gateway: sideLlmGateway,
    });
    recordAutoTriageResult({ status: 'success', candidates });
    return { success: true, candidates, count: candidates.length, semantic_compare_enabled: Boolean(sideLlmGateway) };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 批量 autoTriage：处理指定时间范围内的 turns */
fastify.post('/api/memory/auto-triage/batch', async (request, reply) => {
  try {
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
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 启动新的记忆会话 */
fastify.post('/api/memory/session/start', { preHandler: [validateBody(StartMemorySessionRequest)] }, async (request, reply) => {
  try {
    const { project_id, title, created_at, session_id } = request.body;
    const result = await knowledgeBase.startMemorySession({ projectId: project_id, title, createdAt: created_at, sessionId: session_id });
    return { success: true, session_id: result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 重置当前活跃会话 */
fastify.post('/api/memory/session/reset', async (request, reply) => {
  try {
    const result = await knowledgeBase.resetMemorySession();
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 导入外部对话记录为会话 */
fastify.post('/api/memory/session/import-transcript', async (request, reply) => {
  try {
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
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 保存记忆（可选走治理流程）
 *  响应格式: { success: true, memory_id, content, state, status?, ... }
 *  status 可能值: 'duplicate' | 'rate_limited' | 'governed_kept' | undefined(正常保存)
 */
fastify.post('/api/memory/save', { preHandler: [validateBody(MemorySaveRequest)] }, async (request, reply) => {
  try {
    const { session_id, content, state, aliases, path_hints, collection_hints, source, use_governance } = request.body;
    const options = {
      session_id, content, state, aliases, path_hints, collection_hints, source: source || 'manual',
    };
    const result = use_governance
      ? await knowledgeBase.saveMemoryWithGovernance(options)
      : knowledgeBase.saveMemory(options);
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 获取单条记忆 */
fastify.get('/api/memory/:id', async (request, reply) => {
  try {
    const { id } = request.params;
    const memory = await knowledgeBase.getMemory(id);
    if (!memory) {
      reply.code(404);
      return { success: false, error: 'Memory not found' };
    }
    return { success: true, data: memory };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 更新记忆内容 */
fastify.put('/api/memory/:id', async (request, reply) => {
  try {
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
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 删除记忆 */
fastify.delete('/api/memory/:id', async (request, reply) => {
  try {
    const { id } = request.params;
    const existing = await knowledgeBase.getMemory(id);
    if (!existing) {
      reply.code(404);
      return { success: false, error: 'Memory not found' };
    }
    await knowledgeBase.deleteMemory(id);
    return { success: true, memory_id: id, action: 'deleted' };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 治理流程：预览知识更新计划（不实际写入） */
fastify.post('/api/memory/governance/plan-update', async (request, reply) => {
  try {
    const { content, aliases, path_hints, collection_hints } = request.body;
    const result = await knowledgeBase.planKnowledgeUpdateDryRun({
      content, aliases, path_hints, collection_hints,
    });
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Review Endpoints ==========

/** 列出待审核记忆 */
fastify.get('/api/memory/reviews', async (request, reply) => {
  try {
    const { limit } = request.query;
    const items = knowledgeBase.listReviews(parseInt(limit) || 50);
    return successResponse({ reviews: items, count: items.length });
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 评估待审核记忆 */
fastify.post('/api/memory/reviews/:id/evaluate', async (request, reply) => {
  try {
    const { id } = request.params;
    const { evaluation } = request.body;
    const result = knowledgeBase.evaluateReview(id, evaluation);
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 提升待审核记忆为永久 */
fastify.post('/api/memory/reviews/:id/promote', async (request, reply) => {
  try {
    const { id } = request.params;
    const { evaluation } = request.body || {};
    const result = knowledgeBase.promoteReview(id, evaluation || null);
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 丢弃待审核记忆 */
fastify.post('/api/memory/reviews/:id/discard', async (request, reply) => {
  try {
    const { id } = request.params;
    const result = knowledgeBase.discardReview(id);
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Health Endpoints ==========

/** 完整健康快照 */
fastify.get('/api/health', async (request, reply) => {
  try {
    const result = await knowledgeBase.healthSnapshot();
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 就绪探针：仅返回 status 和 timestamp */
fastify.get('/api/health/ready', async (request, reply) => {
  try {
    const result = await knowledgeBase.healthSnapshot();
    return { status: result.status, timestamp: result.timestamp };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Benchmark Endpoints ==========

/** 记录一次基准测试结果 */
fastify.post('/api/benchmarks/record', { preHandler: [validateBody(BenchmarkResultRequest)] }, async (request, reply) => {
  try {
    const result = await knowledgeBase.recordBenchmarkResult(request.body);
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 获取最新基准测试结果 */
fastify.get('/api/benchmarks/latest', async (request, reply) => {
  try {
    const { suite_name } = request.query;
    const result = await knowledgeBase.latestBenchmark(suite_name);
    return successResponse(result || {});
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 获取基准测试历史记录 */
fastify.get('/api/benchmarks/history', async (request, reply) => {
  try {
    const { suite_name, limit } = request.query;
    const result = await knowledgeBase.benchmarkHistory(suite_name, parseInt(limit) || 20);
    return successResponse(result || []);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 执行基准测试套件 */
fastify.post('/api/benchmarks/run', async (request, reply) => {
  try {
    const { suite_name } = request.body || {};
    const result = await knowledgeBase.runBenchmark(suite_name);
    return { success: true, suites: result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Wiki Endpoints ==========

/** 搜索 Wiki 页面 */
fastify.post('/api/wiki/search', async (request, reply) => {
  try {
    const { query, top_k } = request.body;
    const result = knowledgeBase.wikiSearch(query, top_k || 5);
    return successResponse({ results: result });
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 检查 Wiki 是否需要重新编译 */
fastify.get('/api/wiki/check-stale', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiIsStale();
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 获取 Wiki 编译状态 */
fastify.get('/api/wiki/status', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiGetStatus();
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 检测 Wiki 源文件变更 */
fastify.post('/api/wiki/detect-changes', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiDetectChanges();
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 生成 Wiki 编译提示词 */
fastify.post('/api/wiki/compile-prompt', async (request, reply) => {
  try {
    const { changesResult } = request.body || {};
    if (!changesResult || typeof changesResult !== 'object') {
      reply.code(400);
      return { success: false, error: 'changesResult is required' };
    }
    const result = knowledgeBase.wikiGenerateCompilePrompt(changesResult);
    return successResponse({ prompt: result });
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 保存 Wiki 编译页面 */
fastify.post('/api/wiki/save-page', async (request, reply) => {
  try {
    const { sourcePath, wikiPageName, content, sourceId } = request.body;
    if (!sourcePath || !wikiPageName || !content) {
      reply.code(400);
      return { error: 'BadRequest', message: 'Missing required fields: sourcePath, wikiPageName, content', code: 400 };
    }
    const result = knowledgeBase.wikiSavePage({ sourcePath, wikiPageName, content, sourceId });
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 删除 Wiki 页面 */
fastify.post('/api/wiki/remove-page', async (request, reply) => {
  try {
    const { wikiPageName } = request.body;
    if (!wikiPageName) {
      reply.code(400);
      return { error: 'BadRequest', message: 'Missing required field: wikiPageName', code: 400 };
    }
    const result = knowledgeBase.wikiRemovePage(wikiPageName);
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 更新 Wiki 总索引 */
fastify.post('/api/wiki/update-index', async (request, reply) => {
  try {
    const { pages } = request.body || {};
    if (pages !== undefined && !Array.isArray(pages)) {
      reply.code(400);
      return { success: false, error: 'pages must be an array when provided' };
    }
    const result = knowledgeBase.wikiUpdateIndex(pages);
    return successResponse(result);
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Rebuild Endpoint ==========

/** 重建 localMem 索引（梦境循环 Deep Sleep 使用） */
fastify.post('/api/rebuild', async (request, reply) => {
  try {
    const result = await knowledgeBase.rebuildLocalMem();
    return { success: true, operation: 'maintenance_check', index_rebuilt: false, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Legacy Bridge Endpoints (兼容 rule-engine-bridge) ==========

/** 保存记忆取舍决策 */
fastify.post('/api/memory/choice', async (request, reply) => {
  try {
    const { memory_id, choice, updated_at } = request.body;
    const result = knowledgeBase.saveMemoryChoice({ memoryId: memory_id, choice, updatedAt: updated_at });
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** Review 通用入口（兼容 rule-engine-bridge） */
fastify.post('/api/memory/review', async (request, reply) => {
  try {
    const { memory_id, action } = request.body;
    if (action === 'promote' || action === 'keep') {
      try {
        const result = knowledgeBase.promoteReview(memory_id);
        return { success: true, ...result };
      } catch (err) {
        if (err.message && err.message.includes('not in tentative state')) {
          reply.code(409);
          return { success: false, error: err.message, code: 409 };
        }
        throw err;
      }
    }
    if (action === 'discard') {
      const result = knowledgeBase.discardReview(memory_id);
      return { success: true, ...result };
    }
    reply.code(400);
    return { success: false, error: `Unsupported review action: ${action}` };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Metrics ==========
const metrics = {
  startTime: Date.now(),
  requestCount: 0,
  errorCount: 0,
  memoryQueryCount: 0,
  memoryTurnCount: 0,
  autoTriageSuccessCount: 0,
  autoTriageFailCount: 0,
  autoTriageConsecutiveFails: 0,
  autoTriageDisabled: false,
  autoTriageDisabledAt: null,
  lastQueryContext: null,
  lastAutoTriage: null,
};

function recordAutoTriageResult({ status, candidates = [], error = null }) {
  metrics.lastAutoTriage = {
    status,
    candidate_count: candidates.length,
    error: error ? error.message : null,
    at: new Date().toISOString(),
  };
}

const AUTOTRIAGE_RECOVERY_MS = 30 * 60 * 1000;
setInterval(() => {
  if (metrics.autoTriageDisabled && metrics.autoTriageDisabledAt) {
    const disabledAt = new Date(metrics.autoTriageDisabledAt).getTime();
    if (Date.now() - disabledAt >= AUTOTRIAGE_RECOVERY_MS) {
      metrics.autoTriageDisabled = false;
      metrics.autoTriageDisabledAt = null;
      metrics.autoTriageConsecutiveFails = 0;
      fastify.log.info('autoTriage disabled flag auto-reset after recovery timeout');
    }
  }
}, 60 * 1000);

fastify.addHook('onResponse', async (request, reply) => {
  metrics.requestCount += 1;
  if (reply.statusCode >= 500) {
    metrics.errorCount += 1;
  }
  if (request.url.startsWith('/api/memory/query')) {
    metrics.memoryQueryCount += 1;
  }
  if (request.url === '/api/memory/turn') {
    metrics.memoryTurnCount += 1;
  }
});

/** 基础 metrics 端点 */
fastify.get('/metrics', async (_request, _reply) => {
  const mem = process.memoryUsage();
  const uptime = Date.now() - metrics.startTime;
  let memoryStats = null;
  try {
    const store = knowledgeBase?.memoryFacade?.localMemory?._store;
    if (store?.db) {
      const summary = store.statsSummary();
      const turnCount = store.db.prepare('SELECT COUNT(*) as cnt FROM turns').get()?.cnt || 0;
      memoryStats = { kept_items: summary.kept, tentative_items: summary.tentative, turns: turnCount, sessions: summary.sessions };
    }
  } catch (metricsErr) {
    fastify.log.warn(`Failed to get memory stats for metrics: ${metricsErr.message}`);
  }
  return {
    uptime_ms: uptime,
    requests_total: metrics.requestCount,
    errors_total: metrics.errorCount,
    memory_queries_total: metrics.memoryQueryCount,
    memory_turns_total: metrics.memoryTurnCount,
    process: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      external_mb: Math.round(mem.external / 1024 / 1024),
    },
    memory: memoryStats,
    last_query_context: metrics.lastQueryContext,
    auto_triage: {
      success_total: metrics.autoTriageSuccessCount,
      fail_total: metrics.autoTriageFailCount,
      consecutive_fails: metrics.autoTriageConsecutiveFails,
      disabled: metrics.autoTriageDisabled,
      disabled_at: metrics.autoTriageDisabledAt,
      last: metrics.lastAutoTriage,
    },
  };
});

// Start server
let socketServer = null;

/**
 * 启动 HTTP 服务器（TCP + Unix Domain Socket 双栈）
 * @returns {Promise<void>}
 */
const start = async () => {
  try {
    if (!API_SECRET) {
      console.warn('⚠️  WARNING: OPENCLAW_API_SECRET is not set. API authentication is DISABLED. All endpoints are publicly accessible.');
    }

    try {
      const store = knowledgeBase?.memoryFacade?.localMemory?._store;
      if (store?.db) {
        const disabledEvent = store.db.prepare(
          `SELECT created_at, payload_json FROM memory_events WHERE event_type = 'auto_triage_disabled' ORDER BY created_at DESC LIMIT 1`
        ).get();
        if (disabledEvent) {
          const data = JSON.parse(disabledEvent.payload_json || '{}');
          metrics.autoTriageDisabled = true;
          metrics.autoTriageDisabledAt = data.disabled_at || disabledEvent.created_at;
          metrics.autoTriageConsecutiveFails = data.consecutiveFails || 5;
          fastify.log.warn(`autoTriage restored to disabled state from auto_triage_disabled event (disabled_at=${metrics.autoTriageDisabledAt})`);
        } else {
          const recentFail = store.db.prepare(
            `SELECT created_at, payload_json FROM memory_events WHERE event_type = 'auto_triage_failure' ORDER BY created_at DESC LIMIT 1`
          ).get();
          if (recentFail) {
            const data = JSON.parse(recentFail.payload_json || '{}');
            if (data.consecutiveFails >= 5) {
              metrics.autoTriageDisabled = true;
              metrics.autoTriageDisabledAt = recentFail.created_at;
              metrics.autoTriageConsecutiveFails = data.consecutiveFails;
              fastify.log.warn(`autoTriage restored to disabled state from persistent events (consecutiveFails=${data.consecutiveFails})`);
            }
          }
        }
      }
    } catch (restoreErr) {
      fastify.log.warn(`Failed to restore autoTriage state: ${restoreErr.message}`);
    }

    // TCP 入口（供网关使用）
    await fastify.listen({ host: HTTP_HOST, port: HTTP_PORT });
    console.log(`HTTP server listening on ${HTTP_HOST}:${HTTP_PORT}`);

    // Unix Domain Socket 入口（供本地工具使用，可选）
    // 使用 TCP 透明代理实现，零 HTTP 解析开销，绕过 Fastify 单实例 listen 限制
    if (HTTP_SOCKET_PATH) {
      try {
        if (fs.existsSync(HTTP_SOCKET_PATH)) {
          fs.unlinkSync(HTTP_SOCKET_PATH);
        }
        socketServer = net.createServer((clientSocket) => {
          const serverSocket = net.connect(HTTP_PORT, HTTP_HOST);

          if (API_SECRET) {
            let headerBuffer = Buffer.alloc(0);
            let headerParsed = false;

            clientSocket.on('data', (chunk) => {
              if (headerParsed) {
                serverSocket.write(chunk);
                return;
              }

              headerBuffer = Buffer.concat([headerBuffer, chunk]);
              const headerStr = headerBuffer.toString('utf-8');
              let headerEndIdx = headerStr.indexOf('\r\n\r\n');
              if (headerEndIdx === -1) {
                headerEndIdx = headerStr.indexOf('\n\n');
              }

              if (headerEndIdx === -1) {
                return;
              }

              headerParsed = true;
              const beforeHeaders = headerStr.slice(0, headerEndIdx);
              const afterHeaders = headerStr.slice(headerEndIdx + (headerStr.indexOf('\r\n\r\n') !== -1 ? 4 : 2));

              const headerLines = beforeHeaders.split(/\r?\n/);
              for (const line of headerLines) {
                if (line.toLowerCase().startsWith('authorization:')) {
                  const errResp = 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":"Authorization header not allowed on Unix socket"}';
                  clientSocket.write(errResp, () => clientSocket.destroy());
                  return;
                }
              }

              const authHeader = `Authorization: Bearer ${API_SECRET}`;
              const separator = headerStr.indexOf('\r\n\r\n') !== -1 ? '\r\n' : '\n';
              const injected = Buffer.from(
                beforeHeaders + separator + authHeader + separator + separator + afterHeaders,
                'utf-8'
              );
              serverSocket.write(injected);
            });

            clientSocket.on('end', () => {
              if (!headerParsed && headerBuffer.length > 0) {
                serverSocket.write(headerBuffer);
              }
            });
          } else {
            clientSocket.pipe(serverSocket);
          }

          serverSocket.pipe(clientSocket);
          clientSocket.on('error', (err) => {
            console.error(`[UnixSocket] client error: ${err.message}`);
          });
          serverSocket.on('error', (err) => {
            console.error(`[UnixSocket] upstream connection error: ${err.message}`);
            clientSocket.destroy();
          });
          clientSocket.on('close', () => {
            serverSocket.end();
          });
          serverSocket.on('close', () => {
            clientSocket.end();
          });
        });
        socketServer.listen(HTTP_SOCKET_PATH, () => {
          fs.chmodSync(HTTP_SOCKET_PATH, 0o600);
          console.log(`Unix socket proxy listening on ${HTTP_SOCKET_PATH} -> ${HTTP_HOST}:${HTTP_PORT}`);
        });
      } catch (sockErr) {
        console.warn(`Unix socket start failed: ${sockErr.message}`);
      }
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

/**
 * Graceful shutdown：关闭 HTTP 服务器、Unix Socket、数据库连接
 */
async function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing gracefully...`);
  try {
    if (socketServer) {
      socketServer.close();
      socketServer = null;
    }
    if (fs.existsSync(HTTP_SOCKET_PATH)) {
      fs.unlinkSync(HTTP_SOCKET_PATH);
    }
    await knowledgeBase.close();
    await fastify.close();
    console.log('[shutdown] closed successfully');
    process.exit(0);
  } catch (err) {
    console.error(`[shutdown] error during close: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error(`[uncaughtException] ${err.message}\n${err.stack}`);
  try {
    const store = knowledgeBase?.memoryFacade?.localMemory?._store;
    if (store) {
      store.checkpoint();
      store.close();
    }
  } catch (closeErr) {
    console.error(`[uncaughtException] emergency close failed: ${closeErr.message}`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection] ${reason}`);
  shutdown('unhandledRejection');
});

start();
