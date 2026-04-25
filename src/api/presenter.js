/**
 * Response presenter - formats API responses consistently.
 * Uses KnowledgeBasePresenter class pattern with score normalization.
 */

import { SearchResponse, SearchResultItem, MemoryItem, MemorySearchResponse, HealthResponse, ErrorResponse } from './contract.js';

export class KnowledgeBasePresenter {
/**
 * 格式化搜索结果列表为标准响应
 * @param {Array} searchResults - 原始搜索结果数组
 * @param {Object} options - 附加选项（query, top_k, timing_ms, debug）
 * @returns {SearchResponse} 格式化后的搜索响应
 */
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

  /**
   * 格式化单条搜索结果，分数保留四位小数
   * @param {Object} result - 原始搜索结果
   * @returns {SearchResultItem}
   */
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

  /**
   * 格式化单条记忆条目
   * @param {Object} memory - 原始记忆数据
   * @returns {MemoryItem}
   */
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

  /**
   * 格式化记忆搜索结果列表
   * @param {Object} searchResults - 包含 items 和 total_matched 的搜索结果
   * @param {Object} options - 附加选项（query, top_k）
   * @returns {MemorySearchResponse}
   */
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

  /**
   * 格式化健康检查响应
   * @param {Object} options - 可覆盖的字段
   * @returns {HealthResponse}
   */
  static presentHealth(options = {}) {
    return new HealthResponse({
      status: 'healthy',
      version: '1.0.0',
      ...options,
    });
  }

  /**
   * 格式化错误响应
   * @param {Error} error - 错误对象
   * @param {number} statusCode - HTTP 状态码
   * @returns {ErrorResponse}
   */
  static presentError(error, statusCode = 500) {
    return new ErrorResponse({
      error: error.name || 'Internal Server Error',
      message: error.message || 'An unexpected error occurred',
      code: statusCode,
    });
  }

  /**
   * 格式化统计信息，附加当前时间戳
   * @param {Object} stats - 统计数据
   * @returns {Object} 含 timestamp 的统计对象
   */
  static presentStats(stats) {
    return {
      ...stats,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 格式化会话信息
   * @param {Object} session - 会话数据
   * @returns {Object} 格式化后的会话对象
   */
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

  /**
   * 格式化会话轮次
   * @param {Object} turn - 轮次数据
   * @returns {Object} 格式化后的轮次对象
   */
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

  /**
   * 格式化时间线数据
   * @param {Object} timeline - 时间线数据
   * @returns {Object} 格式化后的事件时间线
   */
  static presentTimeline(timeline) {
    return {
      filters: timeline.filters,
      event_count: timeline.event_count,
      events: timeline.events,
    };
  }
}

export default KnowledgeBasePresenter;
