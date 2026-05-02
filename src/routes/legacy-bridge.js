/**
 * Legacy bridge routes.
 * Handles backward compatibility with rule-engine-bridge.
 */

import { AppError, ConflictError } from '../middleware/error-handler.js';

/**
 * Register legacy bridge routes
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 * @param {Object} context - Shared context
 */
export async function legacyBridgeRoutes(fastify, context) {
  const { knowledgeBase } = context;

  /** 保存记忆取舍决策 */
  fastify.post('/api/memory/choice', async (request, reply) => {
    const { memory_id, choice, updated_at } = request.body;
    const result = knowledgeBase.saveMemoryChoice({ memoryId: memory_id, choice, updatedAt: updated_at });
    return { success: true, ...result };
  });

  /** Review 通用入口（兼容 rule-engine-bridge） */
  fastify.post('/api/memory/review', async (request, reply) => {
    const { memory_id, action } = request.body;
    if (action === 'promote' || action === 'keep') {
      try {
        const result = knowledgeBase.promoteReview(memory_id);
        return { success: true, ...result };
      } catch (err) {
        if (err.message && err.message.includes('not in tentative state')) {
          throw new ConflictError(err.message);
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
  });

  /** 重建 localMem 索引（梦境循环 Deep Sleep 使用） */
  fastify.post('/api/rebuild', async (request, reply) => {
    const result = await knowledgeBase.rebuildLocalMem();
    return { success: true, operation: 'maintenance_check', index_rebuilt: false, ...result };
  });
}

export default legacyBridgeRoutes;
