/**
 * Request tracing middleware.
 * Assigns unique request IDs and tracks request timing.
 */

import crypto from 'crypto';

/**
 * Generate a unique request ID
 * @returns {string} UUID v4
 */
export function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * Request tracing middleware for Fastify
 * Adds X-Request-Id header and tracks request timing
 * @param {import('fastify').FastifyRequest} request - Fastify request object
 * @param {import('fastify').FastifyReply} reply - Fastify reply object
 * @param {Function} done - Callback to continue
 */
export function tracingMiddleware(request, reply, done) {
  // Use existing request ID or generate new one
  const requestId = request.headers['x-request-id'] || generateRequestId();
  
  // Attach to request object for use in handlers
  request.id = requestId;
  request.startTime = Date.now();
  
  // Add request ID to response headers
  reply.header('X-Request-Id', requestId);
  
  done();
}

/**
 * Response timing middleware
 * Adds X-Response-Time header
 * @param {import('fastify').FastifyRequest} request - Fastify request object
 * @param {import('fastify').FastifyReply} reply - Fastify reply object
 * @param {Function} done - Callback to continue
 */
export function timingMiddleware(request, reply, done) {
  const startTime = request.startTime || Date.now();
  
  // Add timing header in onResponse hook
  reply.addHook('onResponse', (req, res, cb) => {
    const duration = Date.now() - startTime;
    reply.header('X-Response-Time', `${duration}ms`);
    cb();
  });
  
  done();
}

/**
 * Get request context for logging
 * @param {import('fastify').FastifyRequest} request - Fastify request
 * @returns {Object} Request context
 */
export function getRequestContext(request) {
  return {
    requestId: request.id,
    method: request.method,
    url: request.url,
    ip: request.ip || request.headers['x-forwarded-for'],
    userAgent: request.headers['user-agent'],
    startTime: request.startTime
  };
}

/**
 * Calculate request duration
 * @param {number} startTime - Request start timestamp
 * @returns {number} Duration in milliseconds
 */
export function getDuration(startTime) {
  return Date.now() - (startTime || Date.now());
}

export default {
  tracingMiddleware,
  timingMiddleware,
  getRequestContext,
  getDuration,
  generateRequestId
};
