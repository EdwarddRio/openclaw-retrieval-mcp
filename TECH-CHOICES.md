# OpenClaw Context Engine 技术选型深度解析

> 本文采用"技术小白提问 + 架构师回答"的对话形式，逐层剥开 `openclaw-engine-js` 的每一个技术决策。
>
> 目标读者：对技术感兴趣的产品/运维人员，以及刚接触本项目的开发者。
> 阅读建议：如果某节看不懂，跳过不影响理解其他节——每节相对独立。

---

## 人物设定

- **小白**：刚入职的后端新人，会写 Node.js，对 AI 和知识检索完全没概念
- **架构师**：十年经验，负责本项目核心架构，说话直率

---

## 一、全局架构选型

### 1.1 为什么是 Node.js 而不是 Python？

**小白**：之前的上下文引擎是 Python 写的，为什么重写成 Node.js？

**架构师**：三个原因：

| 维度 | Node.js | Python |
|------|---------|--------|
| 部署复杂度 | 单进程，零外部依赖 | 需要 Python 虚拟环境 + pip 依赖 |
| 与主程序通信 | 同语言，可直接嵌入 | 需要跨进程通信（HTTP/gRPC） |
| 内存占用 | ~50MB | ~200MB（含 ChromaDB 客户端） |

**优势**：
- 部署简单：`npm install` + `node src/index.js`，不需要 Python 虚拟环境
- 通信高效：OpenClaw 主程序是 Node.js，同语言直接 HTTP 调用，无序列化开销
- 生态够用：better-sqlite3、Fastify 都是成熟方案

**劣势**：
- 数据科学生态不如 Python（但本项目不需要 numpy/pandas）
- CPU 密集型任务不如 Python 的 C 扩展高效（但本项目是 I/O 密集型）
- 中文 NLP 工具链不如 Python 丰富（但本项目用简单分词就够了）

### 1.2 为什么是单服务而不是微服务？

**小白**：之前是三服务协作（ChromaDB + Embedding 服务 + 主服务），为什么改成单服务？

**架构师**：因为三服务架构的运维成本远大于收益：

| 维度 | 旧架构（三服务） | 当前架构（单服务） |
|------|----------------|----------------|
| 进程数 | 3（ChromaDB + Embedding + 主服务） | 1 |
| 端口占用 | 3（8000 + 8902 + 8901） | 1（8901）+ 可选 Unix Socket |
| 内存占用 | ~700MB（含 ChromaDB + Python） | ~50MB |
| 部署 | systemd 三服务链 | systemd 单服务 |
| 故障点 | 3 个进程都可能挂 | 1 个进程 |
| 调试 | 跨服务日志追踪 | 单进程日志 |

**优势**：部署简单、故障点少、内存占用低、调试方便
**劣势**：单进程无法水平扩展（但本项目数据量不需要）

### 1.3 为什么放弃向量检索和 BM25 分块索引？

**小白**：我看到项目从 ChromaDB + Embedding + BM25 分块索引变成了 localMem + LLM Wiki，为什么？

**架构师**：三步演化：

1. **移除向量检索**：中文没有空格分隔，embedding 模型对短查询和长文档的语义匹配不稳定，经常"看起来相关但实际不相关"。而且 ChromaDB + Python Embedding 服务需要额外 500MB 内存和 GPU 资源
2. **移除 BM25 分块索引（static_kb）**：BM25 分块索引把文件切成 chunk 建索引，但 LLM Wiki 的页面本身就是编译好的结构化文档——切碎反而丢失结构。Agent 可以直接用 `read_file` 读文件，不需要中间层建索引
3. **保留 LLM Wiki**：Karpathy 提出的 LLM Wiki 模式，把知识编译成结构化 Markdown，人可读、机可查、易维护

**小白**：那搜索质量会下降吗？

**架构师**：不会。对于精确匹配（文件名、端口号、函数名），关键词搜索本来就够用。对于语义理解，LLM Wiki 的结构化页面比 embedding 分块更准确——因为 wiki 页面是完整的知识文档，不是切碎的 512 token 片段。用户搜"帧同步"，直接命中 `[[帧同步-Lockstep]]` 整个页面，比向量检索返回 3 个不相关的代码片段好得多。

| 维度 | 传统 RAG | LLM Wiki |
|------|---------|----------|
| 检索方式 | 向量相似度 + 分块 | 关键词匹配 + 整页阅读 |
| 知识组织 | 切片/分块 | 结构化页面 |
| 人类可读性 | 差（分块后语义不完整） | 好（整页就是完整的知识文档） |
| 人机协作 | 困难 | 自然（直接编辑 Markdown） |
| 维护成本 | 需要维护向量数据库 | 只需维护 Markdown 文件 |
| 知识生长 | 被动（依赖检索） | 主动（持续编译完善） |

---

## 二、HTTP 框架选型：Fastify vs Express

**小白**：API 层为什么用 Fastify 而不是 Express？

**架构师**：

| 维度 | Fastify | Express |
|------|---------|---------|
| 性能 | 比 Express 快 2-3 倍（JSON 序列化用 fast-json-stringify） | 够用但不是最快 |
| Schema 验证 | 内置 JSON Schema 验证 | 需要额外中间件 |
| 插件系统 | 封装性好，作用域隔离 | 中间件全局共享 |
| 日志 | 内置 Pino（最快的 Node.js 日志库） | 需要自行集成 |
| TypeScript | 原生类型支持 | 需要 @types/express |

**选择**：Fastify

**优势**：
- 性能优势明显，JSON 序列化速度是 Express 的 2-3 倍
- 内置请求验证（`preHandler` + `validate()` 模式），不需要额外中间件
- 插件作用域隔离，避免全局污染
- 内置 Pino 日志，零配置即可使用

**劣势**：
- 生态比 Express 小（但本项目不需要大量中间件）
- 学习曲线比 Express 略陡（但 API 风格相似）
- 部分第三方库只有 Express 中间件版本（本项目未遇到）

**请求验证实现**：用 `validateBody` preHandler 模式。每个请求模型（如 `MemorySaveRequest`）都有 `validate()` 方法，返回 `{ valid, errors }`。验证失败时返回 400 + 错误详情，验证通过时继续路由处理。

---

## 三、数据库选型：SQLite (better-sqlite3) vs PostgreSQL/Redis

**小白**：为什么用 SQLite 而不是 PostgreSQL 或 Redis？

**架构师**：

| 维度 | better-sqlite3 | PostgreSQL | Redis |
|------|---------------|------------|-------|
| 部署 | 零配置，文件即数据库 | 需要独立服务 | 需要独立服务 |
| 内存 | ~5MB | ~100MB+ | ~50MB+ |
| 事务 | 完整 ACID | 完整 ACID | 有限事务 |
| 查询 | SQL 全功能 | SQL 全功能 | 键值查询为主 |
| 并发 | 单写多读（WAL 模式） | 多写多读 | 单线程 |
| 适用场景 | 单机嵌入式 | 多客户端服务 | 缓存/会话 |

**选择**：better-sqlite3 + WAL 模式

**优势**：
- 零部署：数据库就是一个文件，不需要独立服务
- 零网络开销：进程内调用，没有 TCP 连接
- 完整 SQL：LIKE 查询、事务、JOIN 全支持
- WAL 模式：读写不互斥，读操作不阻塞写操作
- 同步 API：better-sqlite3 是同步的，不需要 async/await，代码更简洁

**劣势**：
- 单写：同一时刻只能有一个写操作（但本项目写操作频率低）
- 不支持多进程写入（本项目单进程，无此问题）
- 不适合超大数据集（本项目数据量在 GB 级别以内）

### 关键实现细节

**WAL 管理**：
- 启动时自动启用 WAL 模式：`this.db.pragma('journal_mode = WAL')`
- WAL 超过 10MB 或 log frames 超过 1000 时自动 checkpoint
- 每小时检查一次是否需要 checkpoint
- 服务关闭时执行 TRUNCATE checkpoint，确保 WAL 数据写入主库
- `uncaughtException` 时紧急执行 checkpoint + close，避免数据丢失

**Prepared Statement 缓存**：
- `_stmtCache` Map 缓存已编译的 SQL 语句
- `_getStmt(sql)` 优先从缓存取，避免重复编译
- 高频 SQL（如 `queryMemory`、`addQueryHash`）受益最大

**数据库迁移版本控制**：
- `_meta` 表记录 `migration_version`
- 迁移是幂等的：`_ensureColumns` 只添加缺失的列
- 版本 1 迁移：删除废弃表（`memory_reviews`、`wiki_exports`、`memory_mentions`、`runtime_state`、`memory_items_fts`）和废弃触发器
- 旧状态自动迁移：7 态 → 2 态（`local_only`/`manual_only` → `kept`，`wiki_candidate`/`candidate_on_reuse` → `tentative`，`discarded`/`archived` → 硬删除）

---

## 四、搜索方案选型：关键词匹配 vs 向量检索 vs BM25

### 4.1 记忆搜索：SQL LIKE + 中文 bigram 扩展

**小白**：记忆搜索为什么不建索引？BM25 不是更快吗？

**架构师**：建索引的前提是数据量大到简单扫描不够用。我们的数据量：

| 搜索目标 | 数据量 | 搜索方式 | 耗时 |
|---------|--------|---------|------|
| 记忆条目 | 几百条 | SQL LIKE 多 token AND | <1ms |

**query_memory 实现**：

```sql
SELECT * FROM memory_items
WHERE (content LIKE '%token1%' OR aliases_json LIKE '%"token1"%')
  AND (content LIKE '%token2%' OR aliases_json LIKE '%"token2"%')
  AND status = 'active' AND state IN ('tentative', 'kept')
ORDER BY updated_at DESC LIMIT ?
```

**中文 bigram 扩展搜索**：精确匹配不足时，自动将中文查询词拆分为 bigram（双字组合），放宽匹配条件：

```javascript
// "帧同步" → ["帧同", "同步"]
// 至少匹配 ceil(bigrams.length / 2) 个 bigram
```

为什么需要这个？中文没有空格分词，"帧同步策略"和"帧同步"共享"帧同"和"同步"两个 bigram，但精确匹配 "帧同步策略" 搜不到 "帧同步"。bigram 扩展解决了这个问题。

**搜索排序权重** (`RELEVANCE_WEIGHTS.search`)：
- **命中率 (hitRate)** 50%：查询词在内容中的命中比例
- **位置 (position)** 20%：命中词出现位置越靠前分越高
- **频次 (count)** 15%：记忆被查询命中的历史次数（从 `unique_query_hashes` 字段计算）
- **新鲜度 (freshness)** 15%：越新的记忆分越高

**置信度权重** (`RELEVANCE_WEIGHTS.confidence`)：
- **命中率 (hitRate)** 40% / **位置 (position)** 20% / **频次 (count)** 20% / **新鲜度 (freshness)** 20%

```javascript
score = hitRate * 0.5 + positionScore * 0.2 + countScore * 0.15 + freshnessScore * 0.15
```

**频次维度**：每次查询命中一条记忆时，`addQueryHash()` 会把查询的哈希值追加到 `unique_query_hashes` 字段。`computeRelevanceScore` 用 `Math.min(1, _hitCount / 3)` 归一化——被 3 次以上不同查询命中的记忆，频次维度得满分。

**置信度**：`_computeConfidence` 取前 3 个命中结果的 `computeRelevanceScore` 平均分。这样即使第一个命中较弱，但后续命中较强时，置信度不会太低，避免不必要的弃权。

### 4.2 Wiki 搜索：标题加权词频匹配

**小白**：Wiki 搜索为什么不也用 SQL？

**架构师**：Wiki 页面是 Markdown 文件，不在数据库里。搜索直接读文件：

```javascript
score += titleMatchCount * 5 + contentMatchCount;
// 返回 score > 0 的页面，按 score 降序
```

为什么不用 BM25？三个原因：
1. **~24 页太少**，BM25 的 IDF（逆文档频率）区分度极低——每个词几乎都只出现在 1-2 个页面里
2. **返回整页不是 chunk**，BM25 的核心优势是 chunk 级精确匹配，但 wiki 返回整页
3. **零依赖零状态**，不需要建索引、不需要缓存文件、不需要增量同步

搜索缓存：5 分钟 TTL（`_searchCacheTTL = 300000`ms），`saveWikiPage` 或 `removeWikiPage` 被调用时主动失效。外部直接编辑 wiki 文件时缓存不会感知——需要等 TTL 过期。

### 4.3 为什么不用 FTS5？

**架构师**：SQLite FTS5 的默认分词器不支持中文（没有空格分隔），测试后发现 LIKE 查询对中文更可靠。而且 FTS5 需要维护额外的虚拟表和触发器，增加了复杂度。

### 4.4 未来升级路径

> **📋 未来升级方向（wiki_search → BM25）**
>
> 当 wiki 页面超过 200 页时，简单词频匹配的召回率和区分度会下降，需要升级为 BM25Okapi。升级方案：
>
> | 维度 | 当前（简单词频） | 升级后（BM25） |
> |------|----------------|---------------|
> | 触发条件 | 页面 < 200 | 页面 ≥ 200 |
> | 搜索方式 | 标题×5 + 内容计数 | BM25Okapi IDF + TF 归一化 |
> | 返回粒度 | 整页摘要 | 整页摘要（不切 chunk） |
> | 改动范围 | — | `wiki/compiler.js` 的 `searchWiki()` 方法，约 50 行 |
> | 依赖 | 无 | `bm25Okapi` npm 包（或内联实现） |
>
> 关键设计决策：即使升级 BM25，仍返回**整页**而非 chunk。wiki 页面本身就是编译好的结构化文档，切碎会丢失上下文。

---

## 五、记忆模型选型：2 状态 vs 7 状态

**小白**：记忆系统为什么只有 tentative 和 kept 两个状态？

**架构师**：之前的 7 态模型（tentative / local_only / manual_only / candidate_on_reuse / wiki_candidate / published / discarded）太复杂了。实际使用中，local_only 和 manual_only 没有语义差异，candidate_on_reuse 和 wiki_candidate 的提权路径也几乎没人用。简化为 2 态后，代码量减半，认知负担大幅降低。

```
tentative ──用户确认──→ kept（永久保留）
    │
    └──丢弃──→ 从数据库硬删除（不留痕迹）
```

**选择**：tentative / kept 二态模型

**优势**：
- 认知负担低：只有两种状态，新人一眼看懂
- 代码简洁：状态转换逻辑只有一条路径
- 硬删除干净：丢弃不留痕迹，不会积累垃圾数据

**劣势**：
- 没有中间状态：不能标记"可能有用但不确定"的记忆
- 没有 wiki 提权路径：记忆不会自动变成 wiki 页面（但 wiki 由独立编译系统管理，不需要这个路径）

### 三层过滤

```
对话内容
  → Layer 1: 否定检测（"先不管""试试看""算了"→ 丢弃）
  → Layer 2: 敏感过滤（密码/密钥 → 丢弃，当前预留）
  → Layer 3: 噪声过滤（太短/太长/纯寒暄/纯代码/时间敏感内容 → 丢弃）
  → 通过 → 生成 Canonical Key（SHA1 规范化文本）
  → 检查去重（相同 canonical_key 且 active → 跳过）
  → 新内容 → tentative（临时记忆）
```

### Canonical Key SHA1 去重

`canonicalKeyForText` 对文本做 `normalizeText`（合并空白 + 去首尾 + 转小写）后计算 SHA1 hash。相同语义的记忆只存一份。

### 日写入限流

自动来源（auto_triage / auto_draft）每天最多 50 条（`LOCALMEM_DAILY_WRITE_LIMIT`）。到达限额后返回 `status: 'rate_limited'`，不写入。

### Auto-Triage 保护机制

autoTriage 在连续 5 次失败后会设置 `autoTriageDisabled = true`，后续 `/api/memory/turn` 端点会跳过 autoTriage 调用。30 分钟后自动恢复尝试。失败事件会持久化到 `memory_events` 表（`event_type: 'auto_triage_failure'`），**服务重启后会从 `memory_events` 表恢复禁用状态**，避免重启后立即重复失败。

### 待审核记忆提醒

tentative 记忆不会主动弹窗通知，但有三条提醒路径：

| 时机 | 链路 | 触发条件 |
|------|------|---------|
| 心跳 | `check-review-reminder.sh` → HEARTBEAT.md | 有 tentative 记忆 |
| 对话 | `queryMemoryFull()` → `tentative_items` | Agent 查记忆时 |
| 7天到期 | `_maybePeriodicCleanup()` → 硬删除 | 无需触发，自动执行 |

### 检索洞察注入

`queryMemoryContext` 在查询记忆时，会自动将检索洞察注入到当前会话中（以 `[检索洞察]` 前缀的 system 消息）。洞察内容包括命中数量、新鲜度、过时警告等。每个会话每小时最多注入 3 条洞察，避免信息过载。

---

## 六、治理系统选型：词法匹配 vs LLM 语义比较

**小白**：保存记忆时，如果和已有记忆冲突怎么办？

**架构师**：`governance.js` 负责冲突检测和策略规划。分两步：

### 第一步：四维重叠检测

判断新记忆和已有记忆是否属于"同一主题"：

| 维度 | 权重 | 检测方式 |
|------|------|---------|
| alias 重叠 | 0.35 | 别名集合是否有交集 |
| path 重叠 | 0.25 | path_hints 集合是否有交集 |
| collection 重叠 | 0.15 | collection_hints 集合是否有交集 |
| token 重叠 | 0.10 | 分词后 token 集合交集 ≥ 3 个，或交集 ≥ 2 个且占比 ≥ 25% |
| 文本包含 | 0.15 | 一方内容是否包含另一方 |

**小白**：token 重叠为什么阈值是 3？

**架构师**：之前阈值是 2，但中文分词后"决定使用Python"和"决定不使用Python"共享"决定"和"使用"两个 token，被误判为同主题。提高到 3 后大幅减少误报。2 个 token 重叠时，额外检查重叠比例（≥ 25%），避免短文本的偶然重叠。

### 第二步：策略选择

| 策略 | 触发条件 | 行为 |
|------|---------|------|
| `keep_existing` | 同主题 + 语义相同 | 保留旧记忆，不写入新记忆 |
| `supersede_existing` | 同主题 + 新内容更完整 | 新记忆替代旧记忆（旧记忆归档） |
| `resolve_conflict` | 同主题 + 语义冲突 | 保留旧记忆，标记新记忆为冲突 |
| `create_new` | 不同主题 | 直接创建新记忆 |

### LLM 语义比较

**小白**：怎么判断"语义相同"还是"语义冲突"？

**架构师**：有两种模式：

1. **词法匹配**（默认）：基于 token 重叠和文本包含判断。不需要 LLM，速度快，但可能误判
2. **LLM 语义比较**（可选）：调用侧边 LLM 网关，让 LLM 判断两条记忆是否表达同一意图

**选择**：词法匹配为主 + LLM 语义兜底

**优势**：
- 默认零依赖：不配置 LLM 网关也能正常工作
- 优雅降级：LLM 不可用时自动降级为词法匹配
- 可选增强：配置 LLM 网关后语义判断更准确

**劣势**：
- 词法匹配可能误判（"决定用 A" vs "决定不用 A" 会被判为同主题）
- LLM 调用增加延迟（10 秒超时保护）
- LLM 返回格式不稳定（代码做了容错解析）

LLM 返回 JSON 格式 `{"sameIntent": true/false, "confidence": 0.0-1.0}`。代码会严格解析布尔值——`true` 或字符串 `"true"` 都视为真，其他值视为假。LLM 调用有 10 秒超时保护，超时自动降级为词法匹配。

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|---------|--------|------|
| 侧边 LLM 网关 | `SIDE_LLM_GATEWAY_URL` | 空（不启用） | 如 `http://127.0.0.1:11434` |
| 侧边 LLM 模型 | `SIDE_LLM_GATEWAY_MODEL` | `k2p6` | 网关默认模型名 |

---

## 七、Wiki 编译选型：LLM Wiki vs 传统 RAG

**小白**：LLM Wiki 具体怎么工作的？

**架构师**：四步走：

1. **detectChanges**：扫描 `raw-sources.json` 中定义的所有源文件，对比 SHA256 hash，找出新增/修改/删除
2. **编译**：Agent 用自己的 LLM 能力将原始材料编译为结构化 wiki 页面（不是复制！）
3. **saveWikiPage**：保存到 wiki/ 目录，更新 manifest
4. **updateIndex**：刷新 wiki/index.md 总索引

**小白**：为什么不让中间层自己调 LLM？

**架构师**：因为中间层不应该持有 API Key，也不应该决定怎么编译。编译策略由 Agent 决定，中间层只负责文件扫描和状态管理。这样编译提示、质量标准、LLM 模型选择都是可插拔的。

**选择**：Karpathy LLM Wiki 模式

**优势**：
- 人可读：wiki 页面是标准 Markdown，人类可以直接阅读和编辑
- 机可查：Agent 可以用 `wiki_search` 搜索结构化知识
- 易维护：只需要维护 Markdown 文件，不需要维护向量数据库
- 知识生长：持续编译完善，而不是被动检索

**劣势**：
- 编译需要 LLM：如果 LLM 不可用，wiki 无法自动更新
- 搜索精度有限：关键词匹配不如向量检索的语义理解
- 页面数量受限：超过 200 页后需要升级为 BM25

### 增量编译

Manifest 记录每个源文件的 SHA256 hash。下次 `detectChanges` 时对比 hash，只标记新增/修改的文件。Agent 只编译有变化的文件。

### 人工编辑保护

Wiki 页面支持人工编辑区域，不会被增量编译覆盖：

```markdown
<!-- human-edit-start:SECTION_NAME -->
这里是你自己写的笔记、补充、心得，编译时不会被覆盖。
<!-- human-edit-end:SECTION_NAME -->
```

编译时 `_mergeHumanEdits` 会：
- 从旧文件中提取所有 `human-edit` 区域
- 如果新内容中有同名区域，旧内容替换新内容中的占位
- 如果新内容中没有该区域，旧区域追加到文件末尾

### 路径安全验证

- `_normalizeWikiPageName`：拒绝绝对路径、路径遍历（`..`）、非 `.md` 后缀
- `_resolveAllowedSourcePath`：验证 sourcePath 必须在 `raw-sources.json` 配置的文件列表中

---

## 八、日志选型：Winston vs Pino

**小白**：项目里同时用了 Winston 和 Pino，为什么？

**架构师**：它们各管各的：

| 日志库 | 用途 | 位置 |
|--------|------|------|
| Winston | 业务逻辑日志（记忆操作、wiki 编译、定时清理等） | `config.js` 导出的 `logger` |
| Pino | HTTP 请求日志（Fastify 内置） | Fastify 自动管理 |

**选择**：Winston（主日志）+ Pino（Fastify 内置）

**Winston 优势**：
- 丰富的传输层：Console、File、HTTP 等
- 自定义格式：时间戳 + 级别 + 消息
- 文件日志保留策略：`buildRetainedLogHandler` 支持按天数和大小轮转

**Winston 劣势**：
- 性能不如 Pino（但业务日志频率低，不影响）
- 配置比 Pino 复杂

**Pino 优势**：
- 最快的 Node.js 日志库
- Fastify 内置，零配置
- 结构化 JSON 输出，方便日志分析

**Pino 劣势**：
- 自定义格式不如 Winston 灵活
- 文件传输需要额外配置

---

## 九、配置管理选型：dotenv + 环境变量 vs 配置文件

**小白**：配置为什么用环境变量而不是 JSON/YAML 配置文件？

**架构师**：

| 维度 | 环境变量 | 配置文件 |
|------|---------|---------|
| 部署灵活性 | 容器/系统原生支持 | 需要额外挂载 |
| 敏感信息 | 不容易意外提交 | 容易误提交密钥 |
| 类型安全 | 需要手动解析（parseInt 等） | JSON 原生类型 |
| 默认值 | 代码中定义 | 文件中定义 |

**选择**：dotenv + 环境变量

**优势**：
- 12-Factor App 标准做法
- 敏感信息（API_SECRET、LLM 网关地址）不进代码仓库
- 容器部署时直接注入环境变量
- 默认值在代码中定义，不需要额外配置文件

**劣势**：
- 类型需要手动解析（`parseInt(process.env.HTTP_PORT || '8901', 10)`）
- 没有配置校验（错误的环境变量值在运行时才报错）
- 环境变量名容易拼错（但代码中集中定义了常量，避免直接使用字符串）

### prepareRuntimePath 旧路径迁移机制

`config.js` 的 `prepareRuntimePath` 函数实现了旧路径自动迁移到 `runtime/` 目录：

1. 优先使用 `runtime/` 目录下的路径
2. 如果 `runtime/` 下不存在但旧路径存在，自动 `rename`（跨文件系统时用 `cpSync` + `rmSync`）
3. 如果都不存在，返回 `runtime/` 下的目标路径

这样从旧版本升级时，数据文件会自动迁移到新位置，不需要手动操作。

---

## 十、认证方案选型：Bearer Token + Unix Socket 自动注入

**小白**：API 认证是怎么做的？

**架构师**：轻量级 Bearer Token 方案：

- 配置 `OPENCLAW_API_SECRET` 环境变量后，所有 HTTP 请求必须携带 `Authorization: Bearer <secret>` 头
- 未配置时跳过认证（兼容现有部署）
- 未配置时启动会打印警告

**选择**：轻量级 Bearer Token

**优势**：
- 实现简单：Fastify `onRequest` hook，10 行代码
- 兼容性好：未配置时自动跳过，不影响现有部署
- Unix Socket 自动注入：本地工具通过 Unix Socket 连接时不需要手动传 Token

**劣势**：
- 没有 OAuth2/JWT 那样的细粒度权限控制
- Token 是静态的，没有过期机制
- 没有 RBAC（所有端点同一权限）

### Unix Socket 透明代理

`index.js` 实现了 TCP 透明代理，让 Unix Socket 客户端无需手动传 Token：

```
Unix Socket 客户端 → 透明代理（自动注入 Bearer Token）→ Fastify HTTP 服务
```

代理机制：
1. 监听 Unix Domain Socket（默认 `/tmp/openclaw-engine.sock`）
2. 收到客户端连接后，解析 HTTP 请求头
3. 如果客户端已携带 `Authorization` 头，拒绝（防止 Token 冲突）
4. 自动注入 `Authorization: Bearer ${API_SECRET}` 头
5. 将修改后的请求转发到 Fastify HTTP 端口
6. 响应原路返回

这样本地工具（如 `cec` 命令）通过 Unix Socket 连接时不需要知道 API Secret，而远程客户端通过 HTTP 连接时必须提供 Token。

### 路径遍历防护

`import-transcript` 端点使用 `isPathInsideRoot()` 验证文件路径：
- 解析为绝对路径后检查是否在允许的根目录内
- 防止 `../../etc/passwd` 等路径遍历攻击
- 只允许 `.md`、`.json`、`.jsonl` 文件

---

## 十一、基准测试框架选型：自建 vs 外部框架

**小白**：基准测试为什么自己写，不用 Vitest/Jest 的 benchmark 功能？

**架构师**：因为我们需要测试的是**搜索质量**（命中率、召回率、多样性），不是代码性能。Vitest/Jest 的 benchmark 测的是执行速度，不是搜索准确度。

**选择**：自建轻量框架

**优势**：
- 零依赖：不需要额外测试框架
- 专注搜索质量：命中率、召回率、多样性三个核心指标
- 双格式报告：JSON + Markdown，方便人工阅读和程序解析
- 灵活运行：HTTP API 和 CLI 两种方式

**劣势**：
- 没有统计显著性检验（但样本量小，不需要）
- 没有历史趋势对比（但 JSONL 文件可以手动对比）
- 场景定义是手写的 JSON（但数量少，维护成本低）

### 框架组成

| 模块 | 文件 | 职责 |
|------|------|------|
| Scenario | `benchmark/scenario.js` | 定义测试用例（BenchmarkCase）和套件（ScenarioSuite） |
| Harness | `benchmark/harness.js` | 运行套件、调用搜索函数、收集结果 |
| Metrics | `benchmark/metrics.js` | 计算命中率、召回率、Jaccard 多样性 |
| Reporting | `benchmark/reporting.js` | 生成 JSON + Markdown 双格式报告 |
| Facade | `facades/benchmark.js` | 记录结果、查询历史、文件轮转 |

### Jaccard 相异度

**小白**：为什么用 Jaccard 相异度算多样性？

**架构师**：Jaccard 相异度 = 1 - Jaccard 相似度。它衡量两个搜索结果之间的词汇差异——如果所有结果都说一样的话，多样性为 0；如果每个结果都不同，多样性为 1。

**优势**：
- 零依赖，纯 Set 运算
- 语义直观：值越高 = 结果越多样化
- 对中文友好：基于字符级分词（`[a-z0-9\u4e00-\u9fff]+`）

**劣势**：
- 只考虑词汇重叠，不考虑语义相似性（"开心"和"高兴"被视为完全不同）
- 对短文本不够敏感（两句话只差一个字，Jaccard 可能接近 0）

---

## 十二、技术选型原则总结

1. **务实优先**：关键词匹配 + SQLite 是经过验证的技术，不需要 GPU
2. **最小依赖**：单服务架构，不依赖 ChromaDB/Python 服务，不依赖 BM25 索引库
3. **人机协作**：LLM Wiki 的 Markdown 格式让人和 AI 都能读写
4. **可观测性**：健康检查、结构化日志、Metrics 端点——出问题要知道哪里坏了
5. **简化优先**：2 态记忆模型比 7 态好维护，不建索引比建索引好调试
6. **优雅降级**：LLM 语义比较不可用时自动降级为词法匹配，不会阻塞主流程
7. **安全默认**：路径遍历防护、Bearer Token 认证、Unix Socket 自动注入
8. **数据安全**：Graceful Shutdown 确保 WAL 数据不丢失，uncaughtException 紧急 checkpoint

---

## 附录 A：速查卡（出问题先看哪里）

| 问题现象 | 排查方式 |
|---------|---------|
| Wiki 搜不到结果 | 调用 MCP 工具 `wiki_detect_changes` 检查是否需要编译 |
| 服务起不来 | `journalctl --user -u openclaw-context-engine.service` |
| Wiki 没编译 | 调用 MCP 工具 `wiki_check_stale` |
| 磁盘满了 | `du -sh ./runtime/` |
| 记忆搜不到 | 检查 `memory_items` 表中的 `status` 和 `content` |
| WAL 膨胀 | `curl http://127.0.0.1:8901/metrics` 查看 `process.external_mb` |
| 服务无响应 | `curl http://127.0.0.1:8901/api/health/ready` 检查是否存活 |
| 性能下降 | 检查 metrics 中 `requests_total` 与 `errors_total` 比例 |
| 治理误判 | 检查 `SIDE_LLM_GATEWAY_URL` 是否配置，未配置时仅用词法匹配 |
| Benchmark 崩溃 | 检查 `config/benchmark-scenarios/` 目录是否存在场景文件 |
| autoTriage 不工作 | 检查 `memory_events` 表是否有 `auto_triage_failure` 事件 |
| Unix Socket 连不上 | 检查 `/tmp/openclaw-engine.sock` 是否存在，权限是否 0600 |
| 认证失败 | 检查 `OPENCLAW_API_SECRET` 是否配置，Bearer Token 是否正确 |

---

## 附录 B：环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_HOST` | `127.0.0.1` | HTTP 绑定地址 |
| `HTTP_PORT` | `8901` | HTTP 端口 |
| `HTTP_SOCKET_PATH` | `/tmp/openclaw-engine.sock` | Unix Socket 路径（为空时禁用） |
| `OPENCLAW_API_SECRET` | 空 | API 认证密钥（空时不校验） |
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

---

## 附录 C：依赖清单与选择原因

| 依赖 | 版本 | 选择原因 |
|------|------|---------|
| `fastify` | ^4.26.0 | HTTP 框架，性能优于 Express，内置验证和日志 |
| `better-sqlite3` | ^9.4.0 | SQLite 绑定，同步 API，WAL 模式支持，零部署 |
| `winston` | ^3.17.0 | 业务日志，丰富的传输层和格式化选项 |
| `pino` | ^8.19.0 | Fastify 内置 HTTP 日志，性能最优 |
| `dotenv` | ^16.4.0 | 环境变量加载，12-Factor App 标准做法 |
| `uuid` | ^9.0.1 | UUID 生成，用于记忆 ID、会话 ID 等 |
| `zod` | ^3.22.4 | Schema 验证（当前未深度使用，预留扩展） |
| `eslint` | ^8.57.0 | 代码质量检查（devDependency） |

---

*本文档最后更新：2026-05-01*
*反映 localMem + LLM Wiki 双引擎架构（已移除 BM25/static_kb）*
*新增：认证方案、日志选型、配置管理、基准测试框架、中文 bigram 扩展搜索、检索洞察注入、人工编辑保护、数据库迁移版本控制、Prepared Statement 缓存、Unix Socket 代理、路径遍历防护、Graceful Shutdown*
*2026-05-01 更新：governance token overlapRatio 阈值从 40% 降至 25%、autoTriage previous_content 修复、Wiki 索引空数组 Bug 修复、_isKnowledgeAssertion 字数阈值从 30 降至 15*
