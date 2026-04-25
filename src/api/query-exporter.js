import fs from 'fs';
import path from 'path';
import { DEBUG_EXPORT_DIR } from '../config.js';

/**
 * QueryExporter - writes debug artifacts for search and query-context calls.
 * Creates:
 *   - latest.json (search results + summary)
 *   - latest.md (human-readable markdown)
 *   - latest-query-context.json (memory context query results)
 */
export class QueryExporter {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.exportDir - 导出目录路径，默认使用 DEBUG_EXPORT_DIR
   */
  constructor(options = {}) {
    this.exportDir = options.exportDir || DEBUG_EXPORT_DIR;
    this.ensureDir();
  }

  /** 确保导出目录存在 */
  ensureDir() {
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  /** 返回当前日期字符串，格式 YYYY-MM-DD，用于按日期归档 */
  dateDir() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * 导出搜索调试信息到 JSON 和 Markdown 文件
   * @param {Object} params - 导出参数
   * @param {string} params.query - 搜索查询文本
   * @param {Object} params.plan - 搜索执行计划
   * @param {Array} params.results - 搜索结果列表
   * @param {number} params.timing_ms - 搜索耗时（毫秒）
   * @param {Object|null} params.memory_context - 记忆上下文（可选）
   */
  async exportSearch({ query, plan, results, timing_ms, memory_context = null }) {
    this.ensureDir();

    const staticResults = results.filter(r => r.source !== 'memory' && r.collection !== 'memory'); // 非记忆的静态结果
    const memoryResults = results.filter(r => r.source === 'memory' || r.collection === 'memory'); // 记忆来源的结果
    const collections = [...new Set(staticResults.map(r => r.collection).filter(Boolean))]; // 去重后的集合名列表

    const payload = {
      query,
      summary: {
        response_mode: memoryResults.length > 0 ? 'memory_enhanced' : (staticResults.length > 0 ? 'static_only' : 'empty'),
        static_result_count: staticResults.length,
        final_result_count: results.length,
        memory_hit_count: memoryResults.length,
        collections_with_results: collections,
      },
      session_context: {
        binding_mode: null,
        transcript_imported: null,
      },
      plan,
      results: results.slice(0, 10),
      timing_ms,
      timestamp: new Date().toISOString(),
    };

    const jsonPath = path.join(this.exportDir, 'latest.json');
    const mdPath = path.join(this.exportDir, 'latest.md');
    const dateDir = this.dateDir();
    const datedDir = path.join(this.exportDir, dateDir);
    if (!fs.existsSync(datedDir)) fs.mkdirSync(datedDir, { recursive: true });
    const datedJson = path.join(datedDir, `${Date.now()}.json`);

    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.writeFileSync(datedJson, JSON.stringify(payload, null, 2), 'utf-8');

    const mdContent = this.buildMarkdown(payload);
    fs.writeFileSync(mdPath, mdContent, 'utf-8');
  }

  /**
   * 导出查询上下文调试信息
   * @param {Object} params - 导出参数
   * @param {string} params.query - 查询文本
   * @param {Object} params.result - 查询上下文结果
   */
  async exportQueryContext({ query, result }) {
    this.ensureDir();

    const matchedSessions = result.matched_sessions || [];
    const matchedTurns = result.matched_turns || [];
    const hits = result.hits || [];
    const summary = result.summary || '';
    const confidence = result.confidence ?? 0;

    const payload = {
      query,
      matched_session_count: matchedSessions.length,
      matched_turn_count: matchedTurns.length,
      summary,
      confidence,
      confidence_level: this.confidenceLevel(confidence),
      should_abstain: result.should_abstain ?? (confidence < 0.5),
      abstain_reason: result.abstain_reason || '',
      freshness_level: result.freshness_level || 'fresh',
      collection_hints: result.collection_hints || [],
      hits: hits.slice(0, 5),
      timestamp: new Date().toISOString(),
    };

    const jsonPath = path.join(this.exportDir, 'latest-query-context.json');
    const dateDir = this.dateDir();
    const datedDir = path.join(this.exportDir, dateDir);
    if (!fs.existsSync(datedDir)) fs.mkdirSync(datedDir, { recursive: true });
    const datedJson = path.join(datedDir, `${Date.now()}-query-context.json`);

    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.writeFileSync(datedJson, JSON.stringify(payload, null, 2), 'utf-8');
  }

  /**
   * 根据置信度分数返回等级标签
   * @param {number} score - 置信度分数 (0-1)
   * @returns {string} 置信度等级（high/medium/low/none）
   */
  confidenceLevel(score) {
    if (score >= 0.85) return 'high';
    if (score >= 0.6) return 'medium';
    if (score >= 0.4) return 'low';
    return 'none';
  }

  /**
   * 将搜索结果 payload 渲染为可读的 Markdown 文本
   * @param {Object} payload - 搜索导出数据
   * @returns {string} Markdown 格式的调试报告
   */
  buildMarkdown(payload) {
    const lines = [
      `# Query Debug Export`,
      ``,
      `**query:** ${payload.query}`,
      ``,
      `**timestamp:** ${payload.timestamp}`,
      ``,
      `## Summary`,
      ``,
      `- response_mode: ${payload.summary.response_mode}`,
      `- static_result_count: ${payload.summary.static_result_count}`,
      `- final_result_count: ${payload.summary.final_result_count}`,
      `- memory_hit_count: ${payload.summary.memory_hit_count}`,
      `- collections_with_results: ${(payload.summary.collections_with_results || []).join(', ') || 'none'}`,
      ``,
      `## Results (${payload.results.length})`,
      ``,
    ];

    for (const r of payload.results) {
      const title = r.title || r.collection || 'untitled';
      lines.push(`### ${title}`);
      lines.push(`- score: ${r.score ?? 'N/A'}`);
      lines.push(`- source: ${r.source || r.collection || 'unknown'}`);
      lines.push(`- content: ${(r.content || '').substring(0, 200)}`);
      lines.push('');
    }

    lines.push(`## Timing`);
    lines.push(`- ${payload.timing_ms}ms`);
    lines.push('');

    return lines.join('\n');
  }
}

export default QueryExporter;
