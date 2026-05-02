/**
 * Middleware module exports.
 * Centralizes all middleware imports for easy access.
 */

export { rateLimitMiddleware, getRateLimitMetrics } from './rate-limit.js';
export { corsMiddleware, getCorsConfig } from './cors.js';
export { 
  tracingMiddleware, 
  timingMiddleware, 
  getRequestContext, 
  getDuration,
  generateRequestId 
} from './tracing.js';
export {
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
} from './error-handler.js';

export default {
  rateLimitMiddleware: () => import('./rate-limit.js').then(m => m.rateLimitMiddleware),
  corsMiddleware: () => import('./cors.js').then(m => m.corsMiddleware),
  tracingMiddleware: () => import('./tracing.js').then(m => m.tracingMiddleware),
  errorHandler: () => import('./error-handler.js').then(m => m.errorHandler)
};
