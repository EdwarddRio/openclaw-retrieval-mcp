/**
 * 批量导入 workspace/*.md 到 localmem
 * 用法: node scripts/bulk-import-knowledge.js
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ENGINE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_DIR = path.resolve(process.env.PROJECT_ROOT || path.join(ENGINE_ROOT, '..', 'workspace'));
const DB_PATH = path.resolve(
  process.env.CONTEXT_ENGINE_DB_PATH || path.join(ENGINE_ROOT, 'runtime', 'localmem', 'context-engine.db')
);

const FILES_TO_IMPORT = [
  'MEMORY.md',
  'SOUL.md',
  'AGENTS.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
];

function normalizeText(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalKeyForText(text) {
  return crypto.createHash('sha1').update(normalizeText(text)).digest('hex');
}

function splitByHeadings(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = { title: '', lines: [] };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current.lines.length > 0) {
        sections.push({ title: current.title, body: current.lines.join('\n').trim() });
      }
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) {
    sections.push({ title: current.title, body: current.lines.join('\n').trim() });
  }
  return sections;
}

function isoNow() {
  return new Date().toISOString();
}

const db = new Database(DB_PATH);

// 检查是否已有 bulk_import 记录，避免重复导入
const existingCount = db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE source = 'bulk_import'").get();
if (existingCount.c > 0) {
  console.log(`Found ${existingCount.c} existing bulk_import records. Skipping to avoid duplicates.`);
  console.log('If you want to re-import, run: DELETE FROM memory_items WHERE source = "bulk_import";');
  db.close();
  process.exit(0);
}

const insertStmt = db.prepare(`
  INSERT INTO memory_items
  (id, canonical_key, summary, state, status, source, content, session_id, created_at, updated_at, aliases_json, path_hints_json, collection_hints_json, last_choice)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let total = 0;
let skipped = 0;

for (const file of FILES_TO_IMPORT) {
  const filePath = path.join(WORKSPACE_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`Skip missing file: ${file}`);
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const sections = splitByHeadings(content);

  for (const section of sections) {
    const body = section.body;
    if (!body || body.length < 10) {
      skipped++;
      continue;
    }

    const canonicalKey = canonicalKeyForText(body);
    // 去重：检查 canonical_key 是否已存在
    const dup = db.prepare('SELECT id FROM memory_items WHERE canonical_key = ?').get(canonicalKey);
    if (dup) {
      console.log(`  Dup(skip): ${section.title || file}`);
      skipped++;
      continue;
    }

    const memoryId = `bulk-import-${crypto.randomBytes(4).toString('hex')}`;
    const now = isoNow();
    const summary = section.title || file.replace('.md', '');

    insertStmt.run(
      memoryId,
      canonicalKey,
      summary,
      'kept',
      'active',
      'bulk_import',
      body,
      null,
      now,
      now,
      '[]',
      JSON.stringify([file]),
      '[]',
      null
    );

    total++;
    console.log(`  Imported: [${file}] ${summary.slice(0, 50)}`);
  }
}

db.close();
console.log(`\nDone: imported=${total}, skipped=${skipped}`);
