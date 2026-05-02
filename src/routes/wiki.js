/**
 * Wiki routes.
 * Handles all /api/wiki/* endpoints.
 */

import { sanitizeQuery } from '../api/sanitize.js';
import { WikiSearchRequest, WikiSavePageRequest, WikiRemovePageRequest } from '../api/contract.js';
import { validateBody } from '../middleware/validation.js';

/**
 * Register wiki routes
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 * @param {Object} context - Shared context
 */
export async function wikiRoutes(fastify, context) {
  const { knowledgeBase, metrics, logger } = context;

  /** 搜索 Wiki 页面 */
  fastify.post('/api/wiki/search', { preHandler: [validateBody(WikiSearchRequest)] }, async (request, reply) => {
    const { query, top_k } = request.body;
    const sq = sanitizeQuery(String(query));
    if (!sq.valid) {
      logger.warn(`wiki/search: rejected metadata wrapper query (reason=${sq.reason})`);
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
      logger.info(`wiki/search: cleaned metadata from query (reason=${sq.reason}, len=${effectiveQuery.length})`);
      metrics.sanitizeMetadataCount += 1;
    }
    const result = knowledgeBase.wikiSearch(effectiveQuery, top_k || 5);
    return { success: true, data: { results: result } };
  });

  /** 检查 Wiki 是否需要重新编译 */
  fastify.get('/api/wiki/check-stale', async (request, reply) => {
    const result = knowledgeBase.wikiIsStale();
    return { success: true, data: result };
  });

  /** 获取 Wiki 编译状态 */
  fastify.get('/api/wiki/status', async (request, reply) => {
    const result = knowledgeBase.wikiGetStatus();
    return { success: true, data: result };
  });

  /** 检测 Wiki 源文件变更 */
  fastify.post('/api/wiki/detect-changes', async (request, reply) => {
    const result = knowledgeBase.wikiDetectChanges();
    return { success: true, data: result };
  });

  /** 生成 Wiki 编译提示词 */
  fastify.post('/api/wiki/compile-prompt', async (request, reply) => {
    const { changesResult } = request.body || {};
    if (!changesResult || typeof changesResult !== 'object') {
      reply.code(400);
      return { success: false, error: 'changesResult is required' };
    }
    const result = knowledgeBase.wikiGenerateCompilePrompt(changesResult);
    return { success: true, data: { prompt: result } };
  });

  /** 保存 Wiki 编译页面 */
  fastify.post('/api/wiki/save-page', { preHandler: [validateBody(WikiSavePageRequest)] }, async (request, reply) => {
    const { sourcePath, wikiPageName, content, sourceId } = request.body;
    const result = knowledgeBase.wikiSavePage({ sourcePath, wikiPageName, content, sourceId });
    return { success: true, data: result };
  });

  /** 删除 Wiki 页面 */
  fastify.post('/api/wiki/remove-page', { preHandler: [validateBody(WikiRemovePageRequest)] }, async (request, reply) => {
    const { wikiPageName } = request.body;
    const result = knowledgeBase.wikiRemovePage(wikiPageName);
    return { success: true, data: result };
  });

  /** 更新 Wiki 总索引 */
  fastify.post('/api/wiki/update-index', async (request, reply) => {
    const { pages } = request.body || {};
    if (pages !== undefined && !Array.isArray(pages)) {
      reply.code(400);
      return { success: false, error: 'pages must be an array when provided' };
    }
    const result = knowledgeBase.wikiUpdateIndex(pages);
    return { success: true, data: result };
  });
}

export default wikiRoutes;
