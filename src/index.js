/**
 * HTTP server entry point.
 * Fastify-based REST API.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
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

// Initialize knowledge base
const knowledgeBase = new KnowledgeBase();

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

// ========== Wiki Endpoints ==========

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

fastify.get('/api/wiki/check-stale', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiIsStale();
    return result;
  } catch (err) {
    reply.code(500);
    return KnowledgeBasePresenter.presentError(err, 500);
  }
});

fastify.get('/api/wiki/status', async (request, reply) => {
  try {
    const result = knowledgeBase.wikiGetStatus();
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
