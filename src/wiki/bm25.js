/**
 * BM25Okapi search implementation for Wiki.
 * Provides improved search relevance when page count exceeds threshold.
 * Falls back to simple term frequency for smaller collections.
 */

/**
 * BM25Okapi search engine
 * @see https://en.wikipedia.org/wiki/Okapi_BM25
 */
export class BM25Search {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.k1 - Term frequency saturation parameter (default: 1.5)
   * @param {number} options.b - Document length normalization parameter (default: 0.75)
   * @param {number} options.minScore - Minimum score threshold (default: 0)
   */
  constructor(options = {}) {
    this.k1 = options.k1 || 1.5;
    this.b = options.b || 0.75;
    this.minScore = options.minScore || 0;
    
    // Index state
    this.docCount = 0;
    this.avgDocLen = 0;
    this.totalDocLen = 0;
    this.invertedIndex = new Map(); // term -> [{docId, freq, docLen}]
    this.docLengths = new Map();    // docId -> length
    this.docTitles = new Map();     // docId -> title (for title boost)
    this.docMetadata = new Map();   // docId -> metadata
  }

  /**
   * Tokenize text into terms
   * @param {string} text - Input text
   * @returns {string[]} Array of lowercase tokens
   */
  tokenize(text) {
    if (!text) return [];
    
    const tokens = [];
    // Split on whitespace and punctuation
    const parts = text.toLowerCase().split(/[^\w\u4e00-\u9fff]+/);
    
    for (const part of parts) {
      if (!part) continue;
      
      // If part contains Chinese characters, split into individual characters
      // Chinese doesn't have word boundaries, so character-level tokenization works better
      if (/[\u4e00-\u9fff]/.test(part)) {
        // Split Chinese text into bigrams for better matching
        for (let i = 0; i < part.length; i++) {
          tokens.push(part[i]); // Single character
          if (i + 1 < part.length) {
            tokens.push(part.substring(i, i + 2)); // Bigram
          }
        }
      } else {
        tokens.push(part);
      }
    }
    
    return tokens.filter(t => t.length > 0);
  }

  /**
   * Add a document to the index
   * @param {string} docId - Document identifier
   * @param {string} content - Document content
   * @param {Object} metadata - Optional metadata (title, etc.)
   */
  addDocument(docId, content, metadata = {}) {
    const tokens = this.tokenize(content);
    const docLen = tokens.length;
    
    // Store document length
    this.docLengths.set(docId, docLen);
    this.totalDocLen += docLen;
    this.docCount++;
    this.avgDocLen = this.totalDocLen / this.docCount;
    
    // Store title for boosting
    if (metadata.title) {
      this.docTitles.set(docId, metadata.title.toLowerCase());
    }
    
    // Store metadata
    this.docMetadata.set(docId, metadata);
    
    // Build inverted index
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
   * Remove a document from the index
   * @param {string} docId - Document identifier
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
    
    // Remove from inverted index
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
   * Calculate IDF (Inverse Document Frequency) for a term
   * @param {string} term - Search term
   * @returns {number} IDF score
   */
  idf(term) {
    const postings = this.invertedIndex.get(term);
    if (!postings || postings.length === 0) return 0;
    
    const n = postings.length;
    const N = this.docCount;
    
    // BM25Okapi IDF formula
    return Math.log((N - n + 0.5) / (n + 0.5) + 1);
  }

  /**
   * Calculate BM25 score for a document given query terms
   * @param {string[]} queryTerms - Tokenized query
   * @param {string} docId - Document ID
   * @returns {number} BM25 score
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
      
      // BM25Okapi TF normalization
      const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen)));
      
      score += termIdf * tfNorm;
    }
    
    return score;
  }

  /**
   * Search for documents matching query
   * @param {string} query - Search query
   * @param {number} topK - Number of results to return
   * @returns {Array} Sorted results with scores
   */
  search(query, topK = 5) {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];
    
    // Find candidate documents (union of posting lists)
    const candidates = new Set();
    for (const term of queryTerms) {
      const postings = this.invertedIndex.get(term);
      if (postings) {
        for (const posting of postings) {
          candidates.add(posting.docId);
        }
      }
    }
    
    // Score all candidates
    const scored = [];
    for (const docId of candidates) {
      let score = this.scoreDocument(queryTerms, docId);
      
      // Title boost: if query terms appear in title, boost score
      const title = this.docTitles.get(docId);
      if (title) {
        const titleMatches = queryTerms.filter(t => title.includes(t)).length;
        score *= (1 + titleMatches * 0.5); // 50% boost per title match
      }
      
      if (score > this.minScore) {
        scored.push({
          docId,
          score,
          metadata: this.docMetadata.get(docId) || {}
        });
      }
    }
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Return top K
    return scored.slice(0, topK);
  }

  /**
   * Clear the entire index
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
   * Get index statistics
   * @returns {Object} Index statistics
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

/**
 * Hybrid search that combines BM25 with simple term frequency
 * Automatically switches based on document count threshold
 */
export class HybridWikiSearch {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.bm25Threshold - Minimum docs to use BM25 (default: 200)
   * @param {Object} options.bm25Options - BM25 configuration
   */
  constructor(options = {}) {
    this.bm25Threshold = options.bm25Threshold || 200;
    this.bm25 = new BM25Search(options.bm25Options);
    this.useBM25 = false;
    this.pages = new Map(); // docId -> {content, metadata}
  }

  /**
   * Split wiki content into sections by markdown headings.
   * Each section becomes an independent search document for paragraph-level precision.
   * @param {string} content - Full page content
   * @returns {Array<{heading: string, body: string}>} Sections
   */
  _splitIntoSections(content) {
    if (!content) return [];
    const lines = content.split('\n');
    const sections = [];
    let currentHeading = '_top';
    let currentBody = [];
    
    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (headingMatch) {
        // Flush previous section
        if (currentBody.length > 0 || currentHeading !== '_top') {
          sections.push({
            heading: currentHeading,
            body: currentBody.join('\n').trim()
          });
        }
        currentHeading = headingMatch[2].trim();
        currentBody = [line];
      } else {
        currentBody.push(line);
      }
    }
    // Flush last section
    if (currentBody.length > 0) {
      sections.push({
        heading: currentHeading,
        body: currentBody.join('\n').trim()
      });
    }
    
    // If page has no headings, return entire content as one section
    if (sections.length === 0 && content.trim()) {
      sections.push({ heading: '_top', body: content.trim() });
    }
    
    // Filter out empty sections
    return sections.filter(s => s.body.length > 0);
  }

  /**
   * Add or update a page. Splits content into sections for paragraph-level search.
   * @param {string} pageName - Page name
   * @param {string} content - Page content
   * @param {Object} metadata - Page metadata
   */
  addPage(pageName, content, metadata = {}) {
    this.pages.set(pageName, { content, metadata });
    
    const sections = this._splitIntoSections(content);
    
    if (sections.length <= 1) {
      // Small page or no headings: index as single document (backward compatible)
      this.bm25.addDocument(pageName, content, { ...metadata, title: pageName });
    } else {
      // Multi-section page: index each section independently
      for (const section of sections) {
        const docId = `${pageName}::${section.heading}`;
        this.bm25.addDocument(docId, section.body, {
          ...metadata,
          title: `${pageName} > ${section.heading}`,
          sectionHeading: section.heading,
          parentPage: pageName
        });
      }
    }
    
    // Check if we should switch to BM25
    if (this.bm25.docCount >= this.bm25Threshold && !this.useBM25) {
      this.useBM25 = true;
    }
  }

  /**
   * Remove a page and all its sections
   * @param {string} pageName - Page name
   */
  removePage(pageName) {
    this.pages.delete(pageName);
    
    // Remove the page itself and all section documents (pageName::*)
    this.bm25.removeDocument(pageName);
    const toRemove = [];
    for (const docId of this.bm25.docLengths.keys()) {
      if (docId.startsWith(pageName + '::')) {
        toRemove.push(docId);
      }
    }
    for (const docId of toRemove) {
      this.bm25.removeDocument(docId);
    }
    
    // Always check mode based on current doc count
    this.useBM25 = this.bm25.docCount >= this.bm25Threshold;
  }

  /**
   * Simple term frequency search (for small collections)
   * @param {string} query - Search query
   * @param {number} topK - Number of results
   * @returns {Array} Search results
   */
  simpleSearch(query, topK = 5) {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 0);
    
    const scored = [];
    
    for (const [pageName, { content, metadata }] of this.pages) {
      const sections = this._splitIntoSections(content);
      
      if (sections.length <= 1) {
        // Single section: search as whole page
        const contentLower = content.toLowerCase();
        const titleLower = pageName.toLowerCase();
        let score = 0;
        for (const term of queryTerms) {
          if (titleLower.includes(term)) score += 5;
          const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          const matches = contentLower.match(regex);
          if (matches) score += matches.length;
        }
        if (score > 0) {
          scored.push({ docId: pageName, score, metadata: { ...metadata, content: content.slice(0, 300) } });
        }
      } else {
        // Multi-section: search each section independently
        for (const section of sections) {
          const sectionLower = section.body.toLowerCase();
          const headingLower = section.heading.toLowerCase();
          let score = 0;
          for (const term of queryTerms) {
            if (headingLower.includes(term)) score += 5;
            const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const matches = sectionLower.match(regex);
            if (matches) score += matches.length;
          }
          if (score > 0) {
            scored.push({
              docId: `${pageName}::${section.heading}`,
              score,
              metadata: { ...metadata, content: section.body.slice(0, 300), sectionHeading: section.heading, parentPage: pageName }
            });
          }
        }
      }
    }
    
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Search for pages
   * @param {string} query - Search query
   * @param {number} topK - Number of results
   * @returns {Array} Search results
   */
  search(query, topK = 5) {
    if (this.useBM25) {
      return this.bm25.search(query, topK);
    }
    return this.simpleSearch(query, topK);
  }

  /**
   * Get search mode
   * @returns {string} Current search mode
   */
  getMode() {
    return this.useBM25 ? 'bm25' : 'simple';
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  stats() {
    return {
      mode: this.getMode(),
      pageCount: this.pages.size,
      threshold: this.bm25Threshold,
      bm25Stats: this.bm25.stats()
    };
  }
}

export default { BM25Search, HybridWikiSearch };
