# OpenClaw Context Engine (JS) — Agent Guide

> 中间层 HTTP 服务，为 Workspace 提供记忆（localMem）和知识（LLMWiki）能力。

## 架构

```
┌─────────────────────────────────────────┐
│  Workspace / Scripts / Agents           │
│  ├── check-context-engine.sh            │
│  ├── digest-turns-to-markdown.js        │
│  └── cron jobs                          │
└──────────┬──────────────────┬───────────┘
           │ HTTP 8901        │ Unix Socket
           ▼                  ▼
┌─────────────────────────────────────────┐
│  openclaw-engine-js                     │
│  ├── src/routes/       (API 端点)       │
│  ├── src/middleware/   (CORS/限流/错误) │
│  ├── src/facades/      (Memory/Health)  │
│  ├── src/memory/       (SQLite + 治理)  │
│  ├── src/wiki/         (BM25 + 编译器)  │
│  └── src/api/          (契约/校验)      │
└─────────────────────────────────────────┘
           │
           ▼ SQLite
┌─────────────────────────────────────────┐
│  runtime/localmem/context-engine.db     │
│  runtime/localmem/index_manifest.json   │
│  workspace/LLMWiki/wiki/                │
└─────────────────────────────────────────┘
```

## 关键路径

1. **记忆查询**: `POST /api/memory/query` → `memoryRoutes` → `MemoryFacade.queryMemory` → `LocalMemoryStore.queryMemoryFull` → `SqliteStore`
2. **对话写入**: `POST /api/memory/turn` → `memoryRoutes` → `MemoryFacade.appendSessionTurn` → `LocalMemoryStore.appendTurn` → 异步 `autoTriageTurn`
3. **Wiki 搜索**: `POST /api/wiki/search` → `wikiRoutes` → `KnowledgeBase.wikiSearch` → `WikiCompiler` / `HybridWikiSearch`
4. **健康检查**: `GET /api/health` → `healthRoutes` → `HealthFacade.healthSnapshot`

## Red Lines

### 1. 不可破坏 API 契约
- Workspace 直接调用了 14 个端点，任何响应格式变更都会导致脚本解析失败
- 错误响应必须保持 `{ success: false, error: string, message: string, code: number }` 结构

### 2. 不可穿透 Facade 访问 `_store`
- 路由层 / 中间件禁止直接访问 `knowledgeBase?.memoryFacade?.localMemory?._store`
- 所有存储操作必须通过 Facade 公共方法

### 3. 不可丢失 autoTriage 熔断状态
- `autoTriageDisabled` 和 `autoTriageDisabledAt` 必须持久化到 `memory_events` 表
- 服务重启时必须从数据库恢复状态

### 4. 不可在测试中使用共享数据库
- 每个测试文件必须使用独立的临时目录
- `beforeEach` 创建目录，`afterEach` 调用 `memory.close()` 并删除目录

### 5. 不可泄漏定时器
- `LocalMemoryStore` 构造函数中的 `setTimeout/setInterval` 必须在 `close()` 中清除
- 新增定时器时务必保存引用并在 `close()` 中清理

## 故障诊断

| 现象 | 排查方向 | 命令 |
|------|---------|------|
| `npm test` 有失败 | 检查 `pino-pretty` / `rate-limiter-flexible` / `winston` 是否安装 | `npm install` |
| `Periodic cleanup failed` | 检查 `close()` 是否清除了 `_cleanupTimeout` | 查看 `src/memory/local-memory.js` |
| Daily Write Limit 测试失败 | 检查测试是否使用独立数据库目录 | 查看 `tests/memory-*.test.js` |
| 服务启动 401 | 检查 `OPENCLAW_API_SECRET` 环境变量 | `cat config/context-engine.env` |
| 内存 RSS >100MB | 观察 `heapUsed` 是否同步增长；如仅 RSS 增长可能是 SQLite / V8 行为 | `curl /metrics` |

## 测试

```bash
# 全量测试
npm test

# 单文件测试
node --test tests/memory-edge-cases.test.js

# 带环境变量测试
API_SECRET=test node --test tests/integration.test.js
```

## 回滚

```bash
# 快速回滚到重构前
git checkout v1.1.0-pre-refactor
npm install --package-lock-only
systemctl --user restart openclaw-context-engine.service
```
