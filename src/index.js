/**
 * HTTP server entry point.
 * Fastify-based REST API.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
 */

import Fastify from 'fastify';
import fs from 'fs';
import net from 'net';
import { HTTP_HOST, HTTP_PORT, HTTP_SOCKET_PATH, API_SECRET } from './config.js';
import { KnowledgeBase } from './knowledge-base.js';
import { KnowledgeBasePresenter } from './api/presenter.js';
import { QueryExporter } from './api/query-exporter.js';

const fastify = Fastify({
  logger: true, // 启用 Fastify 内置请求日志
});

// 轻量级 Bearer Token 认证（未配置时跳过，兼容现有部署）
if (API_SECRET) {
  fastify.addHook('onRequest', async (request, reply) => {
    const auth = request.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_SECRET) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}

const queryExporter = new QueryExporter(); // 查询上下文调试导出器

// Initialize knowledge base
const knowledgeBase = new KnowledgeBase(); // 知识库组合门面，聚合所有子模块

// ========== Memory Endpoints ==========

/** 查询记忆 */
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

/** 查询记忆上下文（含会话关联），可选导出调试信息 */
fastify.post('/api/memory/query-context', async (request, reply) => {
  try {
    const { query, top_k, session_id, include_debug } = request.body;
    const result = await knowledgeBase.queryMemoryContext(query, top_k, session_id);
    if (include_debug && queryExporter) {
      await queryExporter.exportQueryContext({ query, result });
    }
    return result;
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
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 追加一轮对话到当前会话 */
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

/** 启动新的记忆会话 */
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

/** 保存记忆（可选走治理流程） */
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
    return { reviews: items, count: items.length };
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
    return result;
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
fastify.post('/api/benchmarks/record', async (request, reply) => {
  try {
    const result = await knowledgeBase.recordBenchmarkResult(request.body);
    return result;
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
    return result || {};
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
    return result || [];
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
    return { results: result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 检查 Wiki 是否需要重新编译 */
fastify.get('/api/wiki/check-stale', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiIsStale();
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 获取 Wiki 编译状态 */
fastify.get('/api/wiki/status', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiGetStatus();
    return result;
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
    return { success: true, ...result };
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

/** 重建 localMem 索引（GET 版本，兼容无 body 调用） */
fastify.get('/api/rebuild', async (request, reply) => {
  try {
    const result = await knowledgeBase.rebuildLocalMem();
    return { success: true, ...result };
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
    const { memory_id, action, publish_target, updated_at } = request.body;
    if (action === 'promote' || action === 'keep') {
      const result = knowledgeBase.promoteReview(memory_id);
      return { success: true, ...result };
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
};

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
fastify.get('/metrics', async (request, reply) => {
  const mem = process.memoryUsage();
  const uptime = Date.now() - metrics.startTime;
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
          clientSocket.pipe(serverSocket);
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

start();
