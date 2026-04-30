/**
 * Wiki compiler - scans raw sources, detects changes, and provides
 * compilation instructions for the LLM agent.
 *
 * The compiler does NOT call LLM APIs directly. Instead:
 * 1. detectChanges() returns changed files with content
 * 2. Agent compiles them using its own LLM ability
 * 3. saveWikiPage() writes compiled content to wiki/
 * 4. updateIndex() refreshes wiki/index.md
 */

import fs from 'fs';
import path from 'path';
import { logger, PROJECT_ROOT } from '../config.js';
import { WikiManifest } from './manifest.js';

// LLMWiki 根目录，始终位于 workspace/LLMWiki/
const LLMWIKI_DIR = path.join(PROJECT_ROOT, 'LLMWiki');

export class WikiCompiler {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.llmwikiDir - LLMWiki 目录路径，默认为 workspace/LLMWiki
   */
  constructor(options = {}) {
    this._llmwikiDir = options.llmwikiDir || LLMWIKI_DIR; // LLMWiki 根目录
    this._rawDir = path.join(this._llmwikiDir, 'raw'); // 原始素材目录
    this._wikiDir = path.join(this._llmwikiDir, 'wiki'); // 编译输出目录
    this._schemaPath = path.join(this._llmwikiDir, 'schema.md'); // Wiki 页面 Schema
    this._sourcesPath = path.join(this._llmwikiDir, 'raw-sources.json'); // 数据源配置文件
    this._manifestPath = path.join(this._llmwikiDir, 'wiki-manifest.json');
    this._manifest = new WikiManifest(this._manifestPath);
    this._searchCache = null;
    this._searchCacheTime = 0;
    this._searchCacheTTL = 300000;
  }

  /**
   * Ensure directories exist.
   */
  ensureDirs() {
    for (const dir of [this._rawDir, this._wikiDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Load raw-sources.json and return parsed sources config.
   */
  loadSourcesConfig() {
    if (!fs.existsSync(this._sourcesPath)) {
      logger.warn('raw-sources.json not found');
      return { sources: [], compileOnStartup: false, defaultLanguage: 'zh-CN' };
    }
    return JSON.parse(fs.readFileSync(this._sourcesPath, 'utf-8'));
  }

  /**
   * Scan all raw sources and return file entries with hashes.
   * Each entry: { path, hash, sourceId, sourceType, description, size }
   */
  scanAllSources() {
    const config = this.loadSourcesConfig();
    const files = [];

    for (const source of config.sources) {
      const sourcePath = path.resolve(this._llmwikiDir, source.path);

      if (source.type === 'file') {
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
          const hash = WikiManifest.fileHash(sourcePath);
          files.push({
            path: sourcePath,
            relativePath: source.path,
            hash,
            sourceId: source.id,
            sourceType: source.type,
            description: source.description || '',
            size: fs.statSync(sourcePath).size,
            indexFile: source.indexFile || null,
          });
        }
      } else if (source.type === 'directory') {
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
          const mdFiles = this._walkMarkdown(sourcePath);
          for (const fp of mdFiles) {
            const hash = WikiManifest.fileHash(fp);
            files.push({
              path: fp,
              relativePath: path.relative(this._llmwikiDir, fp),
              hash,
              sourceId: source.id,
              sourceType: source.type,
              description: source.description || '',
              size: fs.statSync(fp).size,
              indexFile: source.indexFile || null,
            });
          }
        }
      } else if (source.type === 'external') {
        // For external sources with indexFile, scan all MD files
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
          const mdFiles = this._walkMarkdown(sourcePath);
          for (const fp of mdFiles) {
            const hash = WikiManifest.fileHash(fp);
            files.push({
              path: fp,
              relativePath: path.relative(this._llmwikiDir, fp),
              hash,
              sourceId: source.id,
              sourceType: source.type,
              description: source.description || '',
              size: fs.statSync(fp).size,
              indexFile: source.indexFile || null,
            });
          }
        }
      }
    }

    return files;
  }

  /**
   * Detect changes since last compilation.
   * Returns { added, modified, deleted, unchanged, hasChanges, changedFiles }
   * changedFiles includes file content for LLM compilation.
   */
  detectChanges() {
    this.ensureDirs();
    this._manifest.load();

    const currentFiles = this.scanAllSources();
    const changes = this._manifest.detectChanges(currentFiles);

    // Read content for changed files
    const enrichWithContent = (files) => files.map(f => ({
      ...f,
      content: fs.readFileSync(f.path, 'utf-8'),
    }));

    const added = enrichWithContent(changes.added);
    const modified = enrichWithContent(changes.modified);
    const deleted = changes.deleted;

    const changedFiles = [...added, ...modified];
    const hasChanges = changedFiles.length > 0 || deleted.length > 0;

    return {
      added,
      modified,
      deleted,
      unchanged: changes.unchanged,
      hasChanges,
      changedFiles,
      summary: {
        added: added.length,
        modified: modified.length,
        deleted: deleted.length,
        unchanged: changes.unchanged.length,
        total: currentFiles.length,
      },
    };
  }

  /**
   * Generate compilation instructions for the LLM agent.
   * Returns a structured prompt describing what needs to be compiled.
   */
  generateCompilePrompt(changesResult) {
    if (!changesResult.hasChanges) {
      return { needsCompilation: false, message: 'No changes detected. Wiki is up to date.' };
    }

    const parts = [];

    if (changesResult.changedFiles.length > 0) {
      parts.push('## Files to compile\n');
      for (const f of changesResult.changedFiles) {
        parts.push(`### Source: ${f.path}`);
        parts.push(`- Source ID: ${f.sourceId}`);
        parts.push(`- Description: ${f.description}`);
        parts.push(`- Change type: ${changesResult.added.includes(f) ? 'NEW' : 'MODIFIED'}`);
        parts.push(`- File size: ${f.size} bytes`);
        parts.push('');
        parts.push('--- CONTENT START ---');
        parts.push(f.content);
        parts.push('--- CONTENT END ---');
        parts.push('');
      }
    }

    if (changesResult.deleted.length > 0) {
      parts.push('## Files deleted (wiki pages to remove)');
      for (const d of changesResult.deleted) {
        parts.push(`- ${d.path} → wiki page: ${d.wikiPage || 'unknown'}`);
      }
      parts.push('');
    }

    // Load schema for reference
    let schemaContent = '';
    if (fs.existsSync(this._schemaPath)) {
      schemaContent = fs.readFileSync(this._schemaPath, 'utf-8');
    }

    return {
      needsCompilation: true,
      prompt: parts.join('\n'),
      schema: schemaContent,
      changedFileCount: changesResult.changedFiles.length,
      deletedCount: changesResult.deleted.length,
      existingWikiPages: this._listWikiPages(),
    };
  }

  /**
   * Save a compiled wiki page.
   * @param {Object} options
   * @param {string} options.sourcePath - Original source file path
   * @param {string} options.wikiPageName - Wiki page filename (e.g. "用户画像与偏好.md")
   * @param {string} options.content - Compiled wiki page content
   * @param {string} options.sourceId - Source ID from raw-sources.json
   */
  saveWikiPage({ sourcePath, wikiPageName, content, sourceId }) {
    const safePageName = this._normalizeWikiPageName(wikiPageName);
    const safeSourcePath = this._resolveAllowedSourcePath(sourcePath);
    const wikiFilePath = path.join(this._wikiDir, safePageName);
    const dir = path.dirname(wikiFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Preserve human-edited regions from existing file
    const mergedContent = this._mergeHumanEdits(wikiFilePath, content);
    fs.writeFileSync(wikiFilePath, mergedContent, 'utf-8');

    // Update manifest (store sourceId)
    const hash = WikiManifest.fileHash(safeSourcePath);
    this._manifest.markCompiled(safeSourcePath, hash, safePageName, sourceId || '');
    this._manifest.save();

    logger.info(`Wiki page saved: ${safePageName} (from ${safeSourcePath})`);

    this._searchCache = null;
    this._searchCacheTime = 0;

    return {
      wikiPage: safePageName,
      wikiPath: wikiFilePath,
      sourcePath: safeSourcePath,
      sourceId,
    };
  }

  /**
   * Remove a wiki page when its source is deleted.
   */
  removeWikiPage(wikiPageName) {
    const safePageName = this._normalizeWikiPageName(wikiPageName);
    const wikiFilePath = path.join(this._wikiDir, safePageName);
    if (fs.existsSync(wikiFilePath)) {
      fs.unlinkSync(wikiFilePath);
      logger.info(`Wiki page removed: ${safePageName}`);
    }

    // Clean up manifest entry for this wiki page
    this._manifest.load();
    const entries = this._manifest.allEntries;
    for (const [sourcePath, entry] of Object.entries(entries)) {
      if (entry.wikiPage === safePageName) {
        this._manifest.removeEntry(sourcePath);
        break;
      }
    }
    this._manifest.save();

    this._searchCache = null;
    this._searchCacheTime = 0;
  }

  /**
   * Update wiki/index.md with current page listing.
   * If pages array is provided, use it. Otherwise auto-derive from manifest.
   * @param {Array} pages - Array of { name, title, sourceId, lastCompiled }
   */
  updateIndex(pages = null) {
    this._manifest.load();
    const sourcePages = Array.isArray(pages) && pages.length > 0
      ? pages
      : this._listWikiPages().map(name => ({
        name,
        title: name.replace(/\.md$/, ''),
      }));

    // Auto-fill sourceId from manifest when not provided by caller
    const enrichedPages = sourcePages.map(p => {
      if (p.sourceId) return p;
      // Look up sourceId from manifest by matching wikiPage name
      const expectedName = p.name || (p.title ? p.title + '.md' : '');
      const entry = Object.values(this._manifest.allEntries)
        .find(e => e.wikiPage === expectedName);
      return {
        ...p,
        sourceId: entry?.sourceId || p.sourceId || '',
      };
    });

    const now = new Date().toISOString().split('T')[0];
    const lines = [
      '# LLM Wiki 知识库索引',
      '',
      `> 本索引由系统自动维护，记录所有已编译的 wiki 页面。`,
      `> 知识库遵循 Karpathy LLM Wiki 模式：raw → wiki 编译。`,
      `> 最后更新：${now}`,
      '',
      '---',
      '',
      '## 页面列表',
      '',
    ];

    if (enrichedPages.length === 0) {
      lines.push('> 尚无编译页面。将 raw 材料编译后在此登记。');
    } else {
      for (const p of enrichedPages) {
        const sourceLabel = p.sourceId || '未知来源';
        lines.push(`- [[${p.title}]] — 来源: ${sourceLabel} — 更新: ${p.lastCompiled || now}`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 维护记录');
    lines.push('');
    lines.push('| 日期 | 操作 | 说明 |');
    lines.push('|------|------|------|');
    lines.push(`| ${now} | 自动更新 | 检测到 ${enrichedPages.length} 个编译页面 |`);

    const indexPath = path.join(this._wikiDir, 'index.md');
    fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');

    logger.info(`Wiki index updated: ${enrichedPages.length} pages`);
    return { indexUpdated: true, pageCount: enrichedPages.length };
  }

  /**
   * Full compilation status check.
   */
  getStatus() {
    this._manifest.load();
    const entries = this._manifest.allEntries;
    const wikiPages = this._listWikiPages();

    return {
      manifestEntries: Object.keys(entries).length,
      wikiPages: wikiPages.length,
      wikiPageNames: wikiPages,
      manifestPath: this._manifestPath,
    };
  }

  /**
   * Search wiki pages by keywords (independent BM25-like scoring).
   * Does not depend on static_kb — wiki owns its search.
   * @param {string} query - Search query
   * @param {number} topK - Max results
   */
  searchWiki(query, topK = 5) {
    if (!query || !query.trim()) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pageIndex = this._getSearchIndex();
    const scored = [];

    for (const [pageName, entry] of Object.entries(pageIndex)) {
      let score = 0;
      for (const term of terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const titleCount = (entry.title.match(new RegExp(escaped, 'g')) || []).length;
        const contentCount = (entry.content.match(new RegExp(escaped, 'g')) || []).length;
        score += titleCount * 5 + contentCount;
      }

      if (score > 0) {
        scored.push({
          pageName,
          title: entry.title,
          score,
          sourceId: entry.sourceId || '',
          snippet: entry.content.slice(0, 300),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  _getSearchIndex() {
    const now = Date.now();
    if (this._searchCache && (now - this._searchCacheTime) < this._searchCacheTTL) {
      return this._searchCache;
    }

    const wikiPages = this._listWikiPages();
    this._manifest.load();
    const index = {};

    for (const pageName of wikiPages) {
      const filePath = path.join(this._wikiDir, pageName);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      const title = pageName.replace(/\.md$/, '').toLowerCase();
      const manifestEntry = Object.values(this._manifest.allEntries).find(e => e.wikiPage === pageName);
      index[pageName] = {
        content: content.toLowerCase(),
        title,
        sourceId: manifestEntry?.sourceId || '',
      };
    }

    this._searchCache = index;
    this._searchCacheTime = now;
    return index;
  }

  /**
   * Check if wiki is stale (raw sources changed since last compilation).
   * Lightweight — does not read file contents.
   */
  isStale() {
    this.ensureDirs();
    this._manifest.load();

    const currentFiles = this.scanAllSources();
    const changes = this._manifest.detectChanges(currentFiles);

    const hasChanges = changes.added.length > 0 || changes.modified.length > 0 || changes.deleted.length > 0;
    return hasChanges
      ? { stale: true, summary: { added: changes.added.length, modified: changes.modified.length, deleted: changes.deleted.length, unchanged: changes.unchanged.length, total: currentFiles.length } }
      : { stale: false, summary: { added: 0, modified: 0, deleted: 0, unchanged: changes.unchanged.length, total: currentFiles.length } };
  }

  // ========== Private helpers ==========

  _normalizeWikiPageName(wikiPageName) {
    const name = String(wikiPageName || '').trim();
    if (!name || path.isAbsolute(name) || name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('Invalid wikiPageName');
    }
    if (!name.endsWith('.md')) {
      throw new Error('wikiPageName must end with .md');
    }
    return name;
  }

  _resolveAllowedSourcePath(sourcePath) {
    const resolved = path.resolve(sourcePath || '');
    const realSource = fs.realpathSync(resolved);
    const knownFiles = this.scanAllSources();
    if (knownFiles.length === 0) return realSource;

    const allowed = knownFiles.some(file => {
      try {
        return fs.realpathSync(file.path) === realSource;
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw new Error('sourcePath is not configured in raw-sources.json');
    }
    return realSource;
  }

  /**
   * Merge human-edited regions from existing wiki file into new compiled content.
   * Human-edited regions are delimited by:
   *   <!-- human-edit-start:SECTION_NAME -->
   *   ... user content ...
   *   <!-- human-edit-end:SECTION_NAME -->
   *
   * These regions are preserved across recompilations.
   */
  _mergeHumanEdits(wikiFilePath, newContent) {
    if (!fs.existsSync(wikiFilePath)) return newContent;

    const existingContent = fs.readFileSync(wikiFilePath, 'utf-8');
    const HUMAN_START_RE = /<!--\s*human-edit-start:(\S+)\s*-->/g;
    const HUMAN_END_RE = /<!--\s*human-edit-end:(\S+)\s*-->/;

    // Extract human regions from existing file
    const humanRegions = new Map();
    let match;
    while ((match = HUMAN_START_RE.exec(existingContent)) !== null) {
      const name = match[1];
      const startIdx = match.index + match[0].length;
      const afterStart = existingContent.slice(startIdx);
      const endMatch = HUMAN_END_RE.exec(afterStart);
      if (endMatch) {
        const regionContent = afterStart.slice(0, endMatch.index);
        humanRegions.set(name, regionContent);
      }
    }

    if (humanRegions.size === 0) return newContent;

    // Replace placeholders in new content, or append at end
    let result = newContent;
    for (const [name, content] of humanRegions) {
      const placeholder = `<!-- human-edit-start:${name} -->`;
      const endTag = `<!-- human-edit-end:${name} -->`;
      const region = `${placeholder}${content}${endTag}`;

      if (result.includes(placeholder)) {
        // Replace existing placeholder in new content
        const startRe = new RegExp(
          `<!--\\s*human-edit-start:${name}\\s*-->[\\s\\S]*?<!--\\s*human-edit-end:${name}\\s*-->`
        );
        result = result.replace(startRe, region);
      } else {
        // Append at end of file
        result += '\n\n' + region;
      }
    }

    return result;
  }

  /**
   * 递归遍历目录，收集所有 .md 文件（排除 node_modules/.git 等）
   * @param {string} dir - 要遍历的目录路径
   * @returns {string[]} 找到的 Markdown 文件绝对路径列表
   */
  _walkMarkdown(dir) {
    const results = [];
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'venv', '.venv']);

    const walk = (d) => {
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            results.push(full);
          }
        }
      } catch (err) {
        logger.warn(`Failed to walk directory ${d}: ${err.message}`);
      }
    };

    walk(dir);
    return results;
  }

  /**
   * 列出 wiki 目录下所有已编译的 Markdown 页面（排除 index.md）
   * @returns {string[]} 页面文件名列表（排序后）
   */
  _listWikiPages() {
    if (!fs.existsSync(this._wikiDir)) return [];
    return fs.readdirSync(this._wikiDir)
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .sort();
  }
}

export default WikiCompiler;
