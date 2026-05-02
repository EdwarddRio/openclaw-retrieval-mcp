# OpenClaw Context Engine

> 为 AI Agent 提供持久记忆和结构化知识的本地中间层服务。
> 
> **单进程 · 零外部依赖 · ~50MB 内存 · Node.js 18+**

---

## 它是什么？

OpenClaw Context Engine 是一个轻量级 HTTP 服务，为 AI Agent 提供两种核心能力：

| 能力 | 说明 | 存储 |
|------|------|------|
| **记忆 (localMem)** | 保存对话中的重要信息，支持去重、过滤、自动整理 | SQLite |
| **知识 (LLM Wiki)** | 将原始材料编译为结构化 Markdown 页面，支持搜索 | 文件系统 |

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent / Workspace                      │
│              wiki_search / memory_save / ...                 │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP :8901 或 Unix Socket
┌─────────────────────────▼───────────────────────────────────┐
│                   Context Engine (本项目)                    │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │   localMem 记忆     │    │      LLM Wiki 知识          │ │
│  │  ─────────────────  │    │  ─────────────────────────  │ │
│  │  · 2-state 模型     │    │  · 增量编译                 │ │
│  │  · 三层过滤         │    │  · 人工编辑保护             │ │
│  │  · 自动去重         │    │  · 关键词搜索               │ │
│  │  · 治理系统         │    │  · 整页返回                 │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼ SQLite + 文件系统
```

---

## 快速开始

### 1. 安装

```bash
# 克隆项目
git clone <repo-url>
cd openclaw-engine-js

# 安装依赖
npm install
```

### 2. 启动

```bash
# 直接启动
node src/index.js

# 或使用 npm
npm run start:http
```

### 3. 验证

```bash
# 检查服务是否就绪
curl http://127.0.0.1:8901/api/health/ready
# → {"status":"ready"}

# 查看运行指标
curl http://127.0.0.1:8901/metrics
```

### 4. 基本使用

```bash
# 搜索 Wiki 知识
curl -X POST http://127.0.0.1:8901/api/wiki/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "帧同步"}'

# 查询记忆
curl -X POST http://127.0.0.1:8901/api/memory/query \
  -H 'Content-Type: application/json' \
  -d '{"query": "项目架构", "limit": 5}'

# 通过 Unix Socket 调用（自动注入认证）
curl --unix-socket /tmp/openclaw-engine.sock \
  http://localhost/api/health
```

---

## 核心功能

### 记忆系统 (localMem)

**2-state 模型**：`tentative`（临时）→ `kept`（永久），丢弃即硬删除。

```
对话内容
  → 否定检测（"先不管""试试看" → 丢弃）
  → 敏感过滤（密码/密钥 → 丢弃）
  → 噪声过滤（太短/太长/纯寒暄 → 丢弃）
  → SHA1 去重（相同内容只存一份）
  → 写入 tentative 状态
  → 用户确认 → kept（永久保留）
```

**核心特性**：
- 三层过滤：否定 → 敏感 → 噪声
- Canonical Key 去重：SHA1 规范化文本
- 日写入限流：自动来源每天最多 50 条
- 治理系统：四维重叠检测 + 四种策略
- Auto-Triage 保护：连续 5 次失败后暂停，30 分钟自动恢复
- 检索洞察注入：查询时自动注入上下文信息

### 知识系统 (LLM Wiki)

**Karpathy LLM Wiki 模式**：把知识编译成结构化 Markdown，人可读、机可查。

```
原始材料 (raw-sources)
  → detectChanges：SHA256 对比，找出变化
  → compile：Agent 编译为结构化页面
  → save：保存到 wiki/ 目录
  → updateIndex：刷新总索引
```

**核心特性**：
- 增量编译：只编译有变化的源文件
- 人工编辑保护：`<!-- human-edit-start -->` 区域不会被覆盖
- 搜索缓存：5 分钟 TTL，写入时主动失效
- 中文 bigram 扩展：精确匹配不足时自动放宽搜索

---

## API 端点

### 记忆 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/query` | 简单记忆搜索 |
| POST | `/api/memory/query-context` | 上下文感知搜索（推荐） |
| POST | `/api/memory/save` | 保存记忆 |
| POST | `/api/memory/turn` | 提交对话轮次 |
| GET | `/api/memory/timeline` | 记忆时间线 |
| GET | `/api/memory/:id` | 获取单条记忆 |
| PUT | `/api/memory/:id` | 更新记忆 |
| DELETE | `/api/memory/:id` | 删除记忆 |
| POST | `/api/memory/session/start` | 开始会话 |
| POST | `/api/memory/session/reset` | 重置会话 |
| POST | `/api/memory/auto-triage` | 手动触发整理 |
| POST | `/api/memory/governance/plan-update` | 治理策略规划 |
| GET | `/api/memory/reviews` | 获取待审核记忆 |
| POST | `/api/memory/reviews/:id/promote` | 确认记忆 |
| POST | `/api/memory/reviews/:id/discard` | 丢弃记忆 |

### Wiki API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/wiki/search` | 搜索 Wiki 页面 |
| GET | `/api/wiki/check-stale` | 检查是否有源文件变化 |
| GET | `/api/wiki/status` | Wiki 编译状态 |
| POST | `/api/wiki/detect-changes` | 检测源文件变化详情 |
| POST | `/api/wiki/compile-prompt` | 生成编译提示 |
| POST | `/api/wiki/save-page` | 保存 Wiki 页面 |
| POST | `/api/wiki/remove-page` | 删除 Wiki 页面 |
| POST | `/api/wiki/update-index` | 更新 Wiki 索引 |

### 系统 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康状态 + 统计 |
| GET | `/api/health/ready` | 就绪检查 |
| GET | `/metrics` | 运行指标 |
| POST | `/api/benchmarks/run` | 运行基准测试 |
| POST | `/api/rebuild` | 重建知识库 |

---

## 项目结构

```
openclaw-engine-js/
├── src/
│   ├── index.js                # Fastify 入口 + Unix Socket 代理
│   ├── config.js               # 环境变量配置
│   ├── knowledge-base.js       # 知识库门面（协调记忆 + Wiki）
│   │
│   ├── memory/                 # 记忆引擎
│   │   ├── models.js           # 数据模型
│   │   ├── local-memory.js     # 核心逻辑：过滤 + 去重 + 查询
│   │   ├── sqlite-store.js     # SQLite 持久层（WAL 模式）
│   │   └── governance.js       # 治理系统：冲突检测 + 策略
│   │
│   ├── wiki/                   # Wiki 引擎
│   │   ├── compiler.js         # Wiki 编译器
│   │   ├── manifest.js         # 源文件 SHA256 跟踪
│   │   └── bm25.js             # BM25 搜索（页面 >200 时启用）
│   │
│   ├── routes/                 # 路由定义
│   │   ├── index.js            # 路由注册
│   │   ├── memory.js           # 记忆路由
│   │   ├── wiki.js             # Wiki 路由
│   │   ├── health.js           # 健康检查路由
│   │   ├── benchmark.js        # 基准测试路由
│   │   └── legacy-bridge.js    # 兼容层
│   │
│   ├── middleware/              # 中间件
│   │   ├── cors.js             # CORS 配置
│   │   ├── rate-limit.js       # 速率限制
│   │   ├── tracing.js          # 请求追踪
│   │   ├── validation.js       # 请求验证
│   │   └── error-handler.js    # 统一错误处理
│   │
│   ├── facades/                # 业务门面
│   │   ├── memory.js           # 记忆操作门面
│   │   ├── health.js           # 健康检查门面
│   │   └── benchmark.js        # 基准测试门面
│   │
│   ├── api/                    # API 契约
│   │   ├── contract.js         # 请求模型 + 验证
│   │   └── presenter.js        # 响应格式化
│   │
│   └── benchmark/              # 基准测试框架
│       ├── scenario.js         # 测试场景
│       ├── harness.js          # 测试运行器
│       ├── metrics.js          # 搜索质量指标
│       └── reporting.js        # 报告生成
│
├── tests/                      # 测试文件
├── config/                     # 配置文件
├── scripts/                    # 脚本工具
├── runtime/                    # 运行时数据（SQLite、日志）
└── package.json
```

---

## 环境配置

### 必需配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_HOST` | `127.0.0.1` | HTTP 绑定地址 |
| `HTTP_PORT` | `8901` | HTTP 端口 |
| `OPENCLAW_API_SECRET` | 空 | API 认证密钥（空时跳过认证） |

### 可选配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_SOCKET_PATH` | `/tmp/openclaw-engine.sock` | Unix Socket 路径 |
| `PROJECT_ROOT` | `../workspace` | 工作区根目录 |
| `CONTEXT_ENGINE_RUNTIME_DIR` | `./runtime` | 运行时数据目录 |
| `SIDE_LLM_GATEWAY_URL` | 空 | LLM 网关地址（用于治理） |
| `SIDE_LLM_GATEWAY_MODEL` | `k2p6` | LLM 网关模型名 |
| `LOCALMEM_DAILY_WRITE_LIMIT` | `50` | 每日写入上限 |
| `RATE_LIMIT_POINTS` | `100` | 速率限制：请求数 |
| `RATE_LIMIT_DURATION` | `60` | 速率限制：窗口秒数 |
| `CORS_ORIGINS` | `*` | CORS 允许源 |

---

## 认证

### Bearer Token

配置 `OPENCLAW_API_SECRET` 后，所有 HTTP 请求必须携带：

```
Authorization: Bearer <your-secret>
```

未配置时跳过认证（启动时打印警告）。

### Unix Socket 自动注入

本地工具通过 Unix Socket 连接时，自动注入 Bearer Token，无需手动传参：

```
# 本地调用（自动认证）
curl --unix-socket /tmp/openclaw-engine.sock http://localhost/api/health

# 远程调用（需手动传 Token）
curl -H 'Authorization: Bearer <secret>' http://remote:8901/api/health
```

---

## 运维

### 常用命令

```bash
# 检查服务状态
curl http://127.0.0.1:8901/api/health

# 查看运行指标
curl http://127.0.0.1:8901/metrics

# 运行基准测试
npm run benchmark

# 运行测试
npm test

# 代码检查
npm run lint
```

### 数据目录

```
runtime/
├── context-engine.db      # SQLite 数据库
├── context-engine.db-wal  # WAL 日志
├── context-engine.db-shm  # 共享内存
└── logs/                  # 日志文件
```

### Graceful Shutdown

服务收到 SIGTERM / SIGINT 时：
1. 关闭 Unix Socket 监听
2. 删除 Socket 文件
3. SQLite TRUNCATE checkpoint + close
4. 关闭 HTTP 服务

`uncaughtException` 时紧急执行 checkpoint，避免数据丢失。

---

## 故障排查

| 问题 | 排查 | 命令 |
|------|------|------|
| 服务起不来 | 查看日志 | `journalctl --user -u openclaw-context-engine` |
| 认证失败 | 检查密钥 | `echo $OPENCLAW_API_SECRET` |
| 搜不到记忆 | 检查数据库 | `sqlite3 runtime/context-engine.db "SELECT COUNT(*) FROM memory_items"` |
| Wiki 没内容 | 检查编译状态 | `curl http://127.0.0.1:8901/api/wiki/status` |
| 内存占用高 | 查看指标 | `curl http://127.0.0.1:8901/metrics` |
| WAL 膨胀 | 手动 checkpoint | 重启服务会自动执行 |

---

## 测试

```bash
# 运行所有测试
npm test

# 运行单个测试文件
node --test tests/memory-edge-cases.test.js

# 带覆盖率
npm run test:coverage

# 运行基准测试
npm run benchmark:default
```

---

## 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| HTTP 框架 | Fastify | 性能优于 Express，内置验证 |
| 数据库 | better-sqlite3 | 零部署，同步 API，WAL 模式 |
| 日志 | Pino (HTTP) + Winston (业务) | Pino 最快，Winston 灵活 |
| 速率限制 | rate-limiter-flexible | 内存存储，token bucket 算法 |
| 验证 | Zod | TypeScript 友好，预留扩展 |

---

## 与旧架构对比

| 维度 | 旧架构 (Python) | 当前架构 (Node.js) |
|------|----------------|-------------------|
| 进程数 | 3 (ChromaDB + Embedding + 主服务) | 1 |
| 内存 | ~700MB | ~50MB |
| 知识检索 | 向量检索 + BM25 分块 | 关键词匹配 + 整页阅读 |
| 记忆模型 | 7 态 | 2 态 (tentative/kept) |
| 部署 | systemd 三服务链 | systemd 单服务 |

---

## 许可证

[MIT License](LICENSE)
