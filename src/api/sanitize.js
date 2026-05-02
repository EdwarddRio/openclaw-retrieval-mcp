/**
 * Sanitize query input: strip OpenClaw inbound metadata wrappers.
 *
 * OpenClaw injects metadata blocks before user messages in the format:
 *   <Label> (untrusted ...):
 *   ```json
 *   {...}
 *   ```
 *
 * Known prefixes (from memory-tencentdb sanitize.ts):
 *   - Conversation info (untrusted metadata):
 *   - Sender (untrusted metadata):
 *   - Thread starter (untrusted, for context):
 *   - Replied message (untrusted, for context):
 *   - Forwarded message context (untrusted metadata):
 *   - Chat history since last reply (untrusted, for context):
 */

// Match a single metadata block: prefix line + ```json ... ```
const SINGLE_METADATA_BLOCK_RE =
  /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[^)]*\):\s*\r?\n```[^\n]*\n[\s\S]*?```/g;

/**
 * Clean a raw query string, removing or extracting content from metadata wrappers.
 * @param {unknown} raw - The raw query input
 * @returns {{ valid: boolean, cleaned: string, reason: string }}
 */
export function sanitizeQuery(raw) {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, cleaned: '', reason: 'empty_or_invalid' };
  }
  const trimmed = raw.trim();

  // Strategy 1: anchor-based truncation
  // Find the last (untrusted ...) block, then take everything after its closing ```
  const untrustedAnchor = trimmed.lastIndexOf('(untrusted');
  if (untrustedAnchor !== -1) {
    // From the anchor, find the opening ``` (on the next line after the colon)
    const colonIdx = trimmed.indexOf(':', untrustedAnchor);
    if (colonIdx !== -1) {
      // Find the first ``` after the colon (this is the opening fence)
      const openFence = trimmed.indexOf('```', colonIdx);
      if (openFence !== -1) {
        // Find the closing ``` after the opening fence (skip past the opening one)
        const closeFence = trimmed.indexOf('```', openFence + 3);
        if (closeFence !== -1) {
          const afterBlock = trimmed.slice(closeFence + 3).trim();
          if (afterBlock.length > 0) {
            return { valid: true, cleaned: afterBlock, reason: 'extracted_from_metadata' };
          }
          // Only metadata blocks, no user message after
          return { valid: false, cleaned: '', reason: 'metadata_wrapper_only' };
        }
      }
    }
  }

  // Strategy 2: regex-based strip — remove all known metadata blocks
  const stripped = trimmed.replace(SINGLE_METADATA_BLOCK_RE, '').trim();
  if (stripped.length === 0 && trimmed.length > 0) {
    return { valid: false, cleaned: '', reason: 'metadata_wrapper_only' };
  }
  if (stripped !== trimmed && stripped.length > 0) {
    return { valid: true, cleaned: stripped, reason: 'stripped_metadata_blocks' };
  }

  // No metadata detected — pass through
  return { valid: true, cleaned: trimmed, reason: 'ok' };
}
