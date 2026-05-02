import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeQuery } from '../src/api/sanitize.js';

// Helper: build metadata block string
function metaBlock(prefix, json, message) {
  const block = prefix + ':\n```json\n' + json + '\n```';
  return message ? block + '\n' + message : block;
}

describe('sanitizeQuery', () => {
  // === Normal queries ===

  it('should pass through normal queries unchanged', () => {
    const r = sanitizeQuery('中间层情况如何');
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, '中间层情况如何');
    assert.equal(r.reason, 'ok');
  });

  it('should pass through normal English queries', () => {
    const r = sanitizeQuery('context-engine status');
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'context-engine status');
    assert.equal(r.reason, 'ok');
  });

  // === Conversation info metadata ===

  it('should extract user message from Conversation info metadata', () => {
    const raw = metaBlock(
      'Conversation info (untrusted metadata)',
      '{"message_id": "openclaw-weixin:123", "chat_id": "abc"}',
      '中间层情况如何'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, '中间层情况如何');
    assert.equal(r.reason, 'extracted_from_metadata');
  });

  it('should reject pure Conversation info metadata with no user message', () => {
    const raw = metaBlock(
      'Conversation info (untrusted metadata)',
      '{"message_id": "openclaw-weixin:123"}'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'metadata_wrapper_only');
  });

  // === Sender metadata ===

  it('should extract user message from Sender metadata', () => {
    const raw = metaBlock(
      'Sender (untrusted metadata)',
      '{"name": "test-user"}',
      'Hello world'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'Hello world');
    assert.equal(r.reason, 'extracted_from_metadata');
  });

  // === Multiple metadata blocks ===

  it('should handle multiple metadata blocks and extract trailing message', () => {
    const raw =
      metaBlock('Conversation info (untrusted metadata)', '{"message_id": "123"}') + '\n' +
      metaBlock('Sender (untrusted metadata)', '{"name": "user"}', 'What is the status?');
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'What is the status?');
    assert.equal(r.reason, 'extracted_from_metadata');
  });

  it('should reject multiple metadata blocks with no user message', () => {
    const raw =
      metaBlock('Conversation info (untrusted metadata)', '{"message_id": "123"}') + '\n' +
      metaBlock('Sender (untrusted metadata)', '{"name": "user"}');
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'metadata_wrapper_only');
  });

  // === Other known prefixes ===

  it('should handle Thread starter metadata', () => {
    const raw = metaBlock(
      'Thread starter (untrusted, for context)',
      '{"content": "old message"}',
      'New reply content'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'New reply content');
    assert.equal(r.reason, 'extracted_from_metadata');
  });

  it('should handle Replied message metadata', () => {
    const raw = metaBlock(
      'Replied message (untrusted, for context)',
      '{"content": "quoted msg"}',
      'My reply'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'My reply');
  });

  it('should handle Chat history metadata', () => {
    const raw = metaBlock(
      'Chat history since last reply (untrusted, for context)',
      '[{"msg": "hi"}]',
      'Follow up'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'Follow up');
  });

  it('should handle Forwarded message context metadata', () => {
    const raw = metaBlock(
      'Forwarded message context (untrusted metadata)',
      '{"from": "group-a"}',
      'Check this out'
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'Check this out');
  });

  // === Edge cases ===

  it('should return invalid for null input', () => {
    const r = sanitizeQuery(null);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'empty_or_invalid');
  });

  it('should return invalid for undefined input', () => {
    const r = sanitizeQuery(undefined);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'empty_or_invalid');
  });

  it('should return invalid for empty string', () => {
    const r = sanitizeQuery('');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'empty_or_invalid');
  });

  it('should return invalid for non-string input', () => {
    const r = sanitizeQuery(123);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'empty_or_invalid');
  });

  it('should trim whitespace from extracted message', () => {
    const raw = metaBlock(
      'Conversation info (untrusted metadata)',
      '{"x": 1}',
      '\n  hello  '
    );
    const r = sanitizeQuery(raw);
    assert.equal(r.valid, true);
    assert.equal(r.cleaned, 'hello');
  });
});
