/**
 * Wiki publisher - publishes memory candidates as Markdown files.
 * Aligned with Python localmem_v2/wiki_publisher.py
 */

import fs from 'fs';
import path from 'path';

const MAX_WIKI_PAGE_BYTES = 30 * 1024;

export function publishCandidate({ outputDir, slug, title, bullets }) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const target = path.join(outputDir, `${slug}.md`);
  let body = bullets.map(b => `- ${b}`).join('\n');
  let content = `# ${title}\n\n${body}\n`;
  if (Buffer.byteLength(content, 'utf-8') > MAX_WIKI_PAGE_BYTES) {
    body = body.slice(0, MAX_WIKI_PAGE_BYTES / 2) + '\n- ...(内容过长，已截断)';
    content = `# ${title}\n\n${body}\n`;
  }
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

/**
 * Publish a wiki page from full markdown content (no bullet wrapping).
 * Used when rebuilding wiki from DB or when the content is already
 * a well-formed markdown document.
 */
export function publishWikiPage({ outputDir, slug, content }) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const target = path.join(outputDir, `${slug}.md`);
  let pageContent = content;
  if (Buffer.byteLength(pageContent, 'utf-8') > MAX_WIKI_PAGE_BYTES) {
    pageContent = pageContent.slice(0, MAX_WIKI_PAGE_BYTES / 2) + '\n\n- ...(内容过长，已截断)\n';
  }
  fs.writeFileSync(target, pageContent, 'utf-8');
  return target;
}

export function rebuildWikiIndex(outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const pages = [];
  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.md') && f !== 'index.md').sort();
  for (const filename of files) {
    const filePath = path.join(outputDir, filename);
    const title = _readPageTitle(filePath);
    pages.push([filename, title]);
  }

  const target = path.join(outputDir, 'index.md');
  const body = pages.length
    ? pages.map(([filename, title]) => `- [${title}](${filename})`).join('\n')
    : '- No published wiki entries yet.';
  fs.writeFileSync(target, `# Wiki Index\n\n${body}\n`, 'utf-8');
  return target;
}

function _readPageTitle(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('# ')) {
      return line.slice(2).trim();
    }
  }
  return path.basename(filePath, '.md');
}

export function slugify(content, fallback) {
  let slug = (content || '').split('').map(ch => {
    if (/[a-zA-Z0-9\u4e00-\u9fa5]/.test(ch)) return ch.toLowerCase();
    return '-';
  }).join('').replace(/^-+|-+$/g, '');
  while (slug.includes('--')) {
    slug = slug.replace(/--/g, '-');
  }
  return slug.slice(0, 80).replace(/-+$/, '') || (fallback || 'memory').toLowerCase();
}

export default { publishCandidate, rebuildWikiIndex, slugify };
