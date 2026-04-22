/**
 * Chinese/English tokenizer.
 * Uses nodejieba for Chinese segmentation with additional preprocessing.
 */

import nodejieba from 'nodejieba';

// English stopwords
const ENGLISH_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
  'need', 'dare', 'ought', 'used', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his',
  'himself', 'she', 'her', 'hers', 'herself', 'they', 'them', 'their',
  'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'whose',
  'where', 'when', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'now',
]);

// Chinese stopwords (common function words)
const CHINESE_STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
  '看', '好', '自己', '这', '那', '这些', '那些', '这个', '那个', '之', '与',
  '及', '等', '或', '但', '而', '因为', '所以', '如果', '虽然', '然而',
]);

/**
 * Pre-split CamelCase and snake_case words.
 * @param {string} text
 * @returns {string}
 */
function preSplitIdentifiers(text) {
  // Split CamelCase: helloWorld -> hello World
  let result = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Split snake_case: hello_world -> hello world
  result = result.replace(/_/g, ' ');
  // Split kebab-case: hello-world -> hello world
  result = result.replace(/-/g, ' ');
  return result;
}

/**
 * Generate CJK bigrams and trigrams.
 * @param {string} text
 * @returns {string[]}
 */
function generateCjkNgrams(text) {
  const ngrams = [];
  const chars = text.split('');
  for (let i = 0; i < chars.length - 1; i++) {
    if (/[\u4e00-\u9fff]/.test(chars[i])) {
      // Bigram
      if (i + 1 < chars.length && /[\u4e00-\u9fff]/.test(chars[i + 1])) {
        ngrams.push(chars[i] + chars[i + 1]);
      }
      // Trigram
      if (i + 2 < chars.length && /[\u4e00-\u9fff]/.test(chars[i + 2])) {
        ngrams.push(chars[i] + chars[i + 1] + chars[i + 2]);
      }
    }
  }
  return ngrams;
}

/**
 * Simple English stemming (porter stemmer lite).
 * @param {string} word
 * @returns {string}
 */
function stem(word) {
  // Very basic stemming rules
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ied') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ying') && word.length > 5) return word.slice(0, -3) + 'ie';
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  if (word.endsWith('es') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('ed') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('tion') && word.length > 5) return word.slice(0, -4) + 'e';
  return word;
}

/**
 * Tokenize text for general use (indexing and search).
 * @param {string} text
 * @param {Object} options
 * @param {boolean} options.removeStopwords - Remove stopwords (default true).
 * @param {boolean} options.stem - Apply stemming (default true).
 * @param {boolean} options.cjkNgrams - Generate CJK n-grams (default true).
 * @returns {string[]}
 */
export function tokenize(text, { removeStopwords = true, stem: doStem = true, cjkNgrams = true } = {}) {
  if (!text || typeof text !== 'string') return [];

  // Pre-split identifiers
  const preprocessed = preSplitIdentifiers(text);

  // Use nodejieba for Chinese segmentation
  const tokens = nodejieba.cut(preprocessed, true); // true = cut_all mode for indexing

  const result = [];
  for (const token of tokens) {
    if (typeof token !== 'string') continue;
    const trimmed = token.trim().toLowerCase();
    if (!trimmed || trimmed.length === 0) continue;

    // Check if it's CJK
    const isCjk = /[\u4e00-\u9fff]/.test(trimmed);

    if (isCjk) {
      if (removeStopwords && CHINESE_STOPWORDS.has(trimmed)) continue;
      result.push(trimmed);
      if (cjkNgrams) {
        result.push(...generateCjkNgrams(trimmed));
      }
    } else {
      // English/other
      if (removeStopwords && ENGLISH_STOPWORDS.has(trimmed)) continue;
      if (doStem) {
        result.push(stem(trimmed));
      } else {
        result.push(trimmed);
      }
    }
  }

  return result;
}

/**
 * Tokenize text keeping all tokens (for memory indexing).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeKeepAll(text) {
  return tokenize(text, { removeStopwords: false, stem: false, cjkNgrams: false });
}

/**
 * Tokenize specifically for memory search.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForMemory(text) {
  return tokenize(text, { removeStopwords: true, stem: true, cjkNgrams: true });
}

/**
 * Check if text contains Chinese characters.
 * @param {string} text
 * @returns {boolean}
 */
export function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

export default {
  tokenize,
  tokenizeKeepAll,
  tokenizeForMemory,
  hasChinese,
};
