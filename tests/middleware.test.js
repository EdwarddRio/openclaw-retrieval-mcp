/**
 * Middleware tests.
 * Tests for rate-limit, cors, tracing, and error-handler middleware.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('Middleware', () => {
  describe('Rate Limiter', () => {
    let rateLimitMiddleware, getRateLimitMetrics;

    beforeEach(async () => {
      // Reset module to clear state
      const mod = await import('../src/middleware/rate-limit.js');
      rateLimitMiddleware = mod.rateLimitMiddleware;
      getRateLimitMetrics = mod.getRateLimitMetrics;
    });

    it('should export rateLimitMiddleware function', () => {
      assert.strictEqual(typeof rateLimitMiddleware, 'function');
    });

    it('should export getRateLimitMetrics function', () => {
      assert.strictEqual(typeof getRateLimitMetrics, 'function');
    });

    it('should return rate limit metrics', () => {
      const metrics = getRateLimitMetrics();
      assert.ok(typeof metrics === 'object');
      assert.ok('rejected_total' in metrics);
      assert.ok('tcp' in metrics);
      assert.ok('unix_socket' in metrics);
    });

    it('should have default configuration for TCP and Unix Socket', () => {
      const metrics = getRateLimitMetrics();
      assert.strictEqual(metrics.tcp.points, 100);
      assert.strictEqual(metrics.tcp.duration, 60);
      assert.strictEqual(metrics.unix_socket.points, 200);
      assert.strictEqual(metrics.unix_socket.duration, 60);
    });
  });

  describe('CORS Middleware', () => {
    let corsMiddleware, getCorsConfig;

    beforeEach(async () => {
      const mod = await import('../src/middleware/cors.js');
      corsMiddleware = mod.corsMiddleware;
      getCorsConfig = mod.getCorsConfig;
    });

    it('should export corsMiddleware function', () => {
      assert.strictEqual(typeof corsMiddleware, 'function');
    });

    it('should export getCorsConfig function', () => {
      assert.strictEqual(typeof getCorsConfig, 'function');
    });

    it('should return CORS configuration', () => {
      const config = getCorsConfig();
      assert.ok(Array.isArray(config.origins));
      assert.ok(Array.isArray(config.methods));
      assert.ok(Array.isArray(config.allowed_headers));
      assert.ok(typeof config.max_age === 'number');
      assert.ok(typeof config.credentials === 'boolean');
    });

    it('should allow all origins by default', () => {
      const config = getCorsConfig();
      assert.ok(config.origins.includes('*'));
    });

    it('should include standard HTTP methods', () => {
      const config = getCorsConfig();
      assert.ok(config.methods.includes('GET'));
      assert.ok(config.methods.includes('POST'));
      assert.ok(config.methods.includes('PUT'));
      assert.ok(config.methods.includes('DELETE'));
      assert.ok(config.methods.includes('OPTIONS'));
    });

    it('should include standard headers', () => {
      const config = getCorsConfig();
      assert.ok(config.allowed_headers.includes('Content-Type'));
      assert.ok(config.allowed_headers.includes('Authorization'));
    });
  });

  describe('Tracing Middleware', () => {
    let tracingMiddleware, timingMiddleware, getRequestContext, getDuration, generateRequestId;

    beforeEach(async () => {
      const mod = await import('../src/middleware/tracing.js');
      tracingMiddleware = mod.tracingMiddleware;
      timingMiddleware = mod.timingMiddleware;
      getRequestContext = mod.getRequestContext;
      getDuration = mod.getDuration;
      generateRequestId = mod.generateRequestId;
    });

    it('should export tracingMiddleware function', () => {
      assert.strictEqual(typeof tracingMiddleware, 'function');
    });

    it('should export timingMiddleware function', () => {
      assert.strictEqual(typeof timingMiddleware, 'function');
    });

    it('should export getRequestContext function', () => {
      assert.strictEqual(typeof getRequestContext, 'function');
    });

    it('should export getDuration function', () => {
      assert.strictEqual(typeof getDuration, 'function');
    });

    it('should export generateRequestId function', () => {
      assert.strictEqual(typeof generateRequestId, 'function');
    });

    it('should generate valid UUID', () => {
      const id = generateRequestId();
      assert.ok(typeof id === 'string');
      assert.ok(id.length > 0);
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
    });

    it('should generate unique request IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      assert.notStrictEqual(id1, id2);
    });

    it('should calculate duration', () => {
      const startTime = Date.now() - 100;
      const duration = getDuration(startTime);
      assert.ok(duration >= 100);
      assert.ok(duration < 200); // Allow some margin
    });

    it('should handle null startTime in getDuration', () => {
      const duration = getDuration(null);
      assert.ok(typeof duration === 'number');
      assert.ok(duration >= 0);
    });

    it('should extract request context', () => {
      const mockRequest = {
        id: 'test-id',
        method: 'GET',
        url: '/api/test',
        ip: '127.0.0.1',
        headers: {
          'user-agent': 'test-agent'
        },
        startTime: Date.now()
      };

      const context = getRequestContext(mockRequest);
      assert.strictEqual(context.requestId, 'test-id');
      assert.strictEqual(context.method, 'GET');
      assert.strictEqual(context.url, '/api/test');
      assert.strictEqual(context.ip, '127.0.0.1');
      assert.strictEqual(context.userAgent, 'test-agent');
    });
  });

  describe('Error Handler', () => {
    let AppError, ValidationError, NotFoundError, ConflictError, RateLimitError, UnauthorizedError, ForbiddenError, errorHandler, successResponse, asyncHandler;

    beforeEach(async () => {
      const mod = await import('../src/middleware/error-handler.js');
      AppError = mod.AppError;
      ValidationError = mod.ValidationError;
      NotFoundError = mod.NotFoundError;
      ConflictError = mod.ConflictError;
      RateLimitError = mod.RateLimitError;
      UnauthorizedError = mod.UnauthorizedError;
      ForbiddenError = mod.ForbiddenError;
      errorHandler = mod.errorHandler;
      successResponse = mod.successResponse;
      asyncHandler = mod.asyncHandler;
    });

    it('should export error classes', () => {
      assert.strictEqual(typeof AppError, 'function');
      assert.strictEqual(typeof ValidationError, 'function');
      assert.strictEqual(typeof NotFoundError, 'function');
      assert.strictEqual(typeof ConflictError, 'function');
      assert.strictEqual(typeof RateLimitError, 'function');
      assert.strictEqual(typeof UnauthorizedError, 'function');
      assert.strictEqual(typeof ForbiddenError, 'function');
    });

    it('should export utility functions', () => {
      assert.strictEqual(typeof errorHandler, 'function');
      assert.strictEqual(typeof successResponse, 'function');
      assert.strictEqual(typeof asyncHandler, 'function');
    });

    it('should create AppError with correct properties', () => {
      const err = new AppError('Test error', 400, 'TEST_ERROR', { detail: 'test' });
      assert.strictEqual(err.message, 'Test error');
      assert.strictEqual(err.code, 400);
      assert.strictEqual(err.errorType, 'TEST_ERROR');
      assert.deepStrictEqual(err.details, { detail: 'test' });
      assert.ok(err.timestamp);
    });

    it('should create ValidationError', () => {
      const err = new ValidationError('Invalid input', { field: 'name' });
      assert.strictEqual(err.message, 'Invalid input');
      assert.strictEqual(err.code, 400);
      assert.strictEqual(err.errorType, 'VALIDATION_ERROR');
    });

    it('should create NotFoundError', () => {
      const err = new NotFoundError('Memory', '123');
      assert.ok(err.message.includes('Memory'));
      assert.ok(err.message.includes('123'));
      assert.strictEqual(err.code, 404);
      assert.strictEqual(err.errorType, 'NOT_FOUND');
    });

    it('should create ConflictError', () => {
      const err = new ConflictError('State conflict');
      assert.strictEqual(err.message, 'State conflict');
      assert.strictEqual(err.code, 409);
      assert.strictEqual(err.errorType, 'CONFLICT');
    });

    it('should create RateLimitError', () => {
      const err = new RateLimitError(30);
      assert.strictEqual(err.message, 'Too Many Requests');
      assert.strictEqual(err.code, 429);
      assert.strictEqual(err.retryAfter, 30);
    });

    it('should create UnauthorizedError', () => {
      const err = new UnauthorizedError();
      assert.strictEqual(err.message, 'Unauthorized');
      assert.strictEqual(err.code, 401);
    });

    it('should create ForbiddenError', () => {
      const err = new ForbiddenError();
      assert.strictEqual(err.message, 'Access denied');
      assert.strictEqual(err.code, 403);
    });

    it('should format success response', () => {
      const response = successResponse({ id: 1 });
      assert.deepStrictEqual(response, { success: true, data: { id: 1 } });
    });

    it('should wrap async handler', async () => {
      let handlerCalled = false;
      const handler = async (req, reply) => {
        handlerCalled = true;
        return 'result';
      };

      const wrapped = asyncHandler(handler);
      const result = await wrapped({}, {});
      assert.ok(handlerCalled);
      assert.strictEqual(result, 'result');
    });

    it('should catch errors in async handler', async () => {
      const handler = async (req, reply) => {
        throw new Error('Test error');
      };

      const wrapped = asyncHandler(handler);
      try {
        await wrapped({}, {});
        assert.fail('Should have thrown');
      } catch (err) {
        assert.strictEqual(err.message, 'Test error');
      }
    });
  });

  describe('Middleware Index', () => {
    it('should export all middleware', async () => {
      const mod = await import('../src/middleware/index.js');
      assert.ok(mod.rateLimitMiddleware);
      assert.ok(mod.corsMiddleware);
      assert.ok(mod.tracingMiddleware);
      assert.ok(mod.errorHandler);
      assert.ok(mod.successResponse);
      assert.ok(mod.asyncHandler);
      assert.ok(mod.getRateLimitMetrics);
      assert.ok(mod.getCorsConfig);
      assert.ok(mod.getRequestContext);
      assert.ok(mod.getDuration);
      assert.ok(mod.generateRequestId);
    });
  });
});
