import fs from 'fs';
import path from 'path';
import { DEBUG_EXPORT_DIR, logger } from '../config.js';

/**
 * QueryExporter - writes debug artifacts for query-context calls.
 * Creates:
 *   - latest-query-context.json (memory context query results)
 */
export class QueryExporter {
  constructor(options = {}) {
    this.exportDir = options.exportDir || DEBUG_EXPORT_DIR;
    this.maxAgeDays = options.maxAgeDays || 3;
    this.ensureDir();
    this._cleanupOldExports();
  }

  ensureDir() {
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  _cleanupOldExports() {
    try {
      if (!fs.existsSync(this.exportDir)) return;
      const now = Date.now();
      const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;

      const entries = fs.readdirSync(this.exportDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

        const dirPath = path.join(this.exportDir, entry.name);
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      logger.warn(`[QueryExporter] Failed to cleanup old exports: ${err.message}`);
    }
  }

  dateDir() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
}

export default QueryExporter;
