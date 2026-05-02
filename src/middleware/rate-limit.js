/**
 * Rate limiting middleware using token bucket algorithm.
 * Protects API endpoints from abuse and DDoS attacks.
 * Unix Socket requests use a separate rate limiter pool to avoid
 * shared-IP throttling with TCP requests.
 */

import { RateLimiterMemory } from 'rate-limiter-flexible';
import { logger } from '../config.js';

const tcpLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_POINTS || '100', 10),
  duration: parseInt(process.env.RATE_LIMIT_DURATION || '60', 10),
  blockDuration: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '0', 10),
});

const unixSocketLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_UNIX_SOCKET_POINTS || '200', 10),
  duration: parseInt(process.env.RATE_LIMIT_DURATION || '60', 10),
  blockDuration: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '0', 10),
});

let rejectedCount = 0;

function isUnixSocketRequest(request) {
  return request.headers['x-unix-socket'] === 'true' ||
         (request.ip === '127.0.0.1' && request.headers['x-forwarded-for'] === undefined && request.socket?.remoteAddress === undefined);
}

export async function rateLimitMiddleware(request, reply) {
  try {
    const unixSocket = isUnixSocketRequest(request);
    const limiter = unixSocket ? unixSocketLimiter : tcpLimiter;
    const key = unixSocket ? 'unix-socket' : (request.ip || request.headers['x-forwarded-for'] || 'unknown');

    await limiter.consume(key);
  } catch (rateLimiterRes) {
    rejectedCount++;

    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000) || 60;

    logger.warn(`Rate limit exceeded for ${request.ip} (unix=${isUnixSocketRequest(request)}): ${rejectedCount} total rejections`);

    reply
      .code(429)
      .header('Retry-After', String(retryAfter))
      .header('X-RateLimit-Limit', process.env.RATE_LIMIT_POINTS || '100')
      .header('X-RateLimit-Remaining', '0')
      .header('X-RateLimit-Reset', new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString())
      .send({
        success: false,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
        timestamp: new Date().toISOString()
      });
  }
}

export function getRateLimitMetrics() {
  return {
    rejected_total: rejectedCount,
    tcp: {
      points: parseInt(process.env.RATE_LIMIT_POINTS || '100', 10),
      duration: parseInt(process.env.RATE_LIMIT_DURATION || '60', 10),
      block_duration: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '0', 10)
    },
    unix_socket: {
      points: parseInt(process.env.RATE_LIMIT_UNIX_SOCKET_POINTS || '200', 10),
      duration: parseInt(process.env.RATE_LIMIT_DURATION || '60', 10),
      block_duration: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '0', 10)
    }
  };
}

export default rateLimitMiddleware;
