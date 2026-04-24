/**
 * context-engine 服务的集中配置：环境变量、路径、运行时目录与日志等。
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
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

// ========== 部署摘要 ==========
export function buildDeploymentSummary() {
  return {
    project_root: PROJECT_ROOT,
    runtime_dir: RUNTIME_DIR,
    current_profile: 'localMem+LLMWiki',
    localmem_enabled: true,
    wiki_enabled: true,
    governance_enabled: true,
    transcript_binding_enabled: true,
  };
}

// ========== HTTP 服务器配置 ==========
export const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1';
export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8901', 10);
