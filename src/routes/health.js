/**
 * Health routes.
 * Handles all /api/health/* endpoints.
 */

/**
 * Register health routes
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 * @param {Object} context - Shared context
 */
export async function healthRoutes(fastify, context) {
  const { knowledgeBase } = context;

  /** 完整健康快照 */
  fastify.get('/api/health', async (request, reply) => {
    const result = await knowledgeBase.healthSnapshot();
    return { success: true, data: result };
  });

  /** 就绪探针：仅返回 status 和 timestamp */
  fastify.get('/api/health/ready', async (request, reply) => {
    const result = await knowledgeBase.healthSnapshot();
    return { status: result.status, timestamp: result.timestamp };
  });
}

export default healthRoutes;
