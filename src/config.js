/**
 * context-engine 服务的集中配置：环境变量、路径、运行时目录与日志等。
 */

import dotenv from 'dotenv';
import winston from 'winston';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载 .env 文件
dotenv.config({ path: path.join(__dirname, '../config/context-engine.env') });

// ========== 路径常量 ==========
export const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT || path.join(__dirname, '..'));
export const CONTEXT_ENGINE_DIR = path.join(__dirname, '..');
export const RUNTIME_DIR = path.resolve(process.env.CONTEXT_ENGINE_RUNTIME_DIR || path.join(CONTEXT_ENGINE_DIR, 'runtime'));

// ========== 运行时路径辅助函数 ==========
export function prepareRuntimePath(relativePath, { baseDir = CONTEXT_ENGINE_DIR, runtimeDir = RUNTIME_DIR } = {}) {
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }
  const targetPath = path.join(runtimeDir, relativePath);
  const legacyPath = path.join(baseDir, relativePath);

  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  if (fs.existsSync(legacyPath)) {
    try {
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.renameSync(legacyPath, targetPath);
      return targetPath;
    } catch (err) {
      if (err.code === 'EXDEV') {
        // 跨设备移动，复制后删除
        try {
          fs.cpSync(legacyPath, targetPath, { recursive: true });
          fs.rmSync(legacyPath, { recursive: true, force: true });
          return targetPath;
        } catch {
          return legacyPath;
        }
      }
      return legacyPath;
    }
  }
  return targetPath;
}

// ========== 环境变量驱动的配置 ==========
export const EMBEDDING_MODEL = process.env.CONTEXT_ENGINE_EMBEDDING_MODEL || 'BAAI/bge-small-zh-v1.5';
export const CHROMA_DIR = prepareRuntimePath('chroma_data');
export const MANIFEST_PATH = prepareRuntimePath('index_manifest.json');
export const DEBUG_EXPORT_DIR = prepareRuntimePath('debug/queries');
export const DEBUG_EXPORT_ENABLED = true;
export const DEBUG_EXPORT_HISTORY_LIMIT = parseInt(process.env.DEBUG_EXPORT_HISTORY_LIMIT || '20', 10);
export const BENCHMARKS_DIR = prepareRuntimePath('benchmarks');
export const MCP_LOG_RETENTION_DAYS = parseInt(process.env.MCP_LOG_RETENTION_DAYS || '3', 10);
export const DEBUG_EXPORT_MAX_AGE_DAYS = parseInt(process.env.DEBUG_EXPORT_MAX_AGE_DAYS || '3', 10);
export const LOCALMEM_DIR = prepareRuntimePath('localmem');
export const LOCALMEM_SESSION_MAX_AGE_DAYS = parseInt(process.env.LOCALMEM_SESSION_MAX_AGE_DAYS || '60', 10);
export const LOCALMEM_FACT_MAX_AGE_DAYS = parseInt(process.env.LOCALMEM_FACT_MAX_AGE_DAYS || '180', 10);
export const MCP_LOG_PATH = prepareRuntimePath('mcp.log');
export const CURSOR_PROJECTS_DIR = process.env.CURSOR_PROJECTS_DIR
  ? path.resolve(process.env.CURSOR_PROJECTS_DIR)
  : path.join(os.homedir(), '.cursor', 'projects');
export const LOCALMEM_AUTO_TRANSCRIPT_SYNC_ENABLED = process.env.LOCALMEM_AUTO_TRANSCRIPT_SYNC_ENABLED !== '0';
export const LOCALMEM_AUTO_TRANSCRIPT_MAX_AGE_SECONDS = parseInt(
  process.env.LOCALMEM_AUTO_TRANSCRIPT_MAX_AGE_SECONDS || '1800',
  10
);

// ========== Winston 日志 ==========
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level.toUpperCase()} ${message}`)
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// ========== 日志处理器 ==========
export function buildRetainedLogHandler(logPath, { retentionDays = 3, encoding = 'utf-8' } = {}) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return new winston.transports.File({
    filename: logPath,
    encoding,
    maxFiles: retentionDays > 0 ? retentionDays : 0,
    maxSize: '20m'
  });
}

// ========== 搜索/检索常量 ==========
export const DEFAULT_TOP_K = 5;
export const VECTOR_FETCH_K = 10;
export const BM25_FETCH_K = 10;
export const RRF_K = 60;
export const MAX_QUERY_VARIANTS = 4;
export const COLLECTION_CANDIDATE_LIMIT = 8;
export const FILE_AGGREGATION_BONUS_WEIGHT = 0.35;
export const FILE_AGGREGATION_BONUS_CAP = 0.04;

// ========== 分块与代码加载常量 ==========
export const MAX_CHUNK_SIZE = 500;
export const MIN_CHUNK_SIZE = 50;
export const CODE_LOAD_TIMEOUT_SECONDS = parseFloat(process.env.CODE_LOAD_TIMEOUT_SECONDS || '5.0');
export const CODE_LOAD_SLOW_THRESHOLD_MS = parseInt(process.env.CODE_LOAD_SLOW_THRESHOLD_MS || '500', 10);

// ========== 文件发现常量 ==========
const LEGACY_RULE_CANDIDATES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursor/rules/',
  '.cursorrules',
  'docs/',
  'mds/',
];

export const DOC_EXTENSIONS = new Set(['.md', '.mdc', '.txt']);

const NON_DOC_FILENAMES = new Set([
  'requirements.txt', 'LICENSE.txt', 'license.txt', 'NOTICE.txt',
  'MANIFEST.in', 'setup.cfg', 'Pipfile', 'Pipfile.lock', 'package-lock.json',
]);

const DOC_SCAN_DIRS = [
  'docs/', 'mds/', 'doc/', 'documents/', 'notes/', 'wiki/', '.cursor/rules/',
];

export const CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.java', '.go', '.rs', '.kt', '.scala',
  '.swift', '.cpp', '.c', '.h', '.hpp', '.cs', '.rb', '.php', '.lua', '.sh',
]);

export const CODE_EXTENSION_TO_LANG = {
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.kt': 'kotlin', '.scala': 'scala', '.swift': 'swift',
  '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.sh': 'shell',
};

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  'venv', '.venv', 'env', '.tox', 'target', '.gradle',
  'vendor', 'coverage', '.next', '.nuxt', '.cache',
  '.idea', '.vscode', 'out', 'bin', 'obj',
  '.eggs', 'runtime',
]);

export const CODE_QUERY_KEYWORDS = [
  '实现', '调用', '哪里', '方法', '类', '函数', '接口',
  'import', 'class', 'function', 'def', 'method',
  'service', 'action', 'mapper', 'impl', 'controller',
  'module', 'package', 'handler', 'middleware',
];

export const SUPPORTED_STATIC_COLLECTIONS = ['static_kb', 'rules', 'code', 'config'];

// ========== 集合配置覆盖 ==========
function collectionsOverrideFromEnv() {
  const filePath = process.env.CONTEXT_ENGINE_COLLECTIONS_FILE;
  if (filePath) {
    try {
      const expandedPath = path.resolve(filePath.replace(/^~/, process.env.USERPROFILE || process.env.HOME || os.homedir()));
      return JSON.parse(fs.readFileSync(expandedPath, 'utf-8'));
    } catch (err) {
      logger.error('Error loading collections from file:', err);
    }
  }
  const inline = process.env.CONTEXT_ENGINE_COLLECTIONS;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (err) {
      logger.error('Error parsing collections from env:', err);
    }
  }
  return null;
}

// ========== 工作空间发现 ==========
function discoverRuleSources(root) {
  const sources = new Set();

  for (const candidate of LEGACY_RULE_CANDIDATES) {
    const fullPath = path.join(root, candidate);
    if (fs.existsSync(fullPath)) {
      sources.add(candidate);
    }
  }

  for (const dir of DOC_SCAN_DIRS) {
    const fullPath = path.join(root, dir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      sources.add(dir);
    }
  }

  // 根级文档文件
  try {
    const entries = fs.readdirSync(root);
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (DOC_EXTENSIONS.has(ext) && !NON_DOC_FILENAMES.has(entry)) {
        sources.add(entry);
      }
    }
  } catch {
    // ignore
  }

  return Array.from(sources);
}

function dirHasCode(directory, maxDepth = 3) {
  function scan(dir, depth) {
    if (depth > maxDepth) return false;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          if (scan(path.join(dir, entry.name), depth + 1)) return true;
        } else if (entry.isFile()) {
          if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            return true;
          }
        }
      }
    } catch (err) {
      if (err.code !== 'EACCES') {
        // ignore permission errors silently
      }
    }
    return false;
  }
  return scan(directory, 0);
}

function discoverCodeSources(root) {
  const sources = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (dirHasCode(path.join(root, entry.name))) {
          sources.push(entry.name + '/');
        }
      } else if (entry.isFile()) {
        if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          sources.push(entry.name);
        }
      }
    }
  } catch {
    // ignore
  }
  return sources.sort();
}

export function discoverWorkspace(projectRoot) {
  const override = collectionsOverrideFromEnv();
  if (override !== null) {
    return override;
  }

  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {};
  }

  const collections = {};
  const ruleSources = discoverRuleSources(root);
  if (ruleSources.length > 0) {
    collections.static_kb = {
      sources: ruleSources,
      lazy: false,
    };
  }

  const codeSources = discoverCodeSources(root);
  if (codeSources.length > 0) {
    collections.code = {
      sources: codeSources,
      lazy: false,
    };
  }

  return collections;
}

// ========== doc_type 到 collection 的映射 ==========
export function buildDocTypeMap(collections) {
  const map = {};
  for (const [name, config] of Object.entries(collections)) {
    if (name === 'static_kb' || name === 'rules') {
      map.rule = name;
      map.design = name;
    } else if (name === 'code') {
      map.code = name;
      for (const lang of Object.values(CODE_EXTENSION_TO_LANG)) {
        map[lang] = name;
      }
    } else if (name === 'config') {
      map.config = name;
    }
  }
  return map;
}

// ========== 集合来源详情 ==========
export function collectionsSourceDetails() {
  const rawPath = (process.env.CONTEXT_ENGINE_COLLECTIONS_FILE || '').trim();
  if (rawPath) {
    return { mode: 'override_file', path: path.resolve(rawPath.replace(/^~/, process.env.USERPROFILE || process.env.HOME || os.homedir())) };
  }
  const rawJson = (process.env.CONTEXT_ENGINE_COLLECTIONS || '').trim();
  if (rawJson) {
    return { mode: 'override_inline', path: null };
  }
  return { mode: 'auto_discovery', path: null };
}

// ========== 部署摘要 ==========
export function buildDeploymentSummary(indexCollections = null) {
  const collections = indexCollections || INDEX_COLLECTIONS;
  const staticCollections = Object.keys(collections).filter(k =>
    SUPPORTED_STATIC_COLLECTIONS.includes(k)
  );
  const source = collectionsSourceDetails();

  return {
    project_root: PROJECT_ROOT,
    runtime_dir: RUNTIME_DIR,
    current_profile: staticCollections.length > 0
      ? staticCollections.join('+') + '+localMem'
      : 'localMem',
    active_static_collections: staticCollections,
    supported_static_collections: SUPPORTED_STATIC_COLLECTIONS,
    collections_source: source,
    workspace_discovery_enabled: source.mode === 'auto_discovery',
    localmem_enabled: true,
    governance_enabled: true,
    transcript_binding_enabled: true,
  };
}

// ========== HTTP 服务器配置 ==========
export const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1';
export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8901', 10);

// ========== 外部服务配置 ==========
export const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
export const EMBEDDING_URL = process.env.EMBEDDING_URL || 'http://localhost:8902';

// ========== Embedding 服务配置 ==========
export const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || 'http://127.0.0.1:8901';
export const EMBEDDING_ENDPOINT = process.env.EMBEDDING_ENDPOINT || '/api/embed';
export const EMBEDDING_MAX_RETRIES = parseInt(process.env.EMBEDDING_MAX_RETRIES || '3', 10);
export const EMBEDDING_RETRY_DELAY = parseInt(process.env.EMBEDDING_RETRY_DELAY || '1000', 10);
export const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || '50', 10);
export const EMBEDDING_TIMEOUT = parseInt(process.env.EMBEDDING_TIMEOUT || '30000', 10);

// ========== 模块级初始化 ==========
export const INDEX_COLLECTIONS = discoverWorkspace(PROJECT_ROOT);
export const DOC_TYPE_TO_COLLECTION = buildDocTypeMap(INDEX_COLLECTIONS);
