/**
 * Unified error handling for the API.
 * Provides consistent error responses across all endpoints.
 */

import { logger } from '../config.js';

/**
 * Custom application error class
 */
export class AppError extends Error {
  /**
   * @param {string} message - Error message
   * @param {number} code - HTTP status code
   * @param {string} errorType - Error type identifier
   * @param {Object} details - Additional error details
   */
  constructor(message, code = 500, errorType = 'INTERNAL_ERROR', details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.errorType = errorType;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, 400, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends AppError {
  constructor(resource, identifier) {
    super(`${resource} not found: ${identifier}`, 404, 'NOT_FOUND', { resource, identifier });
    this.name = 'NotFoundError';
  }
}

/**
 * Conflict error (409)
 */
export class ConflictError extends AppError {
  constructor(message, details = {}) {
    super(message, 409, 'CONFLICT', details);
    this.name = 'ConflictError';
  }
}

/**
 * Rate limit error (429)
 */
export class RateLimitError extends AppError {
  constructor(retryAfter = 60) {
    super('Too Many Requests', 429, 'RATE_LIMIT_EXCEEDED', { retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Unauthorized error (401)
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

/**
 * Forbidden error (403)
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

/**
 * Build error response object
 * @param {Error} err - Error object
 * @param {string} requestId - Request ID for tracking
 * @returns {Object} Formatted error response
 */
function buildErrorResponse(err, requestId = null) {
  const statusCode = err.code || 500;
  const response = {
    success: false,
    error: err.errorType || err.name || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred',
    code: statusCode,
    timestamp: err.timestamp || new Date().toISOString()
  };

  // Add request ID if available
  if (requestId) {
    response.requestId = requestId;
  }

  // Add details for non-500 errors
  if (err instanceof AppError && err.code < 500 && err.details) {
    response.details = err.details;
  }

  // Add validation errors if present
  if (err instanceof ValidationError && err.details.errors) {
    response.errors = err.details.errors;
  }

  return response;
}

/**
 * Fastify error handler
 * @param {Error} err - Error object
 * @param {import('fastify').FastifyRequest} request - Fastify request
 * @param {import('fastify').FastifyReply} reply - Fastify reply
 */
export function errorHandler(err, request, reply) {
  // Get request ID from request or headers
  const requestId = request.id || request.headers['x-request-id'] || null;

  // Handle AppError instances
  if (err instanceof AppError) {
    // Log warning for 4xx errors, error for 5xx
    if (err.code >= 500) {
      logger.error(`[${requestId}] ${err.name}: ${err.message}`, {
        code: err.code,
        stack: err.stack,
        path: request.url
      });
    } else {
      logger.warn(`[${requestId}] ${err.name}: ${err.message}`, {
        code: err.code,
        path: request.url
      });
    }

    const response = buildErrorResponse(err, requestId);
    
    // Add Retry-After header for rate limit errors
    if (err instanceof RateLimitError) {
      reply.header('Retry-After', String(err.retryAfter));
    }

    reply.code(err.code).send(response);
    return;
  }

  // Handle Fastify validation errors
  if (err.validation) {
    const validationError = new ValidationError('Validation failed', {
      errors: err.validation
    });
    const response = buildErrorResponse(validationError, requestId);
    reply.code(400).send(response);
    return;
  }

  // Handle unknown errors
  logger.error(`[${requestId}] Unhandled error: ${err.message}`, {
    stack: err.stack,
    path: request.url
  });

  const internalError = new AppError(
    process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
    500,
    'INTERNAL_ERROR'
  );

  reply.code(500).send(buildErrorResponse(internalError, requestId));
}

/**
 * Success response helper
 * @param {Object} data - Response data
 * @returns {Object} Formatted success response
 */
export function successResponse(data) {
  return { success: true, data };
}

/**
 * Async route handler wrapper
 * Catches async errors and passes them to error handler
 * @param {Function} handler - Async route handler
 * @returns {Function} Wrapped handler
 */
export function asyncHandler(handler) {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      throw err; // Let Fastify error handler catch it
    }
  };
}

export default {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  errorHandler,
  successResponse,
  asyncHandler
};
