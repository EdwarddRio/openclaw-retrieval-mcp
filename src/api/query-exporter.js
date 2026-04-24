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
  constructor(options = {}) {
    this.exportDir = options.exportDir || DEBUG_EXPORT_DIR;
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  dateDir() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  async exportSearch({ query, plan, results, timing_ms, memory_context = null }) {
    this.ensureDir();

    const staticResults = results.filter(r => r.source !== 'memory' && r.collection !== 'memory');
    const memoryResults = results.filter(r => r.source === 'memory' || r.collection === 'memory');
    const collections = [...new Set(staticResults.map(r => r.collection).filter(Boolean))];

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

  confidenceLevel(score) {
    if (score >= 0.85) return 'high';
    if (score >= 0.6) return 'medium';
    if (score >= 0.4) return 'low';
    return 'none';
  }

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
