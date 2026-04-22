/**
 * Response presenter - formats API responses consistently.
 * Uses KnowledgeBasePresenter class pattern with score normalization.
 */

import { SearchResponse, SearchResultItem, MemoryItem, MemorySearchResponse, HealthResponse, ErrorResponse } from './contract.js';

export class KnowledgeBasePresenter {
  static presentSearchResults(searchResults, options = {}) {
    const { query, top_k, timing_ms, debug } = options;

    const results = (searchResults || []).map(result => this.presentSearchResultItem(result));

    return new SearchResponse({
      query,
      top_k,
      result_count: results.length,
      results,
      timing_ms,
      debug,
    });
  }

  static presentSearchResultItem(result) {
    return new SearchResultItem({
      content: result.content,
      source: result.source,
      doc_type: result.docType,
      title: result.title,
      score: typeof result.score === 'number' ? Math.round(result.score * 10000) / 10000 : result.score,
      collection: result.collection,
      chunk_id: result.chunkId,
      matched_chunks: result.matchedChunks || 1,
      score_breakdown: result.scoreBreakdown || {},
    });
  }

  static presentMemoryItem(memory) {
    return new MemoryItem({
      memory_id: memory.memory_id,
      session_id: memory.session_id,
      content: memory.content,
      state: memory.state,
      status: memory.status,
      source: memory.source,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
      aliases: memory.aliases,
      path_hints: memory.path_hints,
      collection_hints: memory.collection_hints,
    });
  }

  static presentMemorySearchResults(searchResults, options = {}) {
    const { query, top_k } = options;
    const items = (searchResults.items || []).map(item => this.presentMemoryItem(item));

    return new MemorySearchResponse({
      query,
      top_k,
      total_matched: searchResults.total_matched || items.length,
      items,
    });
  }

  static presentHealth(options = {}) {
    return new HealthResponse({
      status: 'healthy',
      version: '1.0.0',
      ...options,
    });
  }

  static presentError(error, statusCode = 500) {
    return new ErrorResponse({
      error: error.name || 'Internal Server Error',
      message: error.message || 'An unexpected error occurred',
      code: statusCode,
    });
  }

  static presentStats(stats) {
    return {
      ...stats,
      timestamp: new Date().toISOString(),
    };
  }

  static presentSession(session) {
    return {
      session_id: session.session_id,
      project_id: session.project_id,
      started_at: session.started_at,
      updated_at: session.updated_at,
      title: session.title,
      summary: session.summary,
      status: session.status,
      turn_count: session.turn_count,
    };
  }

  static presentTurn(turn) {
    return {
      turn_id: turn.turn_id,
      session_id: turn.session_id,
      seq_no: turn.seq_no,
      role: turn.role,
      content: turn.content,
      created_at: turn.created_at,
      references: turn.references,
    };
  }

  static presentTimeline(timeline) {
    return {
      filters: timeline.filters,
      event_count: timeline.event_count,
      events: timeline.events,
    };
  }
}

export default KnowledgeBasePresenter;
