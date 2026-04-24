/**
 * HTTP server entry point.
 * Fastify-based REST API.
 */

import Fastify from 'fastify';
import { HTTP_HOST, HTTP_PORT } from './config.js';
import { KnowledgeBase } from './knowledge-base.js';
import { KnowledgeBasePresenter } from './api/presenter.js';
import { QueryExporter } from './api/query-exporter.js';

const fastify = Fastify({
  logger: true,
});

const queryExporter = new QueryExporter();

/**
 * 根据检索结果生成洞察文本，供梦境系统消费。
 * 只在有显著信号时返回非空字符串。
 */
function buildRetrospective(query, result) {
  const {
    matched_sessions = [],
    matched_turns = [],
    hits = [],
    confidence = 0,
    should_abstain = false,
    abstain_reason = '',
  } = result || {};

  const staticHits = hits.filter(h => h.source !== 'memory' && h.collection !== 'memory');
  const memoryHits = hits.filter(h => h.source === 'memory' || h.collection === 'memory');
  const hasStatic = staticHits.length > 0;
  const hasMemory = memoryHits.length > 0 || matched_sessions.length > 0 || matched_turns.length > 0;

  // 完全无命中 → 知识缺口
  if (!hasStatic && !hasMemory) {
    return `[检索洞察] 查询"${query}"在中间层无任何命中。这可能是一个全新话题，建议记录到 wiki 或每日记忆。`;
  }

  // static 无命中但 memory 有 → 知识只在会话中，未沉淀到 wiki
  if (!hasStatic && hasMemory) {
    const sessions = matched_sessions.slice(0, 2).map(s => s.title || '未命名会话').join('、');
    return `[检索洞察] 查询"${query}"在 static_kb 无命中，但 memory 中有 ${matched_sessions.length} 个相关会话（${sessions}）。说明相关知识只存在于临时对话中，未沉淀为长期记忆，建议提炼后写入 wiki。`;
  }

  // 低置信度 abstain → 检索质量不足
  if (should_abstain && confidence < 0.5) {
    return `[检索洞察] 查询"${query}"检索结果被系统主动弃权（${abstain_reason}），confidence=${confidence.toFixed(2)}。当前记忆/知识库对该查询覆盖不足。`;
  }

  // 正常命中，无需洞察
  return null;
}

// Initialize knowledge base
const knowledgeBase = new KnowledgeBase();
await knowledgeBase.initializeEager();

// ========== Search Endpoints ==========

fastify.post('/api/search', async (request, reply) => {
  try {
    const { query, top_k, doc_type, session_id, include_debug } = request.body;
    const result = await knowledgeBase.search({
      query,
      top_k,
      doc_type,
      session_id,
      include_debug,
    });
    return KnowledgeBasePresenter.presentSearchResults(result.results, {
      query: result.query,
      top_k: result.top_k,
      timing_ms: result.timing_ms,
      debug: result.debug,
    });
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/search/sync', async (request, reply) => {
  try {
    const result = await knowledgeBase.syncCollections();
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/collections', async (request, reply) => {
  try {
    const result = knowledgeBase.getCollections();
    return { collections: result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// ========== Memory Endpoints ==========

fastify.post('/api/memory/query', async (request, reply) => {
  try {
    const { query, top_k } = request.body;
    const result = await knowledgeBase.queryMemory(query, top_k);
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/query-context', async (request, reply) => {
  try {
    const { query, top_k, include_debug, session_id } = request.body;
    const result = await knowledgeBase.queryMemoryContext(query, top_k);
    if (include_debug && queryExporter) {
      await queryExporter.exportQueryContext({ query, result });
    }
    
    // 生成检索洞察，自动注入 session（如有 session_id）
    const retrospective = buildRetrospective(query, result);
    if (retrospective && session_id) {
      try {
        await knowledgeBase.appendSessionTurn({
          sessionId: session_id,
          role: 'system',
          content: retrospective,
          title: '检索洞察',
        });
      } catch (e) {
        fastify.log.warn({ msg: 'retrospective append failed', err: e.message });
      }
    }
    
    return { ...result, retrospective };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/memory/timeline', async (request, reply) => {
  try {
    const { memory_id, session_id, limit } = request.query;
    const result = await knowledgeBase.memoryTimeline({ memoryId: memory_id, sessionId: session_id, limit: parseInt(limit) || 50 });
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/choice', async (request, reply) => {
  try {
    const { memory_id, choice, updated_at } = request.body;
    const result = await knowledgeBase.saveMemoryChoice({ memoryId: memory_id, choice, updatedAt: updated_at });
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/memory/reviews', async (request, reply) => {
  try {
    const { limit } = request.query;
    const result = await knowledgeBase.listMemoryReviews(parseInt(limit) || 50);
    const hint = result.length > 0
      ? `当前有 ${result.length} 条待审核 wiki 候选。可选操作：publish（发布到 wiki）、keep_local（保留在 localmem）、discard（丢弃）、manual_only（手动管理）。先查看详情，再执行 action。`
      : '';
    return {
      items: result,
      hint,
      available_actions: ['publish', 'keep_local', 'discard', 'manual_only'],
    };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/review', async (request, reply) => {
  try {
    const { memory_id, action, publish_target, updated_at } = request.body;
    const result = await knowledgeBase.reviewMemoryCandidate({ memoryId: memory_id, action, publishTarget: publish_target, updatedAt: updated_at });
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/turn', async (request, reply) => {
  try {
    const { session_id, role, content, project_id, title, created_at, references } = request.body;
    const result = await knowledgeBase.appendSessionTurn({
      sessionId: session_id, role, content, projectId: project_id, title, createdAt: created_at, references,
    });
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/session/start', async (request, reply) => {
  try {
    const { project_id, title, created_at, session_id } = request.body;
    const result = await knowledgeBase.startMemorySession({ projectId: project_id, title, createdAt: created_at, sessionId: session_id });
    return { success: true, session_id: result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/session/reset', async (request, reply) => {
  try {
    const result = await knowledgeBase.resetMemorySession();
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/session/import-transcript', async (request, reply) => {
  try {
    const { transcript_path, transcript_id, transcripts_root, project_id, title, created_at, session_id } = request.body;
    const result = await knowledgeBase.importTranscriptSession({
      transcriptPath: transcript_path, transcriptId: transcript_id, transcriptsRoot: transcripts_root,
      projectId: project_id, title, createdAt: created_at, sessionId: session_id,
    });
    return { success: true, session_id: result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.post('/api/memory/save', async (request, reply) => {
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

// ========== Health Endpoints ==========

fastify.get('/api/health', async (request, reply) => {
  try {
    const result = await knowledgeBase.healthSnapshot();
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

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

fastify.post('/api/benchmarks/record', async (request, reply) => {
  try {
    const result = await knowledgeBase.recordBenchmarkResult(request.body);
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/benchmarks/latest', async (request, reply) => {
  try {
    const { suite_name } = request.query;
    const result = await knowledgeBase.latestBenchmark(suite_name);
    return result || {};
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/benchmarks/history', async (request, reply) => {
  try {
    const { suite_name, limit } = request.query;
    const result = await knowledgeBase.benchmarkHistory(suite_name, parseInt(limit) || 20);
    return result || [];
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

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

// ========== Admin Endpoints ==========

fastify.post('/api/rebuild', async (request, reply) => {
  try {
    const result = await knowledgeBase.rebuild();
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/stats', async (request, reply) => {
  try {
    const result = await knowledgeBase.stats();
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ host: HTTP_HOST, port: HTTP_PORT });
    console.log(`HTTP server listening on ${HTTP_HOST}:${HTTP_PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
