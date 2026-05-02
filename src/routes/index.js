/**
 * Routes module exports.
 * Centralizes all route imports for easy access.
 */

import { memoryRoutes } from './memory.js';
import { wikiRoutes } from './wiki.js';
import { healthRoutes } from './health.js';
import { benchmarkRoutes } from './benchmark.js';
import { legacyBridgeRoutes } from './legacy-bridge.js';

export { memoryRoutes, wikiRoutes, healthRoutes, benchmarkRoutes, legacyBridgeRoutes };

/**
 * Register all routes with Fastify instance
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 * @param {Object} context - Shared context with dependencies
 */
export async function registerAllRoutes(fastify, context) {
  await fastify.register(memoryRoutes, context);
  await fastify.register(wikiRoutes, context);
  await fastify.register(healthRoutes, context);
  await fastify.register(benchmarkRoutes, context);
  await fastify.register(legacyBridgeRoutes, context);
}

export default {
  registerAllRoutes
};
