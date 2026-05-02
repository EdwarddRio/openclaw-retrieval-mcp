/**
 * 通用分词器 - 支持中文和英文文本分词
 * 设计原则：bigram 为内置默认（零依赖），jieba 为可选增强（自动检测，安装即生效）
 */

// ========== 停用词 ==========

/** 英文停用词 */
const EN_STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'because', 'as', 'until', 'while', 'of',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
  'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they',
  'them', 'their', 'theirs', 'themselves', 'into', 'if', 'then',
]);

/** 中文停用词 */
const ZH_STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '这', '那', '这个', '那个', '这些', '那些', '就', '都', '要', '会',
  '能', '可以', '可能', '应该', '必须', '需要', '不', '没', '没有',
  '也', '还', '又', '再', '就', '才', '只', '仅', '和', '与', '或',
  '但', '但是', '然而', '不过', '虽然', '尽管', '因为', '所以', '如果',
  '那么', '这样', '那样', '什么', '怎么', '为什么', '哪里', '哪个',
  '谁', '多少', '几', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
]);

/** 合并停用词 */
const STOP_WORDS = new Set([...EN_STOP_WORDS, ...ZH_STOP_WORDS]);

// ========== 内置分词实现：bigram（零依赖） ==========

/**
 * bigram 分词 - 内置默认实现，零依赖
 * @param {string} text - 输入文本
 * @returns {string[]} 分词结果
 */
function tokenizeBigram(text) {
  if (!text) return [];
  
  const tokens = [];
  // 匹配英文/数字/下划线片段、中文字符片段、其他符号
  const segments = text.match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]+|[^\s\u4e00-\u9fff\w]+/g) || [];
  
  for (const seg of segments) {
    if (/^[A-Za-z0-9_]+$/.test(seg)) {
      // 英文/数字片段：转小写
      tokens.push(seg.toLowerCase());
    } else if (/[\u4e00-\u9fff]/.test(seg)) {
      // 中文片段：生成 bigram
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.push(seg.substring(i, i + 2)); // bigram
      }
      if (seg.length <= 4) {
        tokens.push(seg); // ≤4字整段保留
      }
    }
  }
  
  // 过滤停用词和单字符
  return tokens.filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// ========== 增强分词实现：jieba（可选） ==========

let _jieba = undefined; // undefined=未尝试, null=不可用, object=可用

/**
 * 获取 jieba 实例（懒加载，同步版本）
 * @returns {Object|null} jieba 实例或 null
 */
function getJieba() {
  if (_jieba !== undefined) return _jieba;
  
  try {
    // 尝试使用 createRequire 加载
    const { createRequire } = require('module');
    const require2 = createRequire(import.meta.url);
    const { Jieba } = require2('@node-rs/jieba');
    const { dict } = require2('@node-rs/jieba/dict');
    _jieba = Jieba.withDict(dict);
    console.log('[tokenizer] jieba loaded successfully, using cutForSearch mode');
  } catch {
    _jieba = null;
    console.warn('[tokenizer] jieba not available, falling back to bigram. Install @node-rs/jieba for better Chinese tokenization');
  }
  
  return _jieba;
}

/**
 * jieba 分词 - 可选增强实现
 * @param {string} text - 输入文本
 * @returns {string[]} 分词结果
 */
function tokenizeJieba(text) {
  const jieba = getJieba();
  if (!jieba) return tokenizeBigram(text); // fallback
  
  try {
    return jieba.cutForSearch(text, true)
      .map(t => t.trim())
      .filter(t => t && /[\p{L}\p{N}]/u.test(t) && !STOP_WORDS.has(t));
  } catch {
    return tokenizeBigram(text); // fallback on error
  }
}

// ========== 统一入口 ==========

/**
 * 分词模式
 * @typedef {'auto'|'jieba'|'bigram'} TokenizerMode
 */

/**
 * 统一分词入口
 * @param {string} text - 输入文本
 * @param {TokenizerMode} [mode] - 分词模式，默认从环境变量 TOKENIZER_MODE 读取，auto
 * @returns {string[]} 分词结果
 */
export function tokenize(text, mode) {
  const effectiveMode = mode || process.env.TOKENIZER_MODE || 'auto';
  
  if (effectiveMode === 'bigram') return tokenizeBigram(text);
  if (effectiveMode === 'jieba') return tokenizeJieba(text);
  
  // auto: jieba可用就用jieba，否则bigram
  return tokenizeJieba(text);
}

/**
 * 检查 jieba 是否可用
 * @returns {boolean}
 */
export function isJiebaAvailable() {
  const jieba = getJieba();
  return jieba !== null;
}

/**
 * 获取当前使用的分词模式
 * @returns {string}
 */
export function getTokenizerMode() {
  const envMode = process.env.TOKENIZER_MODE;
  if (envMode === 'bigram') return 'bigram';
  if (envMode === 'jieba') return isJiebaAvailable() ? 'jieba' : 'bigram';
  return isJiebaAvailable() ? 'jieba' : 'bigram';
}

export default { tokenize, isJiebaAvailable, getTokenizerMode };
