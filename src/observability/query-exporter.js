/**
 * Query debug exporter - exports search queries for debugging.
 */

import fs from 'fs';
import path from 'path';
import { DEBUG_EXPORT_DIR, DEBUG_EXPORT_ENABLED, DEBUG_EXPORT_HISTORY_LIMIT, DEBUG_EXPORT_MAX_AGE_DAYS } from '../config.js';

export class QueryExporter {
  constructor(exportDir = DEBUG_EXPORT_DIR) {
    this.exportDir = exportDir;
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  exportQuery(query, results, context = {}) {
    if (!DEBUG_EXPORT_ENABLED) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `query_${timestamp}.json`;
    const filePath = path.join(this.exportDir, fileName);

    const payload = {
      query,
      results,
      context,
      exported_at: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    this._pruneOldExports();

    return filePath;
  }

  exportMarkdown(query, results, context = {}) {
    if (!DEBUG_EXPORT_ENABLED) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `query_${timestamp}.md`;
    const filePath = path.join(this.exportDir, fileName);

    const lines = [
      `# Query: ${query}`,
      '',
      `**Time:** ${new Date().toISOString()}`,
      '',
      '## Results',
      '',
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`### ${i + 1}. ${r.title || 'Untitled'}`);
      lines.push(`- **Source:** ${r.source}`);
      lines.push(`- **Type:** ${r.docType}`);
      lines.push('');
      lines.push('```');
      lines.push(r.content.slice(0, 500));
      if (r.content.length > 500) lines.push('...');
      lines.push('```');
      lines.push('');
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    this._pruneOldExports();

    return filePath;
  }

  _pruneOldExports() {
    try {
      const files = fs.readdirSync(this.exportDir)
        .filter(f => f.startsWith('query_'))
        .map(f => ({
          name: f,
          path: path.join(this.exportDir, f),
          mtime: fs.statSync(path.join(this.exportDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Remove old files beyond limit
      if (files.length > DEBUG_EXPORT_HISTORY_LIMIT) {
        for (const file of files.slice(DEBUG_EXPORT_HISTORY_LIMIT)) {
          fs.unlinkSync(file.path);
        }
      }

      // Remove files older than max age
      const maxAgeMs = DEBUG_EXPORT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - maxAgeMs;
      for (const file of files) {
        if (file.mtime.getTime() < cutoff) {
          fs.unlinkSync(file.path);
        }
      }
    } catch {
      // Ignore pruning errors
    }
  }
}

export default QueryExporter;
