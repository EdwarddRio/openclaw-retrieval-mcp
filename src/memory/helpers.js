/**
 * Memory helper utilities.
 */

/**
 * Generate a canonical key from memory content.
 * @param {string} content
 * @returns {string}
 */
export function generateCanonicalKey(content) {
  if (!content) return '';
  // Simple canonical key: first 50 chars, normalized
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .toLowerCase();
}

/**
 * Extract entities from text for memory linking.
 * @param {string} text
 * @returns {string[]}
 */
export function extractEntities(text) {
  if (!text) return [];
  const entities = [];

  // Extract CamelCase identifiers
  const camelCaseMatches = text.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)+/g);
  if (camelCaseMatches) entities.push(...camelCaseMatches);

  // Extract quoted strings
  const quotedMatches = text.match(/"([^"]+)"|'([^']+)'/g);
  if (quotedMatches) {
    entities.push(...quotedMatches.map(m => m.slice(1, -1)));
  }

  // Extract file paths
  const pathMatches = text.match(/[\w/\\.-]+\.[a-zA-Z]+/g);
  if (pathMatches) entities.push(...pathMatches);

  return [...new Set(entities)];
}

/**
 * Score memory relevance to a query.
 * @param {string} query
 * @param {string} memoryContent
 * @returns {number}
 */
export function scoreRelevance(query, memoryContent) {
  if (!query || !memoryContent) return 0;

  const queryTerms = query.toLowerCase().split(/\s+/);
  const content = memoryContent.toLowerCase();

  let matches = 0;
  for (const term of queryTerms) {
    if (content.includes(term)) matches++;
  }

  return matches / queryTerms.length;
}

/**
 * Build a summary of memory items.
 * @param {Array} memories
 * @returns {string}
 */
export function buildMemorySummary(memories) {
  if (!memories || memories.length === 0) return 'No memories found.';

  const lines = memories.map((m, i) =>
    `${i + 1}. [${m.status}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`
  );
  return lines.join('\n');
}

export default {
  generateCanonicalKey,
  extractEntities,
  scoreRelevance,
  buildMemorySummary,
};
