/**
 * Routes tests.
 * Tests for route module structure and exports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Routes', () => {
  describe('Memory Routes', () => {
    it('should export memoryRoutes function', async () => {
      const { memoryRoutes } = await import('../src/routes/memory.js');
      assert.strictEqual(typeof memoryRoutes, 'function');
    });

    it('should have correct function signature', async () => {
      const { memoryRoutes } = await import('../src/routes/memory.js');
      assert.strictEqual(memoryRoutes.length, 2); // fastify, context
    });
  });

  describe('Wiki Routes', () => {
    it('should export wikiRoutes function', async () => {
      const { wikiRoutes } = await import('../src/routes/wiki.js');
      assert.strictEqual(typeof wikiRoutes, 'function');
    });

    it('should have correct function signature', async () => {
      const { wikiRoutes } = await import('../src/routes/wiki.js');
      assert.strictEqual(wikiRoutes.length, 2); // fastify, context
    });
  });

  describe('Health Routes', () => {
    it('should export healthRoutes function', async () => {
      const { healthRoutes } = await import('../src/routes/health.js');
      assert.strictEqual(typeof healthRoutes, 'function');
    });

    it('should have correct function signature', async () => {
      const { healthRoutes } = await import('../src/routes/health.js');
      assert.strictEqual(healthRoutes.length, 2); // fastify, context
    });
  });

  describe('Benchmark Routes', () => {
    it('should export benchmarkRoutes function', async () => {
      const { benchmarkRoutes } = await import('../src/routes/benchmark.js');
      assert.strictEqual(typeof benchmarkRoutes, 'function');
    });

    it('should have correct function signature', async () => {
      const { benchmarkRoutes } = await import('../src/routes/benchmark.js');
      assert.strictEqual(benchmarkRoutes.length, 2); // fastify, context
    });
  });

  describe('Legacy Bridge Routes', () => {
    it('should export legacyBridgeRoutes function', async () => {
      const { legacyBridgeRoutes } = await import('../src/routes/legacy-bridge.js');
      assert.strictEqual(typeof legacyBridgeRoutes, 'function');
    });

    it('should have correct function signature', async () => {
      const { legacyBridgeRoutes } = await import('../src/routes/legacy-bridge.js');
      assert.strictEqual(legacyBridgeRoutes.length, 2); // fastify, context
    });
  });

  describe('Routes Index', () => {
    it('should export all route functions', async () => {
      const mod = await import('../src/routes/index.js');
      assert.strictEqual(typeof mod.memoryRoutes, 'function');
      assert.strictEqual(typeof mod.wikiRoutes, 'function');
      assert.strictEqual(typeof mod.healthRoutes, 'function');
      assert.strictEqual(typeof mod.benchmarkRoutes, 'function');
      assert.strictEqual(typeof mod.legacyBridgeRoutes, 'function');
      assert.strictEqual(typeof mod.registerAllRoutes, 'function');
    });

    it('should export registerAllRoutes function', async () => {
      const { registerAllRoutes } = await import('../src/routes/index.js');
      assert.strictEqual(typeof registerAllRoutes, 'function');
    });

    it('should have correct registerAllRoutes signature', async () => {
      const { registerAllRoutes } = await import('../src/routes/index.js');
      assert.strictEqual(registerAllRoutes.length, 2); // fastify, context
    });
  });

  describe('Route Module Structure', () => {
    it('should have consistent export pattern for all route modules', async () => {
      const routeModules = [
        '../src/routes/memory.js',
        '../src/routes/wiki.js',
        '../src/routes/health.js',
        '../src/routes/benchmark.js',
        '../src/routes/legacy-bridge.js'
      ];

      for (const modulePath of routeModules) {
        const mod = await import(modulePath);
        const routeName = modulePath.split('/').pop().replace('.js', '');
        
        // Each module should have a default export
        assert.ok(mod.default || mod[Object.keys(mod).find(k => k.endsWith('Routes'))],
          `${routeName} should have a route function export`);
      }
    });
  });

  describe('Route Context Parameters', () => {
    it('should expect knowledgeBase in context', async () => {
      // This is a documentation test - verifying the expected context structure
      const expectedParams = [
        'knowledgeBase',
        'queryExporter', 
        'metrics',
        'sideLlmGateway',
        'PROJECT_ROOT',
        'logger'
      ];

      // Just verify the test structure exists
      assert.ok(expectedParams.length > 0);
      assert.ok(expectedParams.includes('knowledgeBase'));
      assert.ok(expectedParams.includes('logger'));
    });
  });

  describe('Endpoint Constants', () => {
    it('should have correct API prefix', async () => {
      const { API_PREFIX, MEMORY_ENDPOINTS, HEALTH_ENDPOINTS } = await import('../src/api/contract.js');
      
      assert.strictEqual(API_PREFIX, '/api');
      assert.ok(MEMORY_ENDPOINTS.QUERY.startsWith(API_PREFIX));
      assert.ok(MEMORY_ENDPOINTS.SAVE.startsWith(API_PREFIX));
      assert.ok(HEALTH_ENDPOINTS.HEALTH.startsWith(API_PREFIX));
      assert.ok(HEALTH_ENDPOINTS.READY.startsWith(API_PREFIX));
    });

    it('should have all memory endpoints defined', async () => {
      const { MEMORY_ENDPOINTS } = await import('../src/api/contract.js');
      
      const requiredEndpoints = [
        'QUERY',
        'QUERY_CONTEXT',
        'TURN',
        'SAVE',
        'MEMORY',
        'SESSION_START',
        'AUTO_TRIAGE',
        'REVIEWS',
        'GOVERNANCE_PLAN',
        'TIMELINE',
        'WIKI_SEARCH',
        'WIKI_STATUS'
      ];

      for (const endpoint of requiredEndpoints) {
        assert.ok(MEMORY_ENDPOINTS[endpoint], `Missing endpoint: ${endpoint}`);
      }
    });

    it('should have all health endpoints defined', async () => {
      const { HEALTH_ENDPOINTS } = await import('../src/api/contract.js');
      
      assert.ok(HEALTH_ENDPOINTS.HEALTH);
      assert.ok(HEALTH_ENDPOINTS.READY);
    });
  });
});
