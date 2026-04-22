/**
 * Base Chunk data model used throughout the indexing pipeline.
 * All properties use camelCase naming convention.
 */

export class Chunk {
  constructor({
    content,
    sourceFile,
    docType,
    title,
    chunkId = '',
    collection = '',
    language = '',
    symbols = [],
    headingPath = '',
    tags = [],
  } = {}) {
    this.content = content || '';
    this.sourceFile = sourceFile || '';
    this.docType = docType || '';
    this.title = title || '';
    this.chunkId = chunkId || '';
    this.collection = collection || '';
    this.language = language || '';
    this.symbols = symbols || [];
    this.headingPath = headingPath || '';
    this.tags = tags || [];
  }

  toJSON() {
    return {
      content: this.content,
      sourceFile: this.sourceFile,
      docType: this.docType,
      title: this.title,
      chunkId: this.chunkId,
      collection: this.collection,
      language: this.language,
      symbols: this.symbols,
      headingPath: this.headingPath,
      tags: this.tags,
    };
  }

  static fromJSON(data) {
    return new Chunk(data);
  }

  static from({ content, sourceFile, docType, title, options = {} }) {
    return new Chunk({
      content,
      sourceFile,
      docType,
      title,
      chunkId: options.chunkId || '',
      collection: options.collection || '',
      language: options.language || '',
      symbols: options.symbols || [],
      headingPath: options.headingPath || '',
      tags: options.tags || [],
    });
  }
}

export default Chunk;
