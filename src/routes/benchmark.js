/**
 * Benchmark routes.
 * Handles all /api/benchmarks/* endpoints.
 */

import { BenchmarkResultRequest } from '../api/contract.js';
import { validateBody } from '../middleware/validation.js';

/**
 * Register benchmark routes
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 * @param {Object} context - Shared context
 */
export async function benchmarkRoutes(fastify, context) {
  const { knowledgeBase } = context;

  /** 记录一次基准测试结果 */
  fastify.post('/api/benchmarks/record', { preHandler: [validateBody(BenchmarkResultRequest)] }, async (request, reply) => {
    const result = await knowledgeBase.recordBenchmarkResult(request.body);
    return { success: true, data: result };
  });

  /** 获取最新基准测试结果 */
  fastify.get('/api/benchmarks/latest', async (request, reply) => {
    const { suite_name } = request.query;
    const result = await knowledgeBase.latestBenchmark(suite_name);
    return { success: true, data: result || {} };
  });

  /** 获取基准测试历史记录 */
  fastify.get('/api/benchmarks/history', async (request, reply) => {
    const { suite_name, limit } = request.query;
    const result = await knowledgeBase.benchmarkHistory(suite_name, parseInt(limit) || 20);
    return { success: true, data: result || [] };
  });

  /** 执行基准测试套件 */
  fastify.post('/api/benchmarks/run', async (request, reply) => {
    const { suite_name } = request.body || {};
    const result = await knowledgeBase.runBenchmark(suite_name);
    return { success: true, suites: result };
  });
}

export default benchmarkRoutes;
