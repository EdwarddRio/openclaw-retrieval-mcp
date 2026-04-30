# OpenClaw Context Engine JS

> OpenClaw 的上下文引擎中间层——为 AI Agent 提供持久记忆和结构化知识检索。
> 单进程、零外部依赖、~50MB 内存。

## 项目定位

一句话：**localMem（记忆）+ LLM Wiki（知识）双引擎**，替代旧架构的 ChromaDB + Embedding + BM25 三服务。

```
┌─────────────────────────────────────────────────┐
│              OpenClaw 主程序 (Agent)              │
│         wiki_search / memory_save / ...          │
└────────────────┬────────────────────────────────┘
                 │ HTTP (8901) / Unix Socket
┌────────────────▼────────────────────────────────┐
│           Context Engine (本项目)                 │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │   localMem   │  │       LLM Wiki           │ │
│  │  记忆引擎    │  │     知识编译引擎          │ │
│  │  ──────────  │  │  ──────────────────      │ │
│  │  SQLite DB   │  │  Markdown 文件            │ │
│  │  2-state     │  │  增量编译                 │ │
│  │  治理/去重   │  │  人工编辑保护             │ │
│  └──────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## 核心功能

### 1. 知识搜索 (`/api/wiki/*`)

LLM Wiki 模式：把原始材料编译为结构化 Markdown 页面，Agent 搜索时返回整页而非分块。

- **增量编译**：只编译有变化的源文件（SHA256 对比）
- **人工编辑保护**：`<!-- human-edit-start -->` 区域不会被编译覆盖
- **搜索缓存**：5 分钟 TTL，写入时主动失效
- **中文 bigram 扩展**：精确匹配不足时自动拆分双字组合放宽搜索

### 2. 记忆系统 (`/api/memory/*`)

2-state 模型：`tentative`（临时）→ `kept`（永久），丢弃即硬删除。

- **三层过滤**：否定检测 → 敏感过滤 → 噪声过滤
- **Canonical Key 去重**：SHA1 规范化文本，相同语义只存一份
- **日写入限流**：自动来源每天最多 50 条
- **治理系统**：四维重叠检测 + 四种策略（保留/替代/冲突/新建）
- **检索洞察注入**：查询记忆时自动注入 `[检索洞察]` 到会话
- **Auto-Triage 保护**：连续 5 次失败后暂停，30 分钟自动恢复，重启后从 DB 恢复状态（精确 `disabled_at` 时间戳）
- **隐性偏好提取**：自动识别用户偏好、决策信号，支持中文关键词动态提取
- **上下文感知**：`/api/memory/turn` 接受 `previous_content`，确保"记住这个"等指代型请求能正确提取上文

### 3. 健康监控 (`/api/health`)

- `/api/health`：服务状态 + 记忆统计 + Wiki 统计
- `/api/health/ready`：就绪检查（SQLite 可连接即 ready）
- `/metrics`：请求计数、内存占用、autoTriage 状态

### 4. 基准测试 (`/api/benchmarks/*`)

自建搜索质量测试框架：命中率、召回率、Jaccard 多样性。

## API 端点清单

### Wiki

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/wiki/search` | 搜索 wiki 页面 |
| GET | `/api/wiki/check-stale` | 检查是否有源文件变化 |
| GET | `/api/wiki/status` | Wiki 编译状态 |
| POST | `/api/wiki/detect-changes` | 检测源文件变化详情 |
| POST | `/api/wiki/compile-prompt` | 生成编译提示 |
| POST | `/api/wiki/save-page` | 保存 wiki 页面 |
| POST | `/api/wiki/remove-page` | 删除 wiki 页面 |
| POST | `/api/wiki/update-index` | 更新 wiki 索引 |

### 记忆

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/query` | 查询记忆（多 token AND） |
| POST | `/api/memory/query-context` | 查询记忆上下文（含检索洞察注入） |
| GET | `/api/memory/timeline` | 记忆时间线 |
| POST | `/api/memory/turn` | 提交对话轮次（触发 autoTriage，支持 previous_content） |
| POST | `/api/memory/auto-triage` | 手动触发 autoTriage |
| POST | `/api/memory/auto-triage/batch` | 批量 autoTriage |
| POST | `/api/memory/session/start` | 开始记忆会话 |
| POST | `/api/memory/session/reset` | 重置会话 |
| POST | `/api/memory/session/import-transcript` | 导入对话记录 |
| POST | `/api/memory/save` | 保存记忆 |
| GET | `/api/memory/:id` | 获取单条记忆 |
| PUT | `/api/memory/:id` | 更新记忆 |
| DELETE | `/api/memory/:id` | 删除记忆 |
| POST | `/api/memory/governance/plan-update` | 治理策略规划 |
| GET | `/api/memory/reviews` | 获取待审核记忆 |
| POST | `/api/memory/reviews/:id/evaluate` | 评估待审核记忆 |
| POST | `/api/memory/reviews/:id/promote` | 确认记忆（tentative → kept） |
| POST | `/api/memory/reviews/:id/discard` | 丢弃记忆 |

### 健康 / 基准测试

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康状态 |
| GET | `/api/health/ready` | 就绪检查 |
| GET | `/metrics` | 运行指标 |
| POST | `/api/benchmarks/record` | 记录基准测试结果 |
| GET | `/api/benchmarks/latest` | 获取最新基准测试结果 |
| GET | `/api/benchmarks/history` | 获取基准测试历史 |
| POST | `/api/benchmarks/run` | 运行基准测试 |

### Legacy Bridge（兼容 rule-engine-bridge）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/choice` | 保存记忆取舍决策 |
| POST | `/api/memory/review` | Review 通用入口（promote/keep/discard） |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/rebuild` | 重建知识库 |

## 项目结构

```
src/
├── index.js              # Fastify 入口：路由定义 + 服务器启动 + Unix Socket 代理
├── config.js             # 环境变量 + 日志配置 + prepareRuntimePath 迁移
├── knowledge-base.js     # KnowledgeBase 门面：协调 localMem + LLM Wiki
│
├── memory/
│   ├── models.js         # 数据模型：MemoryItem, Session, Turn 等
│   ├── local-memory.js   # 记忆引擎：三层过滤 + 去重 + 查询 + 检索洞察注入
│   ├── sqlite-store.js   # SQLite 持久层：WAL + Prepared Statement 缓存 + 迁移
│   └── governance.js     # 治理系统：四维重叠检测 + 策略规划 + LLM 语义比较
│
├── wiki/
│   ├── compiler.js       # Wiki 编译器：增量编译 + 人工编辑保护 + 搜索缓存
│   └── manifest.js       # Manifest 管理：源文件 SHA256 跟踪
│
├── api/
│   ├── contract.js       # 请求模型 + validate() 方法
│   ├── presenter.js      # 响应格式化
│   └── query-exporter.js # 调试导出：查询历史 + JSONL 文件轮转
│
├── facades/
│   ├── memory.js         # MemoryFacade：记忆操作门面
│   ├── health.js         # HealthFacade：健康检查门面
│   └── benchmark.js      # BenchmarkFacade：基准测试门面
│
└── benchmark/
    ├── scenario.js       # 测试场景定义
    ├── harness.js        # 测试运行器
    ├── metrics.js        # 搜索质量指标（命中率、召回率、Jaccard 多样性）
    ├── reporting.js      # JSON + Markdown 双格式报告
    └── cli.js            # CLI 入口
```

## 环境配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_HOST` | `127.0.0.1` | HTTP 绑定地址 |
| `HTTP_PORT` | `8901` | HTTP 端口 |
| `HTTP_SOCKET_PATH` | `/tmp/openclaw-engine.sock` | Unix Socket 路径（为空时禁用） |
| `OPENCLAW_API_SECRET` | 空 | API 认证密钥（空时不校验，启动时打印警告） |
| `SIDE_LLM_GATEWAY_URL` | 空 | 侧边 LLM 网关地址（用于治理语义比较） |
| `SIDE_LLM_GATEWAY_MODEL` | `k2p6` | 侧边 LLM 网关默认模型名 |
| `PROJECT_ROOT` | `../workspace` | 工作区根目录 |
| `CONTEXT_ENGINE_RUNTIME_DIR` | `./runtime` | 运行时数据目录（SQLite、日志等） |
| `LOCALMEM_DAILY_WRITE_LIMIT` | `50` | 自动来源每日写入上限 |
| `LOCALMEM_FACT_MAX_AGE_DAYS` | `180` | 事实记忆最大保留天数 |
| `LOCALMEM_SESSION_MAX_AGE_DAYS` | `60` | 会话最大保留天数 |
| `DEBUG_EXPORT_ENABLED` | `0` | 是否启用调试导出 |
| `DEBUG_EXPORT_HISTORY_LIMIT` | `20` | 调试导出历史记录上限 |
| `DEBUG_EXPORT_MAX_AGE_DAYS` | `3` | 调试导出文件最大保留天数 |
| `MCP_LOG_RETENTION_DAYS` | `3` | MCP 日志保留天数 |
| `LOCALMEM_AUTO_TRANSCRIPT_SYNC_ENABLED` | `1` | 是否启用对话记录自动同步 |
| `LOCALMEM_AUTO_TRANSCRIPT_MAX_AGE_SECONDS` | `1800` | 自动同步的对话记录最大存活秒数 |
| `CURSOR_PROJECTS_DIR` | `~/.cursor/projects` | Cursor 编辑器项目目录 |

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务
node src/index.js

# 验证服务
curl http://127.0.0.1:8901/api/health/ready
# → {"status":"ready"}

# 查看运行指标
curl http://127.0.0.1:8901/metrics
```

## 运维

### 常用命令

```bash
# 检查服务状态
curl http://127.0.0.1:8901/api/health

# 查看运行指标
curl http://127.0.0.1:8901/metrics

# 通过 Unix Socket 查询（自动注入 Bearer Token）
curl --unix-socket /tmp/openclaw-engine.sock http://localhost/api/health

# 搜索 wiki
curl -X POST http://127.0.0.1:8901/api/wiki/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "帧同步"}'

# 查询记忆
curl -X POST http://127.0.0.1:8901/api/memory/query \
  -H 'Content-Type: application/json' \
  -d '{"query": "项目架构", "limit": 5}'
```

### Graceful Shutdown

服务收到 SIGTERM / SIGINT 时：
1. 关闭 Unix Socket 监听
2. 删除 Socket 文件
3. 关闭 KnowledgeBase（SQLite TRUNCATE checkpoint + close）
4. 关闭 Fastify HTTP 服务

`uncaughtException` 时紧急执行 SQLite checkpoint + close，避免 WAL 数据丢失。

### Unix Socket 代理

本地工具通过 Unix Socket 连接时，透明代理自动注入 `Authorization: Bearer <secret>` 头，无需手动传 Token。远程客户端通过 HTTP 连接时必须提供 Bearer Token。

```
Unix Socket 客户端 → 透明代理（注入 Bearer Token）→ Fastify HTTP 服务
远程 HTTP 客户端 → 需要手动携带 Authorization 头 → Fastify HTTP 服务
```

### Bearer Token 认证

配置 `OPENCLAW_API_SECRET` 环境变量后启用。所有 HTTP 请求必须携带 `Authorization: Bearer <secret>` 头。未配置时跳过认证（启动时打印警告）。

### 数据目录

运行时数据默认存储在 `./runtime/` 目录：

```
runtime/
├── context-engine.db      # SQLite 数据库（记忆 + 会话 + 事件）
├── context-engine.db-wal  # WAL 日志
├── context-engine.db-shm  # 共享内存
└── logs/                  # Winston 日志文件
```

`prepareRuntimePath` 会自动将旧路径（`./data/`）的数据迁移到 `./runtime/`。

## 与旧架构的对比

| 维度 | 旧架构（Python 三服务） | 当前架构（Node.js 单服务） |
|------|----------------------|-------------------------|
| 语言 | Python | Node.js |
| 进程数 | 3（ChromaDB + Embedding + 主服务） | 1 |
| 内存 | ~700MB | ~50MB |
| 知识检索 | ChromaDB 向量检索 + BM25 分块索引 | LLM Wiki 关键词匹配 + 整页阅读 |
| 记忆模型 | 7 态 | 2 态（tentative / kept） |
| 数据库 | ChromaDB + SQLite | SQLite (better-sqlite3 + WAL) |
| 部署 | systemd 三服务链 | systemd 单服务 |
| 认证 | 无 | Bearer Token + Unix Socket 自动注入 |

## 许可证

[MIT License](LICENSE)
