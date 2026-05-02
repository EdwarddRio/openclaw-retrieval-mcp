# OpenClaw Context Engine

> 为 AI Agent 提供持久记忆和结构化知识的本地中间层服务。
>
> **单进程 · 零外部依赖 · ~50MB 内存 · Node.js 18+ · BM25 搜索 · 实体链接**

---

## 它是什么？

OpenClaw Context Engine 是一个轻量级 HTTP 服务，为 AI Agent 提供三种核心能力：

| 能力 | 说明 | 存储 |
|------|------|------|
| **记忆 (localMem)** | 保存对话中的重要信息，支持 BM25 搜索、实体链接、自动整理 | SQLite |
| **知识 (LLM Wiki)** | 将原始材料编译为结构化 Markdown 页面，支持搜索 | 文件系统 |
| **实体 (Entity)** | 从记忆中提取实体，支持观察级搜索和关联查询 | SQLite |

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent / Workspace                      │
│         memory_query / search_observations / wiki_search     │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP :8901 或 Unix Socket
┌─────────────────────────▼───────────────────────────────────┐
│                   Context Engine (本项目)                    │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │   localMem 记忆     │    │      LLM Wiki 知识          │ │
│  │  ─────────────────  │    │  ─────────────────────────  │ │
│  │  · BM25 搜索        │    │  · 增量编译                 │ │
│  │  · weight 生命周期   │    │  · 人工编辑保护             │ │
│  │  · 实体链接         │    │  · 关键词搜索               │ │
│  │  · 4因子融合排序    │    │  · 整页返回                 │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼ SQLite + 文件系统
```

---

## 快速开始

### 1. 安装

```bash
git clone <repo-url>
cd openclaw-engine-js
npm install

# 可选：安装 jieba 分词（更好的中文支持）
npm install @node-rs/jieba
```

### 2. 配置

```bash
# 复制配置模板
cp config/context-engine.env.example config/context-engine.env

# 编辑配置（至少设置 API_SECRET）
vim config/context-engine.env
```

### 3. 启动

```bash
# 直接启动
node src/index.js

# 或使用 npm
npm run start:http

# 或使用 systemd
systemctl --user start openclaw-context-engine.service
```

### 4. 验证

```bash
# 检查服务是否就绪
curl -H "Authorization: Bearer $API_SECRET" http://127.0.0.1:8901/api/health

# 测试记忆保存
curl -X POST -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:8901/api/memory/save \
  -d '{"content": "测试记忆", "weight": "MEDIUM", "category": "fact"}'

# 测试 BM25 搜索
curl -X POST -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:8901/api/memory/query \
  -d '{"query": "测试", "top_k": 5}'
```

---

## 核心功能

### 记忆系统 (localMem)

**v3.3 weight-based 生命周期**：用 `category` + `weight` + `expires_at` 替代旧的 `state` 字段。

```
对话内容
  → AutoTriage 智能分类
  → 根据信号强度分配 weight:
     TRIAGE_CONFIRM_SIGNALS → STRONG (自动确认)
     用户显式请求 → MEDIUM (需确认)
     其他 → WEAK (3天衰减)
  → BM25 索引同步
  → 实体提取和链接
```

**核心特性**：
- **BM25 搜索**：替代 LIKE 查询，支持中文 bigram/jieba 分词
- **4因子融合排序**：bm25Norm×0.5 + positionScore×0.1 + recency×0.3 + weightBoost×0.1
- **布尔查询**：`+必须 -排除 "精确短语" category:fact weight:STRONG`
- **递减衰减**：STRONG→14天→MEDIUM→7天→WEAK→3天→删除
- **实体链接**：自动提取技术/项目/概念/人物实体
- **观察级搜索**：精准匹配单条观察而非整条记忆
- **多范围隔离**：支持 user/agent/session/org/global 作用域

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

### 实体系统 (Entity)

**自动实体提取**：从记忆内容中提取技术、项目、概念、人物实体。

```
记忆内容："项目A使用Kubernetes部署"
  → 实体提取：[{name: "Kubernetes", type: "tech"}]
  → 保存到 entities 表
  → 关联到 entity_facts 表
  → 支持观察级搜索和关联查询
```

---

## API 端点

### 记忆 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/query` | BM25 记忆搜索 |
| POST | `/api/memory/query-context` | 上下文感知搜索（推荐） |
| POST | `/api/memory/save` | 保存记忆（支持 weight/category/scope） |
| POST | `/api/memory/turn` | 提交对话轮次 |
| GET | `/api/memory/timeline` | 记忆时间线 |
| GET | `/api/memory/:id` | 获取单条记忆 |
| PUT | `/api/memory/:id` | 更新记忆 |
| DELETE | `/api/memory/:id` | 删除记忆 |
| POST | `/api/memory/session/start` | 开始会话 |
| POST | `/api/memory/session/reset` | 重置会话 |
| POST | `/api/memory/auto-triage` | 手动触发整理 |
| POST | `/api/memory/auto-triage/batch` | 批量整理 |
| POST | `/api/memory/governance/plan-update` | 治理策略规划 |
| GET | `/api/memory/reviews` | 获取待审核记忆（WEAK） |
| POST | `/api/memory/reviews/:id/confirm` | 确认记忆（WEAK→STRONG/MEDIUM） |
| POST | `/api/memory/reviews/:id/discard` | 丢弃记忆 |
| POST | `/api/memory/search-observations` | 观察级搜索 |
| GET | `/api/memory/:id/related` | 获取关联记忆 |

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
│   │   ├── models.js           # 数据模型（MemoryFact, WEIGHT, CATEGORY）
│   │   ├── local-memory.js     # 核心逻辑：BM25 + 融合排序 + 实体提取
│   │   ├── sqlite-store.js     # SQLite 持久层（WAL 模式）
│   │   ├── governance.js       # 治理系统：冲突检测 + 策略
│   │   └── entity-extractor.js # 实体提取器（正则+词典）
│   │
│   ├── search/                 # 搜索引擎
│   │   ├── tokenizer.js        # 通用分词器（bigram默认+jieba可选）
│   │   ├── bm25.js             # 通用 BM25 搜索引擎
│   │   └── query-parser.js     # 布尔查询解析器
│   │
│   ├── wiki/                   # Wiki 引擎
│   │   ├── compiler.js         # Wiki 编译器
│   │   ├── manifest.js         # 源文件 SHA256 跟踪
│   │   └── bm25.js             # Wiki BM25 搜索
│   │
│   ├── routes/                 # 路由定义
│   ├── middleware/              # 中间件
│   ├── facades/                # 业务门面
│   ├── api/                    # API 契约
│   └── benchmark/              # 基准测试框架
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
| `TOKENIZER_MODE` | `auto` | 分词模式（auto/jieba/bigram） |
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

```bash
# 本地调用（自动认证）
curl --unix-socket /tmp/openclaw-engine.sock http://localhost/api/health

# 远程调用（需手动传 Token）
curl -H "Authorization: Bearer <secret>" http://remote:8901/api/health
```

---

## 记忆生命周期

### v3.3 weight-based 模型

```
┌─────────────────────────────────────────────────────────────┐
│                     记忆生命周期                            │
├─────────────────────────────────────────────────────────────┤
│  保存 → AutoTriage 分类                                     │
│         ├─ TRIAGE_CONFIRM_SIGNALS → STRONG (自动确认)       │
│         ├─ 用户显式请求 → MEDIUM (需确认)                   │
│         └─ 其他 → WEAK (3天衰减)                            │
│                                                             │
│  衰减规则（递减）：                                          │
│    STRONG → 14天 → MEDIUM → 7天 → WEAK → 3天 → 删除        │
│    MEDIUM → 7天 → WEAK → 3天 → 删除                         │
│    WEAK → 3天 → 删除                                        │
│                                                             │
│  免疫规则：                                                  │
│    instruction 类别：永不降级                                │
│    preference + STRONG：永不降级                             │
│                                                             │
│  用户操作：                                                  │
│    confirm → WEAK → STRONG/MEDIUM (重新计时)                │
│    discard → 硬删除                                         │
└─────────────────────────────────────────────────────────────┘
```

### 分类 (Category)

| 类别 | 说明 | 免疫规则 |
|------|------|---------|
| `fact` | 普通事实 | 无 |
| `preference` | 用户偏好 | STRONG 时永不降级 |
| `project` | 项目相关 | 无 |
| `instruction` | 指令/规则 | 永不降级 |
| `episodic` | 事件/经历 | 无 |
| `general` | 通用 | 无 |

---

## 搜索能力

### BM25 搜索

替代旧的 LIKE 查询，支持中文分词：

```bash
# 简单查询
curl -X POST http://127.0.0.1:8901/api/memory/query \
  -d '{"query": "Kubernetes 部署"}'

# 布尔查询
curl -X POST http://127.0.0.1:8901/api/memory/query \
  -d '{"query": "+部署 -deprecated \"Kubernetes\" category:project"}'
```

**查询语法**：
- `+词`：必须包含
- `-词`：必须排除
- `"短语"`：精确匹配
- `category:xxx`：按分类过滤
- `weight:xxx`：按权重过滤

### 4因子融合排序

```
finalScore = bm25Norm × 0.5 + positionScore × 0.1 + recency × 0.3 + weightBoost × 0.1
```

| 因子 | 权重 | 说明 |
|------|------|------|
| bm25Norm | 50% | BM25 分数归一化 |
| positionScore | 10% | 首次匹配位置越前越相关 |
| recency | 30% | 时间衰减（30天半衰期） |
| weightBoost | 10% | STRONG=1.5, MEDIUM=1.0, WEAK=0.5 |

### 分词策略

| 模式 | 说明 | 依赖 |
|------|------|------|
| bigram | 内置默认，零依赖 | 无 |
| jieba | 可选增强，更好中文支持 | `@node-rs/jieba` |
| auto | 自动选择（jieba可用就用jieba） | 可选 |

### 实体搜索

```bash
# 观察级搜索（精准匹配单条观察）
curl -X POST http://127.0.0.1:8901/api/memory/search-observations \
  -d '{"query": "Kubernetes", "top_k": 5}'

# 获取关联记忆（1跳）
curl http://127.0.0.1:8901/api/memory/:id/related
```

---

## 运维

### 常用命令

```bash
# 检查服务状态
curl -H "Authorization: Bearer $API_SECRET" http://127.0.0.1:8901/api/health

# 查看运行指标
curl -H "Authorization: Bearer $API_SECRET" http://127.0.0.1:8901/metrics

# 运行测试
npm test

# 代码检查
npm run lint

# 重启服务
systemctl --user restart openclaw-context-engine.service

# 查看日志
journalctl --user -u openclaw-context-engine.service -f
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
| 搜不到记忆 | 检查数据库 | `sqlite3 runtime/context-engine.db "SELECT COUNT(*) FROM memory_items WHERE status='active'"` |
| Wiki 没内容 | 检查编译状态 | `curl http://127.0.0.1:8901/api/wiki/status` |
| 内存占用高 | 查看指标 | `curl http://127.0.0.1:8901/metrics` |
| WAL 膨胀 | 手动 checkpoint | 重启服务会自动执行 |
| BM25 索引异常 | 检查日志 | `grep BM25 runtime/logs/*.log` |
| 实体未提取 | 检查正则 | `grep entity runtime/logs/*.log` |

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
| 搜索引擎 | BM25Okapi | 中文友好，内存索引，<5ms |
| 分词器 | bigram + jieba | 零依赖默认 + 可选增强 |
| 日志 | Pino (HTTP) + Winston (业务) | Pino 最快，Winston 灵活 |
| 速率限制 | rate-limiter-flexible | 内存存储，token bucket 算法 |
| 验证 | Zod | TypeScript 友好，预留扩展 |

---

## 与旧架构对比

| 维度 | 旧架构 (Python) | v3.3 架构 (Node.js) |
|------|----------------|-------------------|
| 进程数 | 3 (ChromaDB + Embedding + 主服务) | 1 |
| 内存 | ~700MB | ~50MB |
| 搜索 | 向量检索 + BM25 分块 | BM25 + 4因子融合排序 |
| 记忆模型 | 7 态 | weight-based (STRONG/MEDIUM/WEAK) |
| 分词 | 无 | bigram + jieba 可选 |
| 实体 | 无 | 自动提取 + 关联查询 |
| 部署 | systemd 三服务链 | systemd 单服务 |

---

## 许可证

[MIT License](LICENSE)
