/**
 * Validation middleware.
 * Provides request body validation utilities.
 */

import path from 'path';

/**
 * Create a preHandler that validates request body against a validator class
 * @param {Function} ValidatorClass - Validator class with validate() method
 * @returns {Function} Fastify preHandler function
 */
export function validateBody(ValidatorClass) {
  return async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      return reply.code(400).send({ 
        success: false, 
        error: 'Request body is required',
        timestamp: new Date().toISOString()
      });
    }
    const instance = new ValidatorClass(request.body);
    const { valid, errors } = instance.validate();
    if (!valid) {
      return reply.code(400).send({ 
        success: false, 
        error: `Validation failed: ${errors.join(', ')}`,
        timestamp: new Date().toISOString()
      });
    }
  };
}

/**
 * Check if a target path is inside a root directory (path traversal protection)
 * @param {string} rootPath - Root directory path
 * @param {string} targetPath - Target path to check
 * @returns {boolean} Whether target path is inside root
 */
export function isPathInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Validate and sanitize a file path
 * @param {string} filePath - Path to validate
 * @param {Object} options - Validation options
 * @param {string[]} options.allowedExtensions - Allowed file extensions
 * @param {string} options.rootPath - Root path for traversal check
 * @returns {{ valid: boolean, error?: string, resolvedPath?: string }}
 */
export function validateFilePath(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'File path is required' };
  }

  // Resolve the path
  const resolved = path.resolve(filePath);

  // Check for path traversal if rootPath is provided
  if (options.rootPath) {
    if (!isPathInsideRoot(options.rootPath, resolved)) {
      return { valid: false, error: 'Access denied: path traversal detected' };
    }
  }

  // Check file extension if allowedExtensions is provided
  if (options.allowedExtensions && options.allowedExtensions.length > 0) {
    const ext = path.extname(resolved).toLowerCase();
    if (!options.allowedExtensions.includes(ext)) {
      return { 
        valid: false, 
        error: `Invalid file extension: ${ext}. Allowed: ${options.allowedExtensions.join(', ')}` 
      };
    }
  }

  return { valid: true, resolvedPath: resolved };
}

export default {
  validateBody,
  isPathInsideRoot,
  validateFilePath
};
