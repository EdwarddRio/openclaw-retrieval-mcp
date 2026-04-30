# OpenClaw Context Engine 技术深度解析

> 本文采用"技术小白提问 + 架构师回答"的对话形式，逐层剥开 `openclaw-engine-js` 的设计决策。
>
> 目标读者：对技术感兴趣的产品/运维人员，以及刚接触本项目的开发者。
> 阅读建议：如果某节看不懂，跳过不影响理解其他节——每节相对独立。

---

## 人物设定

- **小白**：刚入职的后端新人，会写 Node.js，对 AI 和知识检索完全没概念
- **架构师**：十年经验，负责本项目核心架构，说话直率

---

## 零、关键设计决策：为什么放弃向量检索和 BM25 分块索引

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

## 一、整体架构：localMem + LLM Wiki 双引擎

**小白**：项目里有两个知识系统——localMem 和 LLM Wiki，为什么不合并？

**架构师**：它们解决不同的问题。localMem 是"记忆"——自动从对话中提取、用完可能丢弃的短期信息。LLM Wiki 是"知识"——由 LLM 编译、人工可审核的长期结构化文档。

```
┌─────────────────────────────────────────────┐
│           KnowledgeBase (Facade)              │
│                                              │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │   localMem   │  │     LLM Wiki         │  │
│  │              │  │                      │  │
│  │  SQLite      │  │  raw → wiki 编译     │  │
│  │  2-state:    │  │  SHA256 增量检测      │  │
│  │  tentative   │  │  [[交叉引用]]         │  │
│  │  kept        │  │  人机协作维护         │  │
│  └──────────────┘  └──────────────────────┘  │
│                                              │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Governance  │  │    Benchmark         │  │
│  │  冲突检测     │  │    Harness+Scenario  │  │
│  │  LLM语义比较  │  │    Metrics+Report    │  │
│  └──────────────┘  └──────────────────────┘  │
│                                              │
│  搜索路由：                                   │
│  知识问题 → wiki_search（关键词匹配）          │
│  记忆问题 → query_memory（SQLite LIKE）        │
│  文件/代码 → Agent 的文件系统工具              │
└─────────────────────────────────────────────┘
```

---

## 二、搜索实现：两个简单但够用的方案

**小白**：为什么不建索引？BM25 不是更快吗？

**架构师**：建索引的前提是数据量大到简单扫描不够用。我们的数据量：

| 搜索目标 | 数据量 | 搜索方式 | 耗时 |
|---------|--------|---------|------|
| Wiki 页面 | ~24 页，约 200KB | 读 .md → 标题×5 + 内容计数 | <5ms |
| 记忆条目 | 几百条 | SQL LIKE 多 token AND | <1ms |

**wiki_search 实现**：

```javascript
// 遍历所有 wiki 页面，对每个搜索词：
score += titleMatchCount * 5 + contentMatchCount;
// 返回 score > 0 的页面，按 score 降序
```

为什么不用 BM25？三个原因：
1. **24 页太少**，BM25 的 IDF（逆文档频率）区分度极低——每个词几乎都只出现在 1-2 个页面里，IDF 值几乎相同
2. **返回整页不是 chunk**，BM25 的核心优势是 chunk 级精确匹配，但 wiki 返回整页，这个优势用不上
3. **零依赖零状态**，不需要建索引、不需要缓存文件、不需要增量同步

**query_memory 实现**：

```sql
-- 每个 token 必须出现在 content 中
SELECT * FROM memory_items 
WHERE content LIKE '%token1%' AND content LIKE '%token2%'
ORDER BY updated_at DESC LIMIT topK
```

搜索结果按 `computeRelevanceScore` 加权排序，使用统一权重常量 `RELEVANCE_WEIGHTS`（定义在 `models.js`）：

**搜索排序权重** (`RELEVANCE_WEIGHTS.search`)：
- **命中率 (hitRate)** 50%：查询词在内容中的命中比例
- **位置 (position)** 20%：命中词出现位置越靠前分越高
- **频次 (count)** 15%：记忆被查询命中的历史次数（从 `unique_query_hashes` 字段计算）
- **新鲜度 (freshness)** 15%：越新的记忆分越高

**置信度权重** (`RELEVANCE_WEIGHTS.confidence`)：
- **命中率 (hitRate)** 40% / **位置 (position)** 20% / **频次 (count)** 20% / **新鲜度 (freshness)** 20%

```javascript
// computeRelevanceScore 加权公式（搜索模式）
score = hitRate * 0.5 + positionScore * 0.2 + countScore * 0.15 + freshnessScore * 0.15
```

**小白**：频次维度是怎么计算的？

**架构师**：每次查询命中一条记忆时，`addQueryHash()` 会把查询的哈希值追加到 `unique_query_hashes` 字段。`_rowToMemory()` 从这个字段计算 `_hitCount`，然后 `computeRelevanceScore` 用 `Math.min(1, _hitCount / 3)` 归一化——被 3 次以上不同查询命中的记忆，频次维度得满分。

**小白**：置信度是怎么计算的？

**架构师**：`_computeConfidence` 取前 3 个命中结果的 `computeRelevanceScore` 平均分。这样即使第一个命中较弱，但后续命中较强时，置信度不会太低，避免不必要的弃权。

为什么不用 FTS5？SQLite FTS5 的默认分词器不支持中文（没有空格分隔），测试后发现 LIKE 查询对中文更可靠。

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
> | 依赖 | 无 | `bm25Okapi` npm 包（或内联实现，参考 `src/benchmark/metrics.js` 中的 `tokenize`） |
>
> 关键设计决策：即使升级 BM25，仍返回**整页**而非 chunk。wiki 页面本身就是编译好的结构化文档，切碎会丢失上下文。BM25 的价值在于利用 IDF 提高大语料下的召回率，而非 chunk 级精确匹配。

---

## 三、LLM Wiki 编译：raw → wiki 的增量编译

**小白**：LLM Wiki 具体怎么工作的？

**架构师**：四步走：

1. **detectChanges**：扫描 `raw-sources.json` 中定义的所有源文件，对比 SHA256 hash，找出新增/修改/删除
2. **编译**：Agent 用自己的 LLM 能力将原始材料编译为结构化 wiki 页面（不是复制！）
3. **saveWikiPage**：保存到 wiki/ 目录，更新 manifest
4. **updateIndex**：刷新 wiki/index.md 总索引

**小白**：为什么不让中间层自己调 LLM？

**架构师**：因为中间层不应该持有 API Key，也不应该决定怎么编译。编译策略由 Agent（也就是你）决定，中间层只负责文件扫描和状态管理。这样编译提示、质量标准、LLM 模型选择都是可插拔的。

**小白**：wiki 页面删了怎么办？

**架构师**：只要 manifest 不丢，重新运行 `wiki_detect_changes` 就会检测到文件未编译，重新触发编译流程。而且 wiki 页面是标准 Markdown，人类可以直接编辑。

**小白**：搜索缓存怎么管理？

**架构师**：`WikiCompiler` 内部维护一个 5 分钟 TTL 的搜索缓存。当 `saveWikiPage` 或 `removeWikiPage` 被调用时，缓存会主动失效。但如果是外部直接编辑了 wiki 文件（比如手动改 .md），缓存不会感知——需要等 TTL 过期或调用 `saveWikiPage` 触发刷新。

---

## 四、记忆系统：三层过滤 + 2 状态 + Canonical Key 去重

**小白**：记忆系统是怎么决定"这段话要不要记下来"的？

**架构师**：三层过滤：

```
对话内容
  → Layer 1: 否定检测（"先不管""试试看""算了"→ 丢弃）
  → Layer 2: 敏感过滤（密码/密钥 → 丢弃，当前预留）
  → Layer 3: 噪声过滤（太短/太长/纯寒暄/纯代码 → 丢弃）
  → 通过 → 生成 Canonical Key（SHA1 规范化文本）
  → 检查去重（相同 canonical_key 且 active → 跳过）
  → 新内容 → tentative（临时记忆）
```

2 状态模型：

- `tentative`：临时，7 天未确认自动清理（硬删除，不留痕迹）
- `kept`：永久，用户确认后保留
- 丢弃 = 硬删除（从 SQLite DELETE）

**Auto-Triage 保护机制**：

autoTriage 在连续 5 次失败后会设置 `autoTriageDisabled = true`，后续 `/api/memory/turn` 端点会跳过 autoTriage 调用（而非继续调用后必然失败）。30 分钟后自动恢复尝试。失败事件会持久化到 `memory_events` 表（`event_type: 'auto_triage_failure'`），**服务重启后会从 `memory_events` 表恢复禁用状态**，避免重启后立即重复失败。

**小白**：tentative 记忆会提醒我吗？7天就静默删了？

**架构师**：不是完全静默。中间层自己不会弹通知，但有一个**心跳兜底脚本** `check-review-reminder.sh` 做被动提醒：

```
心跳触发（每 6 小时）→ 跑 check-review-reminder.sh
  → 查 SQLite: SELECT ... WHERE state = 'tentative' AND status = 'active'
  → 有结果 → 输出提醒文本，心跳不回 HEARTBEAT_OK，而是推送给你
  → 无结果 → 输出空，心跳正常结束
```

另外，`queryMemoryFull()` 返回结果里会附带 `tentative_items` 列表，Agent 在对话中也可以提醒你。

所以提醒有两条路：

| 时机 | 链路 | 触发条件 |
|------|------|---------|
| 心跳 | `check-review-reminder.sh` → HEARTBEAT.md | 有 tentative 记忆 |
| 对话 | `queryMemoryFull()` → `tentative_items` | Agent 查记忆时 |
| 7天到期 | `_maybePeriodicCleanup()` → 硬删除 | 无需触发，自动执行 |

**小白**：为什么不用 FTS5？

**架构师**：之前的 7 态模型（tentative / local_only / manual_only / candidate_on_reuse / wiki_candidate / published / discarded）太复杂了。实际使用中，local_only 和 manual_only 没有语义差异，candidate_on_reuse 和 wiki_candidate 的提权路径也几乎没人用。简化为 2 态后，代码量减半，认知负担大幅降低。

---

## 五、治理系统（Governance）：冲突检测 + LLM 语义比较

**小白**：保存记忆时，如果和已有记忆冲突怎么办？

**架构师**：`governance.js` 负责冲突检测和策略规划。分两步：

### 第一步：四维重叠检测

判断新记忆和已有记忆是否属于"同一主题"：

| 维度 | 权重 | 检测方式 |
|------|------|---------|
| alias 重叠 | 0.35 | 别名集合是否有交集 |
| path 重叠 | 0.25 | path_hints 集合是否有交集 |
| collection 重叠 | 0.15 | collection_hints 集合是否有交集 |
| token 重叠 | 0.10 | 分词后 token 集合交集 ≥ 3 个，或交集 ≥ 2 个且占比 ≥ 40% |
| 文本包含 | 0.15 | 一方内容是否包含另一方 |

**小白**：token 重叠为什么阈值是 3？

**架构师**：之前阈值是 2，但中文分词后"决定使用Python"和"决定不使用Python"共享"决定"和"使用"两个 token，被误判为同主题。提高到 3 后大幅减少误报。2 个 token 重叠时，额外检查重叠比例（≥ 40%），避免短文本的偶然重叠。

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

LLM 语义比较需要配置 `SIDE_LLM_GATEWAY_URL` 环境变量。如果未配置，治理系统只使用词法匹配。

**小白**：LLM 返回的结果怎么解析？

**架构师**：LLM 返回 JSON 格式 `{"sameIntent": true/false, "confidence": 0.0-1.0}`。代码会严格解析布尔值——`true` 或字符串 `"true"` 都视为真，其他值视为假。这样无论 LLM 返回布尔还是字符串都能正确处理。

**小白**：LLM 调用会不会卡住？

**架构师**：有 10 秒超时保护。如果 LLM 网关在 10 秒内没有响应，会自动降级为词法匹配，不会阻塞 autoTriage 流程。

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|---------|--------|------|
| 侧边 LLM 网关 | `SIDE_LLM_GATEWAY_URL` | 空（不启用） | 如 `http://127.0.0.1:11434` |
| 侧边 LLM 模型 | `SIDE_LLM_GATEWAY_MODEL` | `k2p6` | 网关默认模型名 |

---

## 六、增量同步：Manifest 指纹机制

**小白**：文件改了之后，wiki 怎么知道要重新编译？

**架构师**：用 Manifest 做变更检测。每个源文件记录 SHA256 hash。下次 `detectChanges` 时对比 hash，只标记新增/修改的文件。Agent 只编译有变化的文件。

Manifest 同时记录每个源文件对应的 wiki 页面名（`wikiPage`）和来源 ID（`sourceId`），实现源文件 → wiki 页面的映射。

---

## 七、基准测试框架（Benchmark）

**小白**：基准测试是干什么的？

**架构师**：用来量化搜索质量。定义一组测试用例（查询 + 期望命中），运行后计算命中率、召回率和多样性。

### 框架组成

| 模块 | 文件 | 职责 |
|------|------|------|
| Scenario | `benchmark/scenario.js` | 定义测试用例（BenchmarkCase）和套件（ScenarioSuite） |
| Harness | `benchmark/harness.js` | 运行套件、调用搜索函数、收集结果 |
| Metrics | `benchmark/metrics.js` | 计算命中率、召回率、Jaccard 多样性 |
| Reporting | `benchmark/reporting.js` | 生成 JSON + Markdown 双格式报告 |
| Facade | `facades/benchmark.js` | 记录结果、查询历史 |

### 技术选择

**小白**：为什么用 Jaccard 相异度算多样性？

**架构师**：Jaccard 相异度 = 1 - Jaccard 相似度。它衡量两个搜索结果之间的词汇差异——如果所有结果都说一样的话，多样性为 0；如果每个结果都不同，多样性为 1。计算简单，不需要额外依赖。

**优势**：
- 零依赖，纯 Set 运算
- 语义直观：值越高 = 结果越多样化
- 对中文友好：基于字符级分词（`[a-z0-9\u4e00-\u9fff]+`）

**劣势**：
- 只考虑词汇重叠，不考虑语义相似性（"开心"和"高兴"被视为完全不同）
- 对短文本不够敏感（两句话只差一个字，Jaccard 可能接近 0）

**小白**：场景文件放在哪？

**架构师**：`config/benchmark-scenarios/` 目录下，JSON 格式。每个文件是一个套件，包含多个用例。`discoverScenarioSuites()` 自动扫描该目录。

### 运行方式

1. **HTTP API**：`POST /api/benchmarks/run` — 通过 `KnowledgeBase.runBenchmark()` 创建 Harness 实例并运行
2. **CLI**：`node src/benchmark/cli.js` — 命令行直接运行，不依赖 HTTP 服务

---

## 八、健康检查：三级状态 + 数据库可观测性

**小白**：健康检查不就是"通/不通"吗？

**架构师**：太简单了。我们的三级状态：

- `ready`：一切正常
- `stale`：功能正常，但有需要注意的事项（benchmark 过期等）
- `degraded`：部分功能受影响（localMem 异常等）

而且健康检查现在会暴露数据库状态：
- **WAL 大小**：如果 WAL 文件膨胀超过 10MB，自动触发 checkpoint 截断
- **表完整性**：验证 sessions / turns / memory_items / memory_events / memory_aliases 五张核心表是否存在
- **Statement Cache**：高频 SQL 使用 prepared statement 缓存，避免重复编译
- **Benchmark 过期检测**：超过 24 小时未运行基准测试时，`stale_flags` 中会出现 `benchmark_stale`
- **Review 队列积压**：待审核记忆超过 10 条时，`stale_flags` 中会出现 `review_queue_backlog`

```
/api/health 返回示例
{
  "status": "ready",
  "localmem": {
    "healthy": true,
    "stats": { "total": 47, "active": 45, ... },
    "db": {
      "wal_size_mb": 0.16,
      "tables": ["sessions", "turns", ...]
    }
  },
  ...
}
```

---

## 九、Agent 搜索路由：什么时候查 localMem，什么时候查 Wiki

**小白**：我现在提问时，Agent 到底会搜哪里？localMem 还是 Wiki？

**架构师**：取决于你的问题类型。中间层暴露了两套搜索工具，Agent 按场景选择：

```
用户提问
  ├─ "之前说的那个方案？" → query_memory → 搜 localMem（SQLite LIKE）
  ├─ "V8引擎的GC策略？" → wiki_search → 搜 LLMWiki（关键词匹配）
  ├─ "配置文件在哪？"     → 直接读文件（read_file, search_content）
  └─ 混合问题             → 两个都搜，结果合并
```

**小白**：为什么不全走一个？

**架构师**：因为它们存的东西本质不同：

| 维度 | localMem | LLM Wiki |
|------|---------|----------|
| 存什么 | 对话中提取的**记忆碎片** | 从原始材料编译的**结构化知识** |
| 谁写入 | 自动提取 / 用户确认 | Agent 用 LLM 编译 |
| 生命周期 | tentative 7天 → kept 永久 | 永久，随源文件更新 |
| 搜索方式 | SQLite LIKE | 关键词匹配（标题×5 + 内容） |
| MCP 工具 | `query_memory` | `wiki_search` |
| 人类可读 | 差（数据库里的碎片） | 好（Markdown 文档） |
| 典型场景 | "上次你说的…" "我的偏好是…" | "帧同步怎么做？" "JVM GC 策略" |

**小白**：wiki_search 和直接 grep 文件有什么区别？

**架构师**：`wiki_search` 搜索的是**编译后的结构化知识**，不是原始文件。原始 .md 文件可能是碎片化的笔记，wiki 页面是 LLM 提炼后的结构化文档——有目录、有交叉引用、有核心要点。而且 wiki_search 对标题加权（×5），命中精度更高。

```
grep/文件搜索 = 在原始文件中搜关键词 → 返回原始片段
wiki_search   = 在编译后wiki中搜关键词 → 返回结构化整页摘要
```

---

## 十、Wiki 编译触发：什么时候该重编译

**小白**：`wiki_check_stale` 返回 `stale: true` 是什么意思？

**架构师**：意思是 raw 源文件有了变化（新增/修改），但对应的 wiki 页面还没更新。就像代码改了但没重新编译——**源文件 ≠ 编译产物**。

**小白**：不编译会怎样？

**架构师**：wiki 页面内容不会自动更新——用户搜到的可能是过时信息。但不影响系统运行，只是知识不够新。

---

## 十一、API 层设计

**小白**：API 层为什么用 Fastify 而不是 Express？

**架构师**：三个原因：

| 维度 | Fastify | Express |
|------|---------|---------|
| 性能 | 比 Express 快 2-3 倍（JSON 序列化用 fast-json-stringify） | 够用但不是最快 |
| Schema 验证 | 内置 JSON Schema 验证 | 需要额外中间件 |
| 插件系统 | 封装性好，作用域隔离 | 中间件全局共享 |

**小白**：请求验证是怎么做的？

**架构师**：用 `validateBody` preHandler 模式。每个请求模型（如 `MemorySaveRequest`）都有 `validate()` 方法，返回 `{ valid, errors }`。验证失败时返回 400 + 错误详情，验证通过时继续路由处理。

**小白**：`session_id` 是必填的吗？

**架构师**：不是。`MemorySaveRequest` 的 `session_id` 是可选的——很多场景（如手动保存一条独立记忆）没有会话上下文。但 `content` 是必填的。

**小白**：`queryMemoryFull` 的 `sessionId` 参数有用吗？

**架构师**：当前未实现会话范围过滤——所有记忆查询都是全局的。`sessionId` 参数已暴露但未生效，保留供未来扩展。如果你需要限定查询范围，目前需要在客户端侧过滤结果。

---

## 十二、技术选型原则

1. **务实优先**：关键词匹配 + SQLite 是经过验证的技术，不需要 GPU
2. **最小依赖**：单服务架构，不依赖 ChromaDB/Python 服务，不依赖 BM25 索引库
3. **人机协作**：LLM Wiki 的 Markdown 格式让人和 AI 都能读写
4. **可观测性**：健康检查、结构化日志——出问题要知道哪里坏了
5. **简化优先**：2 态记忆模型比 7 态好维护，不建索引比建索引好调试
6. **优雅降级**：LLM 语义比较不可用时自动降级为词法匹配，不会阻塞主流程

---

## 附录：速查卡

### 出问题先看哪里

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

### 环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_HOST` | `127.0.0.1` | HTTP 绑定地址 |
| `HTTP_PORT` | `8901` | HTTP 端口 |
| `HTTP_SOCKET_PATH` | `/tmp/openclaw-engine.sock` | Unix Socket 路径 |
| `OPENCLAW_API_SECRET` | 空 | API 认证密钥 |
| `PROJECT_ROOT` | `../workspace` | 工作区根目录 |
| `SIDE_LLM_GATEWAY_URL` | 空 | 侧边 LLM 网关地址（用于治理语义比较） |
| `SIDE_LLM_GATEWAY_MODEL` | `k2p6` | 侧边 LLM 网关默认模型 |
| `LOCALMEM_DAILY_WRITE_LIMIT` | `50` | 自动来源每日写入上限 |
| `LOCALMEM_FACT_MAX_AGE_DAYS` | `180` | 事实记忆最大保留天数 |
| `LOCALMEM_SESSION_MAX_AGE_DAYS` | `60` | 会话最大保留天数 |

---

*本文档最后更新：2026-04-30*
*反映 localMem + LLM Wiki 双引擎架构（已移除 BM25/static_kb）*
*新增：SIDE_LLM_GATEWAY 配置、Governance LLM 语义比较、Benchmark 框架、_computeConfidence 多 hit 平均、token 重叠阈值优化*
