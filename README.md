# OpenClaw Context Engine JS

OpenClaw 上下文引擎的 JavaScript/Node.js 实现，为 OpenClaw AI 助手提供知识检索、记忆管理和上下文理解能力。

## 项目定位

`openclaw-engine-js` 是 OpenClaw 生态系统的**上下文中间层**，采用 **localMem + LLM Wiki** 双引擎架构：

- **localMem**：SQLite 记忆存储，两个状态分区（tentative / kept），丢弃 = 硬删除
- **LLM Wiki**：基于 Karpathy LLM Wiki 模式的结构化知识库，取代传统 RAG 向量检索

**设计原则**：不建索引、不切 chunk、不依赖向量数据库。知识搜索走 wiki 页面关键词匹配，记忆搜索走 SQLite LIKE 查询，文件搜索交给 Agent 的文件系统工具。

## 架构

```
OpenClaw 主程序 / Cursor IDE / 微信机器人
              │
              ▼
    ┌─────────────────────┐
    │  HTTP Server (:8901) │  ← openclaw-engine-js
    │  或 MCP Server       │     (Fastify / MCP-SDK)
    └──────────┬──────────┘
               │
    ┌──────────┴──────────┐
    │   KnowledgeBase     │
    │  (Memory + Wiki     │
    │   + Health)         │
    └──────────┬──────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          
┌────────┐ ┌───────────┐ 
│ Memory │ │  Wiki      │ 
│ Facade │ │  Compiler  │ 
└───┬────┘ └─────┬─────┘ 
    │            │       
    ▼            ▼       
┌────────┐ ┌──────────┐ 
│ SQLite │ │ raw →    │ 
│localMem│ │ wiki 编译│ 
│(2-state)│ └──────────┘ 
└────────┘              
```

**关键设计决策**：向量搜索（ChromaDB + Embedding）和 BM25 分块索引（static_kb）均已移除，采用 LLM Wiki 模式替代传统 RAG。原因：
1. 向量检索对中文分词不友好，语义检索准确率不稳定
2. 向量数据库维护成本高，需要额外的 Python 服务和 GPU 资源
3. BM25 分块索引（static_kb）在 wiki 场景下是多余的——wiki 页面本身就是编译好的结构化文档，切碎反而丢失结构
4. LLM Wiki 的结构化 Markdown 比 embedding 分块更适合知识管理
5. 人类可以直接阅读和编辑 wiki 页面，实现真正的人机协作

## 核心功能

### 1. 知识搜索 (`wiki_search`)

wiki 页面关键词匹配（标题×5 + 内容计数），返回整页摘要：

- **标题加权**：标题中的关键词权重 ×5，精确命中知识页面
- **独立搜索**：wiki 自己的搜索，不依赖任何外部索引
- **整页返回**：返回完整的结构化页面，不是切碎的 chunk 片段
- **交叉引用**：wiki 页面间使用 `[[页面名]]` 语法互相链接

> **未来方向**：当 wiki 页面超过 200 页时，应接入 BM25Okapi 提升 IDF 区分度（约 50 行改动）。

### 2. 记忆系统 (`/api/memory/*`)

基于 SQLite 的本地记忆管理，**2 状态模型**：

```
tentative ──用户确认──→ kept（永久保留）
    │
    └──丢弃──→ 从数据库硬删除（不留痕迹）
```

- `tentative`：临时记忆，auto_triage / user_explicit 自动提取，7 天未确认自动清理
- `kept`：永久记忆，用户确认后保留
- **搜索方式**：SQL LIKE 多 token AND 查询（FTS5 默认分词器不支持中文，已回退）
- **三层过滤**：否定检测 → 敏感信息过滤 → 噪声过滤
- **Canonical Key SHA1 去重**：相同语义的记忆只存一份
- **每日写入限流**：自动来源每天最多 20 条

#### 待审核记忆提醒

tentative 记忆不会主动弹窗通知，但通过**心跳兜底脚本**实现被动提醒：

```
心跳触发 → check-review-reminder.sh → 查 SQLite tentative 记忆
  ├─ 有 tentative → 输出提醒文本 → 心跳推送给你
  └─ 无 tentative → 输出空 → 继续 HEARTBEAT_OK
```

| 触发时机 | 机制 | 说明 |
|---------|------|------|
| 心跳 | `check-review-reminder.sh` | 查 SQLite，有 tentative 就输出提醒 |
| 查询记忆 | `queryMemoryFull()` 返回 `tentative_items` | Agent 可选择提醒用户 |
| 7天过期 | `_maybePeriodicCleanup()` → 硬删除 | 不留痕迹 |

脚本位置：`/root/.openclaw/workspace/scripts/check-review-reminder.sh`

- 默认输出纯文本提醒；无提醒时输出空
- `check-review-reminder.sh json`：输出结构化 JSON，含 `age_days` 和 `expires_in_days`

### 3. LLM Wiki 编译 (`wiki_*` MCP 工具)

基于 Karpathy LLM Wiki 模式的结构化知识库：

- **raw → wiki 编译**：LLM 将原始材料编译为结构化 Markdown（不是复制！）
- **增量编译**：基于 SHA256 hash 的变更检测，只处理新增/修改的文件
- **[[交叉引用]]**：wiki 页面间使用 `[[页面名]]` 语法互相链接
- **人机协作**：wiki 页面是标准 Markdown，人类可直接编辑
- **独立管理**：wiki 由 WikiCompiler 管理，不依赖 localMem 的状态机

### 4. 健康监控 (`/api/health`)

聚合多维度健康状态：LocalMem + Benchmarks，三级状态（ready / stale / degraded）。

## API 端点清单

### Wiki

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/wiki/search` | Wiki 知识搜索 |
| GET | `/api/wiki/check-stale` | 检查 wiki 是否过期 |
| GET | `/api/wiki/status` | Wiki 编译状态 |

### 记忆

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/query` | 查询记忆 |
| POST | `/api/memory/query-context` | 记忆上下文查询 |
| GET | `/api/memory/timeline` | 记忆时间线 |
| POST | `/api/memory/turn` | 追加会话消息 |
| POST | `/api/memory/session/start` | 创建/切换会话 |
| POST | `/api/memory/session/reset` | 重置会话指针 |
| POST | `/api/memory/session/import-transcript` | 导入转录文件 |
| POST | `/api/memory/save` | 保存记忆 |
| POST | `/api/memory/governance/plan-update` | 记忆治理 Dry-Run |

### 健康 / 基准测试

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 完整健康快照 |
| GET | `/api/health/ready` | 快速就绪检查 |
| GET | `/metrics` | 服务指标（请求数、内存、运行时长） |
| POST | `/api/benchmarks/record` | 记录结果 |
| GET | `/api/benchmarks/latest` | 最新结果 |
| GET | `/api/benchmarks/history` | 历史记录 |
| POST | `/api/benchmarks/run` | 运行基准测试 |

## 项目结构

```
openclaw-engine-js/
├── src/
│   ├── index.js              # HTTP 服务入口 (Fastify)
│   ├── mcp-server.js         # MCP Server 入口
│   ├── knowledge-base.js     # 核心 Facade (Memory + Wiki + Health)
│   ├── config.js             # 配置管理
│   ├── api/                  # API 层
│   │   ├── contract.js       # 路由契约
│   │   ├── presenter.js      # 响应格式化
│   │   └── query-exporter.js # 调试查询导出
│   ├── memory/               # 记忆系统
│   │   ├── sqlite-store.js   # SQLite 存储层
│   │   ├── local-memory.js   # 记忆业务逻辑
│   │   ├── governance.js     # 记忆治理（冲突检测）
│   │   ├── models.js         # 数据模型
│   │   └── helpers.js        # 辅助函数
│   ├── wiki/                 # LLM Wiki 编译器
│   │   ├── compiler.js       # 增量编译、搜索、页面保存/删除/索引更新
│   │   └── manifest.js       # SHA256 变更检测
│   ├── facades/              # 子 Facade
│   │   ├── memory.js         # 记忆
│   │   ├── health.js         # 健康
│   │   └── benchmark.js      # 基准测试
│   ├── benchmark/            # 基准测试框架
│   └── observability/        # 可观测性
├── runtime/                  # 运行时数据 (SQLite)
├── config/                   # 配置文件
├── tests/                    # 测试文件
├── package.json
└── README.md
```

## 环境配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_HOST` | `127.0.0.1` | HTTP 绑定地址 |
| `HTTP_PORT` | `8901` | HTTP 端口 |
| `PROJECT_ROOT` | `/root/.openclaw/workspace` | 工作区根目录 |
| `CONTEXT_ENGINE_RUNTIME_DIR` | `./runtime` | 运行时数据目录 |
| `LOCALMEM_TRANSCRIPTS_ROOT` | `/root/.openclaw/workspace/memory` | 转录文件根目录 |

## 快速开始

### 环境要求

- Node.js >= 18.0.0

### 安装与启动

```bash
cd openclaw-engine-js
npm install

# HTTP 模式
npm run start:http

# MCP 模式
npm run start:mcp
```

### 健康检查

```bash
curl http://127.0.0.1:8901/api/health
```

## 运维

```bash
# 查看服务状态
systemctl --user status openclaw-context-engine.service

# 查看日志
journalctl --user -u openclaw-context-engine.service -f

# 重启
systemctl --user restart openclaw-context-engine.service

# 查看实时指标
curl http://127.0.0.1:8901/metrics

# 健康检查
curl http://127.0.0.1:8901/api/health/ready
```

### Graceful Shutdown

服务接收 `SIGTERM` / `SIGINT` 时会按序关闭：
1. Unix Socket 代理停止并清理 socket 文件
2. Fastify HTTP 服务关闭（等待正在处理的请求）
3. SQLite 数据库连接关闭（自动执行 WAL checkpoint）
4. 进程退出

避免直接 `kill -9`，防止 WAL 数据丢失。

## 与旧架构的对比

| 维度 | 旧架构（已废弃） | 当前架构 |
|------|----------------|---------|
| 知识检索 | ChromaDB 向量 + BM25 分块索引 | Wiki 关键词匹配 + 整页返回 |
| 向量数据库 | ChromaDB 独立服务 (:8000) | 无（已移除） |
| Embedding | Python Flask 服务 (:8902) | 无（已移除） |
| BM25 分块索引 | static_kb (chunk + BM25Okapi) | 无（已移除） |
| 记忆状态 | 7 态（tentative → published） | 2 态（tentative / kept） |
| Wiki 发布 | DB → wiki/ 目录文件投影 | LLM Wiki 独立编译系统 |
| 全文搜索 | FTS5（中文不友好） | LIKE 多 token AND 查询 |
| 丢弃记忆 | 软删除（status=discarded） | 硬删除 |
| 服务架构 | 三服务协作 | 单服务 |
| 部署 | systemd 三服务链 | systemd 单服务 |
| 可观测性 | 基础日志 | Metrics 端点 + WAL 健康检查 |
| SQL 优化 | 每次重新 prepare | Prepared Statement 缓存 |

## 许可证

MIT
