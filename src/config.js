/**
 * context-engine 服务的集中配置：环境变量、路径、运行时目录与日志等。
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
 */

import dotenv from 'dotenv';
import pino from 'pino';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { validateConfig } from './config-schema.js';

const __filename = fileURLToPath(import.meta.url); // 当前模块文件的绝对路径
const __dirname = path.dirname(__filename); // 当前模块所在目录

// 加载 .env 文件
dotenv.config({ path: path.join(__dirname, '../config/context-engine.env') });

// Schema validation at startup
const validation = validateConfig(process.env);
if (!validation.success) {
  console.error('[config] Environment validation failed:');
  for (const err of validation.errors) {
    console.error(`  - ${err}`);
  }
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

// ========== 路径常量 ==========
export const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT || path.join(__dirname, '..', '..', 'workspace')); // 项目根目录
export const CONTEXT_ENGINE_DIR = path.join(__dirname, '..'); // context-engine 包根目录
export const RUNTIME_DIR = path.resolve(process.env.CONTEXT_ENGINE_RUNTIME_DIR || path.join(CONTEXT_ENGINE_DIR, 'runtime')); // 运行时数据目录，存放数据库、日志等

// ========== 运行时路径辅助函数 ==========
/**
 * 准备运行时路径：优先使用 runtime 目录下的路径，若不存在则从旧路径迁移
 * @param {string} relativePath - 相对于根目录的子路径
 * @param {object} [options] - 可选配置
 * @param {string} [options.baseDir] - 旧路径的基础目录，默认为 CONTEXT_ENGINE_DIR
 * @param {string} [options.runtimeDir] - 新路径的运行时目录，默认为 RUNTIME_DIR
 * @returns {string} 最终的绝对路径
 */
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
export const MANIFEST_PATH = prepareRuntimePath('index_manifest.json'); // Wiki 索引清单文件路径
export const DEBUG_EXPORT_DIR = prepareRuntimePath('debug/queries'); // 调试查询导出目录
export const DEBUG_EXPORT_ENABLED = process.env.DEBUG_EXPORT_ENABLED === '1'; // 是否启用调试导出，默认关闭，需显式开启
export const DEBUG_EXPORT_HISTORY_LIMIT = parseInt(process.env.DEBUG_EXPORT_HISTORY_LIMIT || '20', 10); // 调试导出历史记录上限
export const BENCHMARKS_DIR = prepareRuntimePath('benchmarks'); // 基准测试数据目录
export const MCP_LOG_RETENTION_DAYS = parseInt(process.env.MCP_LOG_RETENTION_DAYS || '3', 10); // MCP 日志保留天数
export const DEBUG_EXPORT_MAX_AGE_DAYS = parseInt(process.env.DEBUG_EXPORT_MAX_AGE_DAYS || '3', 10); // 调试导出文件最大保留天数
export const LOCALMEM_DIR = prepareRuntimePath('localmem'); // 本地记忆根目录，SQLite 数据库存放在此
export const LOCALMEM_SESSION_MAX_AGE_DAYS = parseInt(process.env.LOCALMEM_SESSION_MAX_AGE_DAYS || '60', 10); // 会话最大保留天数
export const LOCALMEM_FACT_MAX_AGE_DAYS = parseInt(process.env.LOCALMEM_FACT_MAX_AGE_DAYS || '180', 10); // 事实记忆最大保留天数
export const MCP_LOG_PATH = prepareRuntimePath('mcp.log'); // MCP 协议日志文件路径
export const CURSOR_PROJECTS_DIR = process.env.CURSOR_PROJECTS_DIR
  ? path.resolve(process.env.CURSOR_PROJECTS_DIR)
  : path.join(os.homedir(), '.cursor', 'projects'); // Cursor 编辑器项目目录，用于定位对话记录
export const LOCALMEM_AUTO_TRANSCRIPT_SYNC_ENABLED = process.env.LOCALMEM_AUTO_TRANSCRIPT_SYNC_ENABLED !== '0'; // 是否启用对话记录自动同步
export const LOCALMEM_AUTO_TRANSCRIPT_MAX_AGE_SECONDS = parseInt(
  process.env.LOCALMEM_AUTO_TRANSCRIPT_MAX_AGE_SECONDS || '1800',
  10
); // 自动同步的对话记录最大存活秒数
export const LOCALMEM_DAILY_WRITE_LIMIT = parseInt(
  process.env.LOCALMEM_DAILY_WRITE_LIMIT || '50',
  10
); // 自动 triage 每日写入上限
export const HTTP_SOCKET_PATH = Object.prototype.hasOwnProperty.call(process.env, 'HTTP_SOCKET_PATH')
  ? process.env.HTTP_SOCKET_PATH
  : '/tmp/openclaw-engine.sock'; // Unix Domain Socket 路径，为空时禁用

// ========== 可配置的业务参数 ==========
export const AUTOTRIAGE_RECOVERY_MS = parseInt(process.env.AUTOTRIAGE_RECOVERY_MS || '1800000', 10); // auto-triage 恢复超时（毫秒），默认 30 分钟
export const TRIAGE_MIN_CONTENT_LENGTH = parseInt(process.env.TRIAGE_MIN_CONTENT_LENGTH || '10', 10); // triage 最小内容长度
export const TRIAGE_MAX_CONTENT_LENGTH = parseInt(process.env.TRIAGE_MAX_CONTENT_LENGTH || '500', 10); // triage 最大内容长度
export const WIKI_SEARCH_CACHE_TTL_MS = parseInt(process.env.WIKI_SEARCH_CACHE_TTL_MS || '300000', 10); // Wiki 搜索缓存 TTL（毫秒），默认 5 分钟
export const LLM_SEMANTIC_COMPARE_TIMEOUT_MS = parseInt(process.env.LLM_SEMANTIC_COMPARE_TIMEOUT_MS || '10000', 10); // LLM 语义比较超时（毫秒），默认 10 秒
export const LOCALMEM_TENTATIVE_TTL_DAYS = parseInt(process.env.LOCALMEM_TENTATIVE_TTL_DAYS || '7', 10); // tentative 记忆 TTL（天数）

// ========== Pino 日志 ==========
export const LOG_DIR = prepareRuntimePath('logs');

const pinoTargets = [];
if (process.env.NODE_ENV !== 'production') {
  pinoTargets.push({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } });
} else {
  pinoTargets.push({ target: 'pino/file', options: { destination: 1 } });
}
pinoTargets.push({
  target: 'pino/file',
  options: {
    destination: path.join(LOG_DIR, `context-engine-${new Date().toISOString().slice(0, 10)}.log`),
    mkdir: true,
  },
});

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { targets: pinoTargets },
});

// ========== 部署摘要 ==========
/**
 * 构建部署摘要信息，包含当前运行时配置概况
 * @returns {object} 部署摘要对象
 */
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
export const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1'; // HTTP 服务监听地址
export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8901', 10); // HTTP 服务监听端口
export const API_SECRET = process.env.OPENCLAW_API_SECRET || ''; // HTTP API 认证密钥，为空时不校验
export const SIDE_LLM_GATEWAY_URL = process.env.SIDE_LLM_GATEWAY_URL || ''; // 侧边 LLM 网关地址（用于治理语义比较），为空时仅用词法匹配
export const SIDE_LLM_GATEWAY_MODEL = process.env.SIDE_LLM_GATEWAY_MODEL || 'k2p6'; // 侧边 LLM 网关默认模型
