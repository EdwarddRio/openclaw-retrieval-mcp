/**
 * 通用 BM25Okapi 搜索引擎
 * 支持 tokenizer 注入，Wiki 和 Memory 共用
 * @see https://en.wikipedia.org/wiki/Okapi_BM25
 */

import { tokenize as defaultTokenize } from './tokenizer.js';

/**
 * BM25Okapi 搜索引擎
 */
export class BM25Search {
  /**
   * @param {Object} options - 配置选项
   * @param {number} options.k1 - 词频饱和参数 (default: 1.5)
   * @param {number} options.b - 文档长度归一化参数 (default: 0.75)
   * @param {number} options.minScore - 最小分数阈值 (default: 0)
   * @param {Function} options.tokenize - 自定义分词函数 (default: 使用 tokenizer.js)
   */
  constructor(options = {}) {
    this.k1 = options.k1 || 1.5;
    this.b = options.b || 0.75;
    this.minScore = options.minScore || 0;
    this._tokenize = options.tokenize || defaultTokenize;
    
    // 索引状态
    this.docCount = 0;
    this.avgDocLen = 0;
    this.totalDocLen = 0;
    this.invertedIndex = new Map(); // term -> [{docId, freq, docLen}]
    this.docLengths = new Map();    // docId -> length
    this.docTitles = new Map();     // docId -> title (for title boost)
    this.docMetadata = new Map();   // docId -> metadata
  }

  /**
   * 分词
   * @param {string} text - 输入文本
   * @returns {string[]} 分词结果
   */
  tokenize(text) {
    return this._tokenize(text);
  }

  /**
   * 添加文档到索引
   * @param {string} docId - 文档标识
   * @param {string} content - 文档内容
   * @param {Object} metadata - 可选元数据 (title, etc.)
   */
  addDocument(docId, content, metadata = {}) {
    const tokens = this.tokenize(content);
    const docLen = tokens.length;
    
    // 存储文档长度
    this.docLengths.set(docId, docLen);
    this.totalDocLen += docLen;
    this.docCount++;
    this.avgDocLen = this.totalDocLen / this.docCount;
    
    // 存储 title 用于 boost
    if (metadata.title) {
      this.docTitles.set(docId, metadata.title.toLowerCase());
    }
    
    // 存储元数据
    this.docMetadata.set(docId, metadata);
    
    // 构建倒排索引
    const termFreq = new Map();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }
    
    for (const [term, freq] of termFreq) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, []);
      }
      this.invertedIndex.get(term).push({
        docId,
        freq,
        docLen
      });
    }
  }

  /**
   * 从索引中删除文档
   * @param {string} docId - 文档标识
   */
  removeDocument(docId) {
    const docLen = this.docLengths.get(docId);
    if (docLen === undefined) return;
    
    this.totalDocLen -= docLen;
    this.docCount--;
    this.avgDocLen = this.docCount > 0 ? this.totalDocLen / this.docCount : 0;
    
    this.docLengths.delete(docId);
    this.docTitles.delete(docId);
    this.docMetadata.delete(docId);
    
    // 从倒排索引中删除
    for (const [term, postings] of this.invertedIndex) {
      const filtered = postings.filter(p => p.docId !== docId);
      if (filtered.length === 0) {
        this.invertedIndex.delete(term);
      } else {
        this.invertedIndex.set(term, filtered);
      }
    }
  }

  /**
   * 计算 IDF (Inverse Document Frequency)
   * @param {string} term - 搜索词
   * @returns {number} IDF 分数
   */
  idf(term) {
    const postings = this.invertedIndex.get(term);
    if (!postings || postings.length === 0) return 0;
    
    const n = postings.length;
    const N = this.docCount;
    
    // BM25Okapi IDF 公式
    return Math.log((N - n + 0.5) / (n + 0.5) + 1);
  }

  /**
   * 计算文档的 BM25 分数
   * @param {string[]} queryTerms - 分词后的查询
   * @param {string} docId - 文档 ID
   * @returns {number} BM25 分数
   */
  scoreDocument(queryTerms, docId) {
    const docLen = this.docLengths.get(docId) || 0;
    let score = 0;
    
    for (const term of queryTerms) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;
      
      const posting = postings.find(p => p.docId === docId);
      if (!posting) continue;
      
      const tf = posting.freq;
      const termIdf = this.idf(term);
      
      // BM25Okapi TF 归一化
      const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen)));
      
      score += termIdf * tfNorm;
    }
    
    return score;
  }

  /**
   * 搜索文档
   * @param {string} query - 搜索查询
   * @param {number} topK - 返回结果数量
   * @returns {Array} 排序后的结果（含分数）
   */
  search(query, topK = 5) {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];
    
    // 找出候选文档（posting lists 的并集）
    const candidates = new Set();
    for (const term of queryTerms) {
      const postings = this.invertedIndex.get(term);
      if (postings) {
        for (const posting of postings) {
          candidates.add(posting.docId);
        }
      }
    }
    
    // 计算所有候选文档的分数
    const scored = [];
    for (const docId of candidates) {
      let score = this.scoreDocument(queryTerms, docId);
      
      // Title boost: 如果查询词出现在标题中，提升分数
      const title = this.docTitles.get(docId);
      if (title) {
        const titleMatches = queryTerms.filter(t => title.includes(t)).length;
        score *= (1 + titleMatches * 0.5); // 每个标题匹配提升 50%
      }
      
      if (score > this.minScore) {
        scored.push({
          docId,
          score,
          metadata: this.docMetadata.get(docId) || {}
        });
      }
    }
    
    // 按分数降序排序
    scored.sort((a, b) => b.score - a.score);
    
    // 返回 top K
    return scored.slice(0, topK);
  }

  /**
   * 清空索引
   */
  clear() {
    this.invertedIndex.clear();
    this.docLengths.clear();
    this.docTitles.clear();
    this.docMetadata.clear();
    this.docCount = 0;
    this.totalDocLen = 0;
    this.avgDocLen = 0;
  }

  /**
   * 获取索引统计
   * @returns {Object} 索引统计信息
   */
  stats() {
    return {
      docCount: this.docCount,
      avgDocLen: Math.round(this.avgDocLen * 100) / 100,
      uniqueTerms: this.invertedIndex.size,
      memoryEstimateKB: Math.round(
        (this.invertedIndex.size * 50 + this.docCount * 100) / 1024
      )
    };
  }
}

export default BM25Search;
