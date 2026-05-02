/**
 * Validation middleware tests.
 * Tests for validateBody, isPathInsideRoot, validateFilePath.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBody, isPathInsideRoot, validateFilePath } from '../src/middleware/validation.js';
import { MemoryQueryRequest, MemorySaveRequest, WikiSearchRequest } from '../src/api/contract.js';

describe('Validation', () => {
  describe('validateBody', () => {
    it('should reject request with no body', async () => {
      let replyCode = null;
      let replyBody = null;
      const reply = {
        code: (c) => { replyCode = c; return reply; },
        send: (b) => { replyBody = b; return reply; },
      };
      const middleware = validateBody(MemoryQueryRequest);
      const result = await middleware({ body: null }, reply);
      assert.strictEqual(replyCode, 400);
      assert.strictEqual(replyBody.success, false);
    });

    it('should reject request with non-object body', async () => {
      let replyCode = null;
      let replyBody = null;
      const reply = {
        code: (c) => { replyCode = c; return reply; },
        send: (b) => { replyBody = b; return reply; },
      };
      const middleware = validateBody(MemoryQueryRequest);
      const result = await middleware({ body: 'string' }, reply);
      assert.strictEqual(replyCode, 400);
    });

    it('should reject request with invalid fields', async () => {
      let replyCode = null;
      let replyBody = null;
      const reply = {
        code: (c) => { replyCode = c; return reply; },
        send: (b) => { replyBody = b; return reply; },
      };
      const middleware = validateBody(MemoryQueryRequest);
      const result = await middleware({ body: { query: '' } }, reply);
      assert.strictEqual(replyCode, 400);
      assert.strictEqual(replyBody.success, false);
      assert.ok(replyBody.error.includes('Validation failed'));
    });

    it('should accept request with valid body', async () => {
      let replyCalled = false;
      const reply = {
        code: () => { replyCalled = true; return reply; },
        send: () => { replyCalled = true; return reply; },
      };
      const middleware = validateBody(MemoryQueryRequest);
      await middleware({ body: { query: 'test query' } }, reply);
      assert.strictEqual(replyCalled, false);
    });

    it('should return from reply on validation failure (not continue)', async () => {
      let replyCode = null;
      const reply = {
        code: (c) => { replyCode = c; return reply; },
        send: () => reply,
      };
      const middleware = validateBody(MemorySaveRequest);
      const result = await middleware({ body: { content: '' } }, reply);
      assert.strictEqual(replyCode, 400);
      assert.ok(result !== undefined);
    });

    it('should validate MemorySaveRequest content length', async () => {
      let replyCode = null;
      const reply = {
        code: (c) => { replyCode = c; return reply; },
        send: () => reply,
      };
      const middleware = validateBody(MemorySaveRequest);
      await middleware({ body: { content: 'x'.repeat(5001) } }, reply);
      assert.strictEqual(replyCode, 400);
    });

    it('should validate MemorySaveRequest invalid state', async () => {
      let replyCode = null;
      const reply = {
        code: (c) => { replyCode = c; return reply; },
        send: () => reply,
      };
      const middleware = validateBody(MemorySaveRequest);
      await middleware({ body: { content: 'valid', state: 'invalid' } }, reply);
      assert.strictEqual(replyCode, 400);
    });
  });

  describe('isPathInsideRoot', () => {
    it('should return true for path inside root', () => {
      assert.ok(isPathInsideRoot('/home/user/project', '/home/user/project/src/file.js'));
    });

    it('should return true for root itself', () => {
      assert.ok(isPathInsideRoot('/home/user/project', '/home/user/project'));
    });

    it('should return false for path traversal', () => {
      assert.ok(!isPathInsideRoot('/home/user/project', '/home/user/project/../etc/passwd'));
    });

    it('should return false for absolute path outside root', () => {
      assert.ok(!isPathInsideRoot('/home/user/project', '/etc/passwd'));
    });
  });

  describe('validateFilePath', () => {
    it('should reject empty path', () => {
      const result = validateFilePath('');
      assert.strictEqual(result.valid, false);
    });

    it('should reject non-string path', () => {
      const result = validateFilePath(null);
      assert.strictEqual(result.valid, false);
    });

    it('should reject path traversal', () => {
      const result = validateFilePath('/etc/passwd', { rootPath: '/home/user/project' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('traversal'));
    });

    it('should reject invalid extension', () => {
      const result = validateFilePath('/home/user/project/file.exe', {
        rootPath: '/home/user/project',
        allowedExtensions: ['.md', '.json'],
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('extension'));
    });

    it('should accept valid path with allowed extension', () => {
      const result = validateFilePath('/home/user/project/notes.md', {
        rootPath: '/home/user/project',
        allowedExtensions: ['.md', '.json'],
      });
      assert.strictEqual(result.valid, true);
      assert.ok(result.resolvedPath);
    });

    it('should accept path without extension check when not specified', () => {
      const result = validateFilePath('/home/user/project/file.xyz', {
        rootPath: '/home/user/project',
      });
      assert.strictEqual(result.valid, true);
    });
  });
});
