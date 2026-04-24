# OpenClaw Context Engine JS

OpenClaw 上下文引擎的 JavaScript/Node.js 实现，为 OpenClaw AI 助手提供知识检索、记忆管理和上下文理解能力。本项目已完全替代原 Python 版本 (`openclaw-context-engine`)，作为 OpenClaw 的常驻中间层服务运行。

## 项目定位

`openclaw-engine-js` 是 OpenClaw 生态系统的**上下文中间层**，位于 OpenClaw 主程序与底层基础设施之间：

- 接收 OpenClaw 的查询请求，从知识库和记忆中检索相关内容
- 管理用户与 AI 的对话记忆，支持长期记忆沉淀和 wiki 发布
- 提供健康监控、基准测试和可观测性数据
- 通过 MCP (Model Context Protocol) 协议与 IDE 集成

## 当前部署状态

本项目已通过 systemd 用户服务实现**常驻运行**，与 ChromaDB、Embedding 服务组成三服务架构：

```
┌─────────────────────────────────────────────────────────────┐
│  systemd --user 托管的服务组                                   │
├─────────────────────────────────────────────────────────────┤
│  openclaw-context-engine.service  →  JS 中间层 (:8901)       │
│  openclaw-chromadb.service        →  ChromaDB (:8000)        │
│  openclaw-embedding.service       →  Embedding (:8902)       │
│  openclaw-gateway.service         →  OpenClaw 网关           │
│  openclaw-distill.timer/service   → 每 2h 自动提炼            │
└─────────────────────────────────────────────────────────────┘
```

- **HTTP 入口**: `http://127.0.0.1:8901`
- **运行目录**: `/root/.openclaw/openclaw-engine-js`
- **数据目录**: `/root/.openclaw/openclaw-engine-js/runtime/`
- **配置目录**: `/root/.openclaw/openclaw-engine-js/config/`
- **日志**: `journalctl --user -u openclaw-context-engine.service`

## 技术架构

### 核心组件

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| HTTP 框架 | Fastify | 高性能 Node.js Web 框架，19 个 REST API 端点 |
| 向量数据库 | ChromaDB (HTTP 模式) | 独立服务 (:8000)，通过官方 JS Client 访问 |
| Embedding | Python Flask + sentence-transformers | 独立服务 (:8902)，模型 `BAAI/bge-small-zh-v1.5` |
| 关键词检索 | 自研 BM25Okapi (JS) | 替代 Python `rank_bm25`，支持中文 |
| 中文分词 | nodejieba | 替代 Python `jieba` |
| 本地数据库 | better-sqlite3 | 替代 Python `sqlite3`，同步 API 更高性能 |
| 缓存格式 | JSON | 替代 Python `pickle`，跨语言兼容 |
| 日志 | Winston + Fastify 内置日志 | 结构化日志输出 |

### 服务拓扑

```
OpenClaw 主程序 / Cursor IDE / 微信机器人
              │
              ▼
    ┌─────────────────────┐
    │  HTTP Server (:8901) │  ← openclaw-engine-js
    │      (Fastify)       │
    └──────────┬──────────┘
               │
    ┌──────────┴──────────┐
    │   KnowledgeBase     │
    │  (Search + Memory   │
    │   + Health + Obs)   │
    └──────────┬──────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌───────┐ ┌────────┐ ┌──────────┐
│Search │ │ Memory │ │ Health   │
│Facade │ │ Facade │ │ Facade   │
└───┬───┘ └───┬────┘ └────┬─────┘
    │         │           │
    ▼         ▼           ▼
┌─────────────────────────────────────┐
│  Hybrid Retriever (向量 + 关键词)    │
│  ┌──────────┐  ┌──────────┐        │
│  │ ChromaDB │  │  BM25    │        │
│  │  Client  │  │  Index   │        │
│  └────┬─────┘  └────┬─────┘        │
│       │             │              │
│       ▼             ▼              │
│  ┌─────────┐  ┌─────────────┐     │
│  │ChromaDB │  │ File Scan   │     │
│  │:8000    │  │ + Loaders   │     │
│  └────┬────┘  └─────────────┘     │
│       │                            │
│       ▼                            │
│  ┌─────────────┐                  │
│  │ Embedding   │                  │
│  │ :8902       │                  │
│  └─────────────┘                  │
└─────────────────────────────────────┘
```

## 核心功能

### 1. 知识库搜索 (`/api/search`)

混合检索：向量相似度 (ChromaDB) + BM25 关键词匹配 + RRF 融合排序

- 支持 doc_type 过滤（rule / code / config / memory）
- 支持会话上下文绑定
- 查询意图识别（规则查询、代码查询、配置查询等）
- 结果包含评分拆解和调试信息

### 2. 记忆系统 (`/api/memory/*`)

基于 SQLite 的本地记忆管理，状态机驱动：

```
tentative → local_only ─→ candidate_on_reuse → wiki_candidate → published
    │          ↑                                     ↓              ↓
    │      手动保存                              审核通过        wiki/ 目录
    ↓          ↑                                     ↓         (DB-backed,
manual_only ───┘                                 publishWikiPage  自动重建)
                                                      ↓
                                                 discarded (丢弃)
```

- **会话管理**: 自动追踪活跃会话，支持多项目隔离
- **记忆沉淀**: 高频复用的记忆自动晋升为 wiki 候选
- **审核队列**: wiki_candidate 进入人工审核流程
- **Wiki 发布**: 审核通过后发布为 Markdown 文件到 `wiki/` 目录，作为 static_kb 被 scanner 索引
- **Wiki 自愈**: 启动时自动检测 wiki/ 目录完整性，缺失时从 DB 重建（`_ensureWikiDir()`）
- **转录导入**: 支持导入 Cursor IDE 的会话转录 JSONL
- **审核选项提示**: API 返回的待审核项自带 `available_actions`（`publish` / `keep_local` / `discard` / `manual_only`），避免只提示 publish

### 3. 健康监控 (`/api/health`)

聚合多维度健康状态：

- Collections: 向量索引加载状态
- LocalMem: SQLite 记忆统计
- ChromaDB: 向量数据库连通性
- Embedding: 模型加载状态
- Governance: 待审核项计数
- Benchmarks: 基准测试状态

### 4. 基准测试 (`/api/benchmarks/*`)

记录和追踪搜索质量指标，支持回归检测。

## API 端点清单

### 搜索

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/search` | 知识库混合搜索 |
| POST | `/api/search/sync` | 同步集合索引 |

### 记忆

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/query` | 查询记忆命中项和审核队列 |
| POST | `/api/memory/query-context` | 记忆上下文查询（用于 prompt 注入） |
| GET | `/api/memory/timeline` | 记忆时间线 |
| POST | `/api/memory/choice` | 记录用户对记忆的选择 |
| GET | `/api/memory/reviews` | 列出待审核记忆项 |
| POST | `/api/memory/review` | 审核记忆候选 |
| POST | `/api/memory/turn` | 追加会话消息 |
| POST | `/api/memory/session/start` | 创建/切换会话 |
| POST | `/api/memory/session/reset` | 重置会话指针 |
| POST | `/api/memory/session/import-transcript` | 导入转录文件 |

### 管理 / 健康

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/collections` | 列出可用集合 |
| POST | `/api/rebuild` | 重建索引 |
| GET | `/api/health` | 完整健康快照 |
| GET | `/api/health/ready` | 快速就绪检查 |
| GET | `/api/stats` | 统计信息 |

### 基准测试

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/benchmarks/record` | 记录结果 |
| GET | `/api/benchmarks/latest` | 最新结果 |
| GET | `/api/benchmarks/history` | 历史记录 |

## 环境配置

配置文件位于 `config/context-engine.env`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_HOST` | `127.0.0.1` | HTTP 绑定地址 |
| `HTTP_PORT` | `8901` | HTTP 端口 |
| `CHROMA_URL` | `http://127.0.0.1:8000` | ChromaDB 地址 |
| `EMBEDDING_URL` | `http://127.0.0.1:8902` | Embedding 服务地址 |
| `PROJECT_ROOT` | `/root/.openclaw/workspace` | 工作区根目录 |
| `CONTEXT_ENGINE_RUNTIME_DIR` | `./runtime` | 运行时数据目录 |
| `CONTEXT_ENGINE_COLLECTIONS_FILE` | `./config/collections.default.json` | 集合配置 |
| `LOCALMEM_TRANSCRIPTS_ROOT` | `/root/.openclaw/workspace/memory` | 转录文件根目录 |

## 项目结构

```
openclaw-engine-js/
├── src/
│   ├── index.js              # HTTP 服务入口 (Fastify)
│   ├── knowledge-base.js     # 核心 Facade，组合所有子系统
│   ├── config.js             # 配置管理、常量、路径解析
│   ├── api/
│   │   ├── contract.js       # API 路由契约
│   │   ├── presenter.js      # 响应格式化
│   │   └── search-service.js # 搜索业务逻辑
│   ├── retrieval/            # 检索引擎
│   │   ├── collection-manager.js  # 集合生命周期管理
│   │   ├── indexer.js        # ChromaDB + BM25 索引构建
│   │   ├── retriever.js      # 混合检索 (向量 + BM25)
│   │   ├── scanner.js        # 文件扫描和加载
│   │   ├── tokenizer.js      # 中文/英文分词
│   │   └── bm25/             # BM25Okapi 实现
│   ├── memory/               # 记忆系统
│   │   ├── sqlite-store.js   # SQLite 存储层
│   │   ├── local-memory.js   # 记忆业务逻辑
│   │   ├── wiki-publisher.js # Wiki 发布器（publishCandidate + publishWikiPage）
│   │   └── models.js         # 数据模型
│   ├── vector/               # 向量服务客户端
│   │   ├── chroma-client.js  # ChromaDB HTTP 客户端
│   │   └── embedding-client.js # Embedding 服务客户端
│   ├── facades/              # 子 Facade
│   │   ├── search.js         # 搜索 Facade
│   │   ├── memory.js         # 记忆 Facade
│   │   ├── health.js         # 健康 Facade
│   │   └── benchmark.js      # 基准测试 Facade
│   └── observability/        # 可观测性
├── embedding-service/        # Python Embedding HTTP 服务
│   ├── app.py                # Flask 服务
│   └── requirements.txt      # Python 依赖
├── runtime/                  # 运行时数据 (SQLite + ChromaDB + 缓存)
├── config/                   # 配置文件
│   ├── context-engine.env    # 环境变量
│   └── collections.default.json # 集合定义
├── scripts/                  # 启动脚本
├── tests/                    # 测试文件
├── package.json              # Node.js 依赖
└── README.md                 # 本文档
```

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- Python >= 3.11（用于 Embedding 服务）
- ChromaDB（独立 HTTP 服务）

### 安装

```bash
cd openclaw-engine-js
npm install
```

### 启动依赖服务

```bash
# 1. 启动 ChromaDB
chromadb run --path ./runtime/chroma_data --host 127.0.0.1 --port 8000

# 2. 启动 Embedding 服务
cd embedding-service
pip install -r requirements.txt
python app.py
```

### 启动 Context Engine

```bash
# 开发模式
npm run start:http

# 或 systemd 常驻运行
systemctl --user start openclaw-context-engine.service
```

### 健康检查

```bash
curl http://127.0.0.1:8901/api/health
curl http://127.0.0.1:8901/api/health/ready
```

## 运维命令

```bash
# 查看服务状态
systemctl --user status openclaw-context-engine.service
systemctl --user status openclaw-chromadb.service
systemctl --user status openclaw-embedding.service
systemctl --user status openclaw-distill.timer

# 查看日志
journalctl --user -u openclaw-context-engine.service -f
journalctl --user -u openclaw-chromadb.service -f
journalctl --user -u openclaw-embedding.service -f

# 重启服务
systemctl --user restart openclaw-context-engine.service
systemctl --user restart openclaw-chromadb.service
systemctl --user restart openclaw-embedding.service
```

## 自动提炼（Distill）

系统配备定时提炼脚本，自动把历史 turns 聚合成 wiki_candidate：

| 文件 | 作用 |
|------|------|
| `/root/.openclaw/workspace/scripts/distill-turns.js` | 核心提炼脚本：读 turns → 过滤噪音 → 生成 wiki_candidate → 写入 context-engine |
| `/root/.openclaw/workspace/scripts/check-distill.sh` | Heartbeat 钩子：检查 embedding 健康、2h 冷却、执行提炼、更新状态 |
| `~/.config/systemd/user/openclaw-distill.timer` | 每 2 小时保底运行一次提炼（不依赖 agent 心跳） |
| `~/.config/systemd/user/openclaw-distill.service` | timer 触发的一次性服务 |

**双重保障**：
1. OpenClaw agent 每 2 小时 heartbeat 时调用 `check-distill.sh`
2. systemd timer 每 2 小时独立执行一次

**默认策略**：只扫描最近 24 小时的 turns，防止一次性产生大量低质量候选。如需全量跑历史数据，可临时放宽时间窗口执行一次。

## 与 Python 版本的差异

| 方面 | Python 版本 | JS 版本 (当前) |
|------|------------|---------------|
| Web 框架 | FastAPI | Fastify |
| ChromaDB | PersistentClient（本地文件） | HTTP Client（独立服务） |
| Embedding | 进程内 sentence-transformers | 独立 Python HTTP 服务 |
| BM25 | rank_bm25 | JS 原生实现 |
| 分词 | jieba | nodejieba |
| 缓存 | Python pickle | JSON |
| 数据库 | sqlite3 | better-sqlite3 |
| 部署 | 手动启动 | systemd 常驻服务 |

## 故障排查

### Embedding 服务无法连接

Embedding 服务过去没有持久化机制，服务器重启或终端退出后就会丢失。现已补齐 systemd 用户服务 `openclaw-embedding.service`。

```bash
# 验证连通性
curl http://localhost:8902/health

# 检查服务状态
systemctl --user status openclaw-embedding.service

# 查看日志
journalctl --user -u openclaw-embedding.service -n 50 --no-pager
```

### ChromaDB 无法连接

```bash
curl http://localhost:8000/api/v2/heartbeat
# 检查 chromadb 服务状态
systemctl --user status openclaw-chromadb.service
```

### 索引为空或搜索结果异常

```bash
# 检查缓存和 ChromaDB 数据一致性
curl http://localhost:8901/api/stats
# 手动触发重建
curl -X POST http://localhost:8901/api/rebuild
```

### 权限问题

确保 `runtime/` 目录对 Node.js 进程可读写：
```bash
chmod -R u+w /root/.openclaw/openclaw-engine-js/runtime/
```

## 许可证

MIT
