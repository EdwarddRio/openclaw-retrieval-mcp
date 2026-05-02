/**
 * CORS middleware for Fastify.
 * Handles Cross-Origin Resource Sharing headers and preflight requests.
 */

/**
 * Parse allowed origins from environment variable
 * @returns {string[]} Array of allowed origins
 */
function getAllowedOrigins() {
  const origins = process.env.CORS_ORIGINS || '*';
  if (origins === '*') return ['*'];
  return origins.split(',').map(o => o.trim()).filter(Boolean);
}

/**
 * CORS middleware for Fastify
 * @param {import('fastify').FastifyRequest} request - Fastify request object
 * @param {import('fastify').FastifyReply} reply - Fastify reply object
 * @param {Function} done - Callback to continue
 */
export function corsMiddleware(request, reply, done) {
  const allowedOrigins = getAllowedOrigins();
  const origin = request.headers.origin;
  
  // Check if origin is allowed
  if (allowedOrigins.includes('*')) {
    reply.header('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
  
  // Set CORS headers
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id, X-Requested-With');
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
    return;
  }
  
  done();
}

/**
 * Get CORS configuration for documentation
 * @returns {Object} CORS configuration
 */
export function getCorsConfig() {
  return {
    origins: getAllowedOrigins(),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowed_headers: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Requested-With'],
    max_age: 86400,
    credentials: true
  };
}

export default corsMiddleware;
