/**
 * BM25 Okapi implementation in JavaScript.
 * Based on the rank_bm25 Python library algorithm.
 */

/**
 * Tokenize text into terms.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

class BM25Okapi {
  /**
   * @param {string[]} corpus - Array of document strings.
   * @param {Object} options - BM25 parameters.
   * @param {number} options.k1 - Term frequency saturation parameter (default 1.5).
   * @param {number} options.b - Length normalization parameter (default 0.75).
   * @param {number} options.epsilon - IDF smoothing for rare terms (default 0.25).
   */
  constructor(corpus, { k1 = 1.5, b = 0.75, epsilon = 0.25 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.epsilon = epsilon;
    this.corpus = corpus.map(doc => tokenize(doc));
    this.corpusSize = this.corpus.length;
    this.avgdl = this._computeAvgdl();
    this.docFreqs = [];
    this.idf = {};
    this.docLen = [];

    this._initialize();
  }

  _computeAvgdl() {
    let totalLen = 0;
    for (const doc of this.corpus) {
      totalLen += doc.length;
    }
    return totalLen / this.corpus.length;
  }

  _initialize() {
    const nd = {}; // term -> number of documents containing term

    for (const doc of this.corpus) {
      this.docLen.push(doc.length);
      const freqs = {};
      for (const word of doc) {
        freqs[word] = (freqs[word] || 0) + 1;
      }
      this.docFreqs.push(freqs);
      for (const word of Object.keys(freqs)) {
        nd[word] = (nd[word] || 0) + 1;
      }
    }

    // Compute IDF for each term
    const idfSum = 0;
    const negativeIdfs = [];

    for (const [word, freq] of Object.entries(nd)) {
      const idf = Math.log(this.corpusSize - freq + 0.5) - Math.log(freq + 0.5);
      this.idf[word] = idf;
      idfSum += idf;
      if (idf < 0) {
        negativeIdfs.push(word);
      }
    }

    // Smooth negative IDFs
    if (negativeIdfs.length > 0) {
      const avgIdf = idfSum / Object.keys(this.idf).length;
      const eps = this.epsilon * avgIdf;
      for (const word of negativeIdfs) {
        this.idf[word] = eps;
      }
    }
  }

  /**
   * Get BM25 scores for a query against all documents.
   * @param {string} query - Query string.
   * @returns {number[]} - Array of scores (one per document).
   */
  getScores(query) {
    const queryTerms = tokenize(query);
    const scores = new Array(this.corpusSize).fill(0);

    for (let i = 0; i < this.corpusSize; i++) {
      const docFreqs = this.docFreqs[i];
      const docLen = this.docLen[i];
      let score = 0;

      for (const term of queryTerms) {
        if (!docFreqs[term]) continue;
        const idf = this.idf[term] || 0;
        const freq = docFreqs[term];
        const numerator = freq * (this.k1 + 1);
        const denominator = freq + this.k1 * (1 - this.b + this.b * docLen / this.avgdl);
        score += idf * numerator / denominator;
      }

      scores[i] = score;
    }

    return scores;
  }

  /**
   * Get top-k documents for a query.
   * @param {string} query - Query string.
   * @param {number} k - Number of top results.
   * @returns {Array<{index: number, score: number}>}
   */
  getTopK(query, k = 10) {
    const scores = this.getScores(query);
    const indexed = scores.map((score, index) => ({ index, score }));
    indexed.sort((a, b) => b.score - a.score);
    return indexed.slice(0, k);
  }

  /**
   * Serialize the index to a plain object.
   * @returns {Object}
   */
  toJSON() {
    return {
      k1: this.k1,
      b: this.b,
      epsilon: this.epsilon,
      corpus: this.corpus,
      corpusSize: this.corpusSize,
      avgdl: this.avgdl,
      docFreqs: this.docFreqs,
      idf: this.idf,
      docLen: this.docLen,
    };
  }

  /**
   * Restore the index from a plain object.
   * @param {Object} data
   * @returns {BM25Okapi}
   */
  static fromJSON(data) {
    const instance = Object.create(BM25Okapi.prototype);
    instance.k1 = data.k1;
    instance.b = data.b;
    instance.epsilon = data.epsilon;
    instance.corpus = data.corpus;
    instance.corpusSize = data.corpusSize;
    instance.avgdl = data.avgdl;
    instance.docFreqs = data.docFreqs;
    instance.idf = data.idf;
    instance.docLen = data.docLen;
    return instance;
  }
}

export { BM25Okapi, tokenize };
export default BM25Okapi;
