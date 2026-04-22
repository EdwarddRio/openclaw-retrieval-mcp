# OpenClaw Context Engine 技术深度解析

> 本文采用"技术小白提问 + 架构师回答"的对话形式，逐层剥开 `openclaw-engine-js` 的设计决策。
>
> 目标读者：对技术感兴趣的产品/运维人员，以及刚接触本项目的开发者。
> 阅读建议：如果某节看不懂，跳过不影响理解其他节——每节相对独立。

---

## 人物设定

- **小白**：刚入职的后端新人，会写 Node.js，对 AI 和向量检索完全没概念，喜欢问"为什么"
- **架构师**：十年经验，负责本项目核心架构，说话直率，喜欢画 ASCII 图解释原理

---

## 零、README 遗漏清单：那些文档没告诉你但代码里真实存在的设计

在深入每个模块之前，先列一张"README 没说的秘密清单"。这些设计在 README 里要么一笔带过，要么完全没提，但它们恰恰是系统能稳定运行的关键：

| # | 设计点 | README 提到？ | 实际影响 |
|---|--------|-------------|---------|
| 1 | **7 类查询意图分类** | 否 | 决定向量/BM25 权重分配，直接影响搜索质量 |
| 2 | **查询变体扩展（Query Variants）** | 否 | 一个查询拆成 6 个变体分别搜索，结果加权融合 |
| 3 | **两阶段 RRF 融合** | 否 | 先组内融合（向量+BM25），再跨变体融合 |
| 4 | **MMR 最大边际相关性去重** | 否 | 用 Jaccard 相似度检测重复内容，提升结果多样性 |
| 5 | **30+ 参数的可配置评分系统** | 否 | 所有权重可通过环境变量微调，无需改代码 |
| 6 | **双管道分词器（中文+英文+CJK n-gram）** | 否 | 中文用 jieba，英文用词干提取，CJK 生成 2-gram/3-gram |
| 7 | **记忆三层过滤（Triage）** | 否 | 否定检测、敏感信息过滤、噪声过滤 |
| 8 | **Canonical Key SHA1 去重** | 否 | 相同语义的记忆只存一份 |
| 9 | **FTS5 全文搜索 + 触发器同步** | 否 | SQLite 内置全文索引，INSERT/UPDATE/DELETE 自动同步 |
| 10 | **Eager vs Lazy 索引加载策略** | 否 | 规则文档启动即加载，代码库首次查询时才加载 |
| 11 | **Manifest 增量同步** | 否 | 基于文件指纹（mtime+sha1）的变更检测，避免全量重建 |
| 12 | **Indexer 双源恢复机制** | 否 | 本地 JSON 缓存损坏时，自动从 ChromaDB 恢复 |
| 13 | **BM25 自研 JS 实现（200 行）** | 否 | 基于 rank_bm25 算法，支持负 IDF 平滑 |
| 14 | **规则文档优先级加成** | 否 | 含"规则""规范""约定"的查询自动提升规则文档排名 |
| 15 | **记忆状态机（7 状态）** | 否 | tentative / local_only / manual_only / candidate_on_reuse / wiki_candidate / published / discarded |
| 16 | **每日写入限流（20 条）** | 否 | 防止自动 triage 淹没数据库 |
| 17 | **健康检查的多级状态** | 否 | ready / stale / degraded，不是简单的 healthy/unhealthy |
| 18 | **Embedding 服务降级** | 否 | Embedding 不可用时，自动退化为纯 BM25 搜索 |
| 19 | **Batch 批量写入（500 条）** | 否 | ChromaDB 批量添加，避免单条 HTTP 请求开销 |
| 20 | **systemd 服务依赖链** | 否 | ChromaDB → Embedding → JS 中间层，按序启动 |
| 21 | **WAL 模式 SQLite** | 否 | 读写并发不阻塞，崩溃可恢复 |
| 22 | **JSON Schema 入参校验** | 否 | Fastify 内置校验，19 个端点全部声明式定义 |
| 23 | **Wiki 目录自愈重建** | 否 | 启动时检测 wiki/ 完整性，从 DB 重新生成缺失文件 |
| 24 | **双发布函数（publishCandidate / publishWikiPage）** | 否 | 简短要点 vs 完整文档，不同格式输出到同一目录 |

**架构师**：这张清单就是本项目的"隐藏技能树"。README 告诉你怎么启动服务，这篇文档告诉你服务启动后，里面到底在发生什么。

---

## 一、整体架构：三服务协作模型

**小白**：项目里有三个进程在跑——JS 中间层、ChromaDB、Python Embedding 服务。为什么不能写成一个程序？

**架构师**：三个角色的技能树完全不同，硬塞在一起只会互相拖累。

```
┌─────────────────┐     HTTP      ┌─────────────────┐
│   JS 中间层      │◄─────────────►│   ChromaDB      │
│   (:8901)       │   127.0.0.1   │   (:8000)       │
│                 │               │  向量数据库       │
│  • 请求路由      │               │  • 余弦相似度检索  │
│  • 结果融合      │               │  • HNSW 索引     │
│  • 记忆管理      │               │  • 元数据过滤     │
│  • 健康聚合      │               │                 │
└────────┬────────┘               └─────────────────┘
         │
         │ HTTP 127.0.0.1
         ▼
┌─────────────────┐
│ Python Embedding │
│   (:8902)       │
│  • BAAI/bge-    │
│    small-zh-v1.5│
│  • 512 维向量    │
│  • ~500MB 内存   │
└─────────────────┘
```

**架构师**：JS 中间层是"编排者"——它不自己做向量计算，只做三件事：接收查询、调用专业服务、融合结果返回。Embedding 服务加载 AI 模型要 500MB 内存，如果和 JS 绑在一起，高峰期查询量上来时，Node.js 的 GC 和 Python 的模型推理会争抢 CPU 和内存。

**小白**：那如果 ChromaDB 挂了，JS 中间层会不会崩？

**架构师**：不会崩，但会降级。`Indexer.vectorSearch` 里有一行 `if (this.modelUnavailable) return []`，ChromaDB 不可用时向量搜索返回空数组，但 BM25 关键词搜索仍然可用。用户搜"8901 端口"这种精确查询，BM25 照样能命中。这比单体架构一个 bug 导致全站崩溃要好得多。

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 单体架构 | 部署简单 | 臃肿，资源争抢，升级困难 | 否 |
| 三服务拆分 | 职责清晰，故障隔离 | 多进程管理 | **是** |
| 容器化微服务 | 更强隔离 | 4GB 服务器资源吃紧 | 否 |

---

## 二、混合检索：向量搜索 + BM25 的两阶段 RRF 融合

**小白**：向量搜索听起来很高级，为什么还需要 BM25？两个一起用是不是重复了？

**架构师**：它们是互补的，不是重复的。向量搜索像"语义理解者"——能把"配置"和"设置"当成一回事；BM25 像"精确匹配者"——必须精确命中"8901"这个端口号，差一个字都不行。

```
用户查询: "怎么修改 8901 端口配置"

        ┌─────────────────┐
        │   Query Parser   │
        │  意图分类 + 变体扩展 │
        └────────┬────────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌───────┐   ┌───────┐   ┌───────────┐
│Dense  │   │ BM25  │   │ 变体查询 2  │
│向量搜索│   │关键词 │   │ (简化版)   │
└───┬───┘   └───┬───┘   └─────┬─────┘
    │           │             │
    ▼           ▼             ▼
  结果A       结果B         结果C...
    │           │             │
    └───────────┴─────────────┘
                │
        ┌───────▼───────┐
        │  两阶段 RRF    │
        │  Reciprocal   │
        │  Rank Fusion  │
        └───────┬───────┘
                │
                ▼
        ┌───────────────┐
        │  MMR 去重重排序 │
        │ (可选)         │
        └───────┬───────┘
                │
                ▼
        ┌───────────────┐
        │   Top-K 结果   │
        │  + 分数拆解    │
        └───────────────┘
```

**小白**：RRF 融合具体怎么算？两个列表怎么"加"在一起？

**架构师**：RRF 的公式极其简单，但效果极好：

```
score = Σ  weight_i / (k + rank_i)

其中 k = 60（平滑常数），rank 从 0 开始
```

假设向量搜索给的结果排名是 `[A, B, C]`，BM25 给的是 `[B, D, A]`：

- A: 向量第 0 名 → 1/(60+0) = 0.0167；BM25 第 2 名 → 1/(60+2) = 0.0161；总分 0.0328
- B: 向量第 1 名 → 1/61 = 0.0164；BM25 第 0 名 → 1/60 = 0.0167；总分 0.0331
- C: 向量第 2 名 → 1/62 = 0.0161；BM25 没出现 → 0；总分 0.0161
- D: 向量没出现 → 0；BM25 第 1 名 → 1/61 = 0.0164；总分 0.0164

最终排序：B > A > D > C。B 因为在两个列表里都靠前，所以总分最高。

**小白**：这个 `k=60` 是随便写的吗？

**架构师**：不是。k 是 RRF 的平滑参数，k 越大，排名差异对分数的影响越小。我们设 `k=60` 是因为通常只取前 50 个结果，k 比结果数稍大，能避免第一名和第二名的分数差距过大。这个值可以通过环境变量 `SCORING_RRF_K` 调整。

---

## 三、查询意图分类：7 类意图决定权重分配

**小白**：用户搜"config.json 在哪里"和搜"怎么配置端口"，系统会区别对待吗？

**架构师**：会。这就是"查询意图分类"（Query Intent Classification）。我们把查询分成 7 类，每类给向量搜索和 BM25 分配不同的权重：

| 意图 | 触发条件 | Dense 权重 | BM25 权重 | 设计理由 |
|------|---------|-----------|----------|---------|
| `exact_symbol` | 精确符号匹配 | 0.45 | **2.2** | 精确匹配 BM25 更强 |
| `path` | 文件路径查询 | 0.4 | **2.0** | 路径字符串 BM25 更准 |
| `error` | 错误信息查询 | 0.75 | 1.5 | 错误文本语义重要 |
| `config_key` | 配置键查询 | 0.6 | **1.8** | 配置键名精确匹配重要 |
| `rule_lookup` | 规则/规范查询 | 1.0 | 1.0 + 加成 | 规则文档优先级提升 |
| `symbol_lookup` | 符号查找 | 1.0 | 1.0 | 平衡策略 |
| `natural_language` | 自然语言（默认） | **1.0** | **1.0** | 语义和关键词并重 |

**小白**：这些权重是拍脑袋定的吗？

**架构师**：是基于检索场景的统计经验。比如搜文件路径时，用户通常输入 `src/config/index.js` 这种精确字符串，BM25 的精确匹配能力比向量搜索的"语义模糊匹配"更可靠，所以给 BM25 权重 2.0，Dense 只给 0.4。反过来，搜"怎么配置端口"这种自然语言，语义理解更重要，Dense 和 BM25 权重相等。

**小白**：如果分类错了怎么办？

**架构师**：分类错了也不会灾难性——权重差异只是微调，不是开关。即使把 `path` 错分成 `natural_language`，BM25 仍然参与计算，只是权重从 2.0 降到 1.0，结果质量下降一点，不会完全找不到。

---

## 四、查询变体扩展：一个查询拆成六个

**小白**：什么叫"查询变体"？用户只发了一个查询，系统怎么变成六个？

**架构师**：用户的原始查询叫"主查询"（Primary），系统会根据查询特征自动生成 5 个变体，每个变体有不同的搜索策略和权重：

```
原始查询: "OpenClaw 的端口配置在哪里"

变体 1: Primary（原始查询）        权重 1.0
变体 2: Simplified（简化版）       权重 0.92
        → "OpenClaw 端口配置"
变体 3: ExactSymbol（精确符号）    权重 1.35
        → 提取 "OpenClaw" 作为符号精确匹配
变体 4: SymbolContext（符号上下文） 权重 0.88
        → "端口配置" + 符号上下文
变体 5: SplitSymbol（拆分符号）    权重 0.78
        → "Open" + "Claw" + "端口配置"
变体 6: Alias（别名扩展）          权重 0.85
        → 同义词替换: "port" → "端口"
```

**架构师**：每个变体独立执行一次完整的双路检索（向量+BM25），然后用 RRF 把六个变体的结果再融合一次。这就是"两阶段 RRF"——第一阶段是单个变体内部的向量+BM25 融合，第二阶段是跨变体的融合。

**小白**：这样做不会很慢吗？六个变体就是六倍开销。

**架构师**：变体生成是本地字符串操作，零开销。六个变体的向量搜索可以并行（Promise.all），BM25 是内存计算，单次 1-5ms。总延迟增加约 20-40%，但召回率提升显著——用户搜"端口配置"找不到时，"port 配置"的变体可能就能命中。

---

## 五、MMR：最大边际相关性去重

**小白**：MMR 是什么？为什么搜索结果需要去重？

**架构师**：MMR（Maximal Marginal Relevance）解决的是"搜索结果重复"问题。假设用户搜"Fastify 配置"，向量搜索可能返回 5 个结果，其中 3 个都是讲 `fastify.listen()` 的，只是来源文件不同。用户不需要看三遍同样的内容。

**小白**：怎么判断两个结果是不是"重复"？

**架构师**：用 Jaccard 相似度——把两段文本分词成集合，计算交集大小除以并集大小：

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|

示例:
A = "Fastify 监听端口配置方法"
   → 分词: {fastify, 监听, 端口, 配置, 方法}
B = "Fastify 如何设置监听端口"
   → 分词: {fastify, 如何, 设置, 监听, 端口}

交集 = {fastify, 监听, 端口} → 3 个
并集 = {fastify, 监听, 端口, 配置, 方法, 如何, 设置} → 7 个
Jaccard = 3/7 ≈ 0.43
```

**架构师**：如果 Jaccard 相似度超过阈值（默认 0.85），就认为这两个结果"太像了"。MMR 会优先保留与查询相关、但与已选结果差异大的条目。

**小白**：MMR 具体怎么选？

**架构师**：MMR 的核心公式：

```
MMR_score = λ * relevance(i) - (1-λ) * max_sim(i, selected)

λ = 0.7（相关性 vs 多样性的权衡）
```

- `relevance(i)`：结果 i 的原始分数（归一化到 0-1）
- `max_sim(i, selected)`：结果 i 与所有已选结果的 Jaccard 相似度最大值
- λ = 0.7 表示"更看重相关性，但多样性也要考虑"

**架构师**：但 MMR 不是每次都启用。系统会先检测：如果 Top 结果里的重复率很低（没有两对以上超过 0.35 相似度），就直接返回原始排序，不浪费计算。另外，`exact_symbol` 和 `path` 两类意图默认禁用 MMR——因为精确匹配的结果本来就应该高度相关，去重反而可能丢掉重要信息。

| 参数 | 默认值 | 环境变量 | 含义 |
|------|--------|---------|------|
| `mmrEnabled` | true | `SCORING_MMR_ENABLED` | 总开关 |
| `mmrLambda` | 0.7 | `SCORING_MMR_LAMBDA` | 相关性权重 |
| `mmrThreshold` | 0.85 | `SCORING_MMR_THRESHOLD` | 高相似度惩罚阈值 |
| `mmrDuplicateFloor` | 0.35 | `SCORING_MMR_DUP_FLOOR` | 启用 MMR 的最低重复率 |
| `mmrDisableExactIntent` | true | `SCORING_MMR_DISABLE_EXACT` | exact_symbol 禁用 MMR |
| `mmrDisablePathIntent` | true | `SCORING_MMR_DISABLE_PATH` | path 禁用 MMR |

---

## 六、ScoringConfig：30+ 参数的可配置评分系统

**小白**：前面提到那么多权重，都是写死在代码里的吗？

**架构师**：全部可以通过环境变量配置，不需要改代码、不需要重启服务。系统启动时从环境变量读取，构建一个 `ScoringConfig` 实例。总共有 30+ 个参数：

```javascript
// 意图权重（8 个）
SCORING_DENSE_DEFAULT_WEIGHT=1.0
SCORING_BM25_DEFAULT_WEIGHT=1.0
SCORING_DENSE_EXACT_WEIGHT=0.45
SCORING_BM25_EXACT_WEIGHT=2.2
SCORING_DENSE_PATH_WEIGHT=0.4
SCORING_BM25_PATH_WEIGHT=2.0
SCORING_DENSE_ERROR_WEIGHT=0.75
SCORING_BM25_ERROR_WEIGHT=1.5
SCORING_DENSE_CONFIG_WEIGHT=0.6
SCORING_BM25_CONFIG_WEIGHT=1.8

// 变体权重（6 个）
SCORING_VARIANT_PRIMARY_WEIGHT=1.0
SCORING_VARIANT_SIMPLIFIED_WEIGHT=0.92
SCORING_VARIANT_EXACT_SYMBOL_WEIGHT=1.35
...

// 符号匹配加成（5 个）
SCORING_SYMBOL_TITLE_EXACT=0.06      // 标题精确匹配
SCORING_SYMBOL_TITLE_CONTAINS=0.04   // 标题包含
SCORING_SYMBOL_SOURCE_CONTAINS=0.035 // 来源文件包含
...

// Token 匹配（4 个）
SCORING_TOKEN_TITLE_WEIGHT=0.008
SCORING_TOKEN_SOURCE_WEIGHT=0.004
SCORING_TOKEN_CONTENT_WEIGHT=0.004
SCORING_TOKEN_HIT_CAP=6

// 文件聚合（4 个）
SCORING_FILE_AGG_WEIGHT=0.35
SCORING_FILE_AGG_CAP=0.04
...

// MMR（6 个）
SCORING_MMR_ENABLED=true
SCORING_MMR_LAMBDA=0.7
...

// RRF
SCORING_RRF_K=60
```

**小白**：这么多参数，调起来不麻烦吗？

**架构师**：绝大多数场景用默认值就够了。这些参数的存在是为了"可实验性"——当某个项目的搜索效果不理想时，可以通过调整参数快速验证假设，而不是改代码、重新编译、重新部署。比如发现路径搜索总是排不到前面，把 `SCORING_BM25_PATH_WEIGHT` 从 2.0 调到 2.5，重启服务就能验证效果。

---

## 七、双管道分词器：中文 jieba + 英文词干 + CJK n-gram

**小白**：分词不就是"把句子切成词"吗，有什么复杂的？

**架构师**：中英文混合场景下，分词质量直接决定搜索召回率。我们设计了一个"双管道"分词器，根据字符类型自动选择处理策略：

```
输入: "HelloWorld 的端口配置方法"

Step 1: 标识符预处理
  HelloWorld → "Hello World"（CamelCase 拆分）
  hello_world → "hello world"（snake_case 拆分）
  hello-world → "hello world"（kebab-case 拆分）

Step 2: nodejieba 中文分词（cut_all 模式）
  "Hello World 的 端口 配置 方法"

Step 3: 按字符类型分流处理

  中文词: "的", "端口", "配置", "方法"
    → 停用词过滤（去掉"的"）
    → CJK n-gram 生成: "端口配置", "配置方法"（2-gram）
    → 保留: ["端口", "配置", "方法", "端口配置", "配置方法"]

  英文词: "hello", "world"
    → 停用词过滤
    → 词干提取: "hello" → "hello", "world" → "world"
    → 保留: ["hello", "world"]

最终 tokens: ["hello", "world", "端口", "配置", "方法", "端口配置", "配置方法"]
```

**小白**：CJK n-gram 是什么？为什么要生成"端口配置"这种两个词的组合？

**架构师**：CJK（中日韩）文字没有空格分隔，jieba 分词可能把"端口配置"切成"端口"和"配置"。但如果用户搜"端口配置"这个完整短语，BM25 分别匹配"端口"和"配置"的分数，不如直接匹配"端口配置"这个 bigram 高。n-gram 是召回率和精确率之间的折中——用稍大的索引换更好的短语匹配效果。

**小白**：英文词干提取是什么？

**架构师**：把英文单词还原到词根形式。比如 "running" → "run"，"configurations" → "configuration"。这样用户搜 "run" 也能匹配到包含 "running" 的文档。我们的实现是轻量级的 Porter Stemmer 简化版，只处理最常见的后缀（-ing, -ed, -s, -es, -ly 等），200 行代码搞定。

---

## 八、BM25：自研 JavaScript 实现

**小白**：BM25 不是有现成的库吗，为什么要自己写？

**架构师**：Python 有 `rank_bm25`，但 JS 生态里没有成熟的中文 BM25 实现。我们的实现约 200 行，核心算法完全对齐 Python 版本：

```javascript
// BM25 评分公式
score = Σ idf(term) * [freq * (k1 + 1)] / [freq + k1 * (1 - b + b * docLen / avgdl)]

参数:
  k1 = 1.5  （词频饱和参数，控制高频词的得分上限）
  b = 0.75  （文档长度归一化，长文档不会天然占优）
  epsilon = 0.25 （负 IDF 平滑，罕见词不会得负分）
```

**架构师**：有一个细节很重要——负 IDF 平滑。如果某个词只在 1 篇文档中出现，IDF 公式 `log((N - df + 0.5) / (df + 0.5))` 可能算出负值。Python 的 `rank_bm25` 用 `epsilon * avg_idf` 来平滑负值，我们也实现了同样的逻辑。没有这个平滑，包含罕见词的文档反而得分更低，这显然不合理。

---

## 九、记忆系统：三层过滤 + 状态机 + Canonical Key 去重

**小白**：记忆系统是怎么决定"这段话要不要记下来"的？

**架构师**：这是一个三层过滤的"自动分拣"系统：

```
对话内容输入
    │
    ▼
┌─────────────────┐
│ Layer 1: 否定检测 │  ← 包含"先不管""试试看""算了" → 直接丢弃
│  TRIAGE_DISCARD  │
└────────┬────────┘
         │ 通过
         ▼
┌─────────────────┐
│ Layer 2: 敏感过滤 │  ← 包含密码/密钥/Token → 丢弃（预留）
│  (当前未启用)    │
└────────┬────────┘
         │ 通过
         ▼
┌─────────────────┐
│ Layer 3: 噪声过滤 │  ← 太短(<10字)或太长(>500字) → 丢弃
│  长度 + 内容质量  │  ← 纯寒暄/纯代码/纯情绪 → 丢弃
└────────┬────────┘
         │ 通过
         ▼
┌─────────────────┐
│ 生成 Canonical   │  ← SHA1(规范化文本) 作为去重键
│     Key          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 检查是否已存在   │  ← 相同 canonical_key 且 active → 跳过
│  (去重)         │
└────────┬────────┘
         │ 新内容
         ▼
    ┌─────────┐
    │ tentative│  ← 初始状态：临时记忆
    └────┬────┘
         │ 用户再次提及 / 显式确认
         ▼
┌─────────────────┐
│ candidate_on_   │  ← 复用触发：用户再次提到相关内容
│     reuse       │
└────────┬────────┘
         │ 用户选择"发布到 wiki"
         ▼
┌─────────────────┐
│  wiki_candidate  │  ← 等待人工审核
└────────┬────────┘
         │ 审核通过
         ▼
    ┌─────────┐
    │ published│  ← 正式发布到 wiki/（DB-backed，启动时自动重建）
    └─────────┘
```

**小白**：wiki 目录删了怎么办？所有沉淀的知识不就丢了吗？

**架构师**：不会丢。wiki/ 目录只是 DB 的**文件投影**——真正的数据源是 SQLite 里的 `published` 记忆。中间层启动时，`_ensureWikiDir()` 会检查：

1. wiki/ 目录是否存在
2. 每个 published 记忆对应的 slug.md 文件是否在磁盘上
3. 如果有任何缺失，从 DB 的 `content` 字段重新生成 md 文件，再调用 `rebuildWikiIndex()` 重建 index.md

所以只要 DB 不丢，wiki 目录随时可以重建。这也是为什么 wiki/ 被加入了 `static_kb` 的 sources——它是 scanner 的索引输入，而 DB 是 wiki 内容的权威数据源。

**小白**：`publishWikiPage` 和 `publishCandidate` 有什么区别？

**架构师**：两个函数都写 md 文件，但内容格式不同：

- `publishCandidate`：把 bullets 数组包装成 `- item` 列表格式，适合简短要点
- `publishWikiPage`：直接写入完整 markdown 内容，不做任何包装，适合已有格式的长文档

审核发布和启动重建都使用 `publishWikiPage`，因为 DB 中存储的就是完整 markdown 内容。
```

**小白**：Canonical Key 是什么？

**架构师**：就是"规范化后的内容指纹"。把文本做三件事：转小写、去掉多余空格、按空格分词后排序，然后算 SHA1。这样"记住这个规则"和"记住 这个 规则"会生成相同的 key，实现去重。

```javascript
function canonicalKeyForText(text) {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha1').update(normalized).digest('hex');
}
```

**小白**：每日写入限流是什么？

**架构师**：自动 triage 可能在一次长对话中生成几十条记忆，如果不加限制，数据库会被无意义的内容淹没。系统限制自动来源（`auto_triage`、`user_explicit`、`auto_draft`）每天最多写入 20 条。超过后新的自动记忆会被丢弃，但用户手动保存不受限制。

---

## 十、FTS5 全文搜索：SQLite 的隐藏大招

**小白**：记忆查询用 `LIKE '%关键词%'` 不是很慢吗？

**架构师**：生产环境用 FTS5（Full-Text Search version 5），SQLite 内置的全文搜索引擎。它比 `LIKE` 快 10-100 倍，支持相关性排序（BM25 算法），而且我们配了三个数据库触发器，让 FTS5 索引和主表自动同步：

```sql
-- 插入触发器：主表 INSERT 后自动索引
CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items
BEGIN
  INSERT INTO memory_items_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 删除触发器：主表 DELETE 后自动删除索引
CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

-- 更新触发器：主表 UPDATE 后先删旧索引再插新索引
CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_items_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

**架构师**：启动时还会检查 FTS5 和主表的记录数是否一致，如果不一致（比如崩溃导致同步丢失），自动执行 `INSERT INTO memory_items_fts(memory_items_fts) VALUES ('rebuild')` 重建索引。

---

## 十一、索引生命周期：Eager vs Lazy 加载

**小白**：启动时把所有文档都索引好，不是很慢吗？

**架构师**：所以我们分了两种加载策略：

| 策略 | 加载时机 | 适用场景 | 配置方式 |
|------|---------|---------|---------|
| **Eager** | 服务启动时 | 规则文档、设计文档（量少、常用） | `lazy: false` |
| **Lazy** | 首次查询时 | 代码库（量大、可能不用） | `lazy: true` |

**架构师**：规则文档通常只有几十篇，启动时加载完，用户第一次查询就是毫秒级响应。代码库可能有上万文件，如果启动时全量索引，可能要等几分钟。Lazy 策略让代码库在第一次被查询时才加载，如果用户从来不搜代码，这部分开销就省了。

```
服务启动:
  Eager collections ──► 立即扫描文件 ──► 构建索引 ──► 就绪
  Lazy collections  ──► 什么都不做 ──► 等待首次查询

首次查询 "LazyCollection":
  检查缓存 ──► 缓存命中 ──► 直接返回
      │
      ▼ 缓存未命中
  扫描文件 ──► 构建索引 ──► 写入缓存 ──► 返回结果
```

---

## 十二、增量同步：Manifest 指纹机制

**小白**：文件改了之后，索引怎么更新？全量重建太慢了。

**架构师**：用 Manifest 做增量同步。每个文件记录一个"指纹"：修改时间（mtime）+ 内容 SHA1。下次同步时对比指纹，只处理变更的文件：

```javascript
// Manifest 记录结构
{
  "rules::/root/.openclaw/docs/README.md": {
    "collection": "rules",
    "mtimeNs": 1713763200000000000,
    "size": 3456,
    "sha1": "a3f5c8...",
    "sourceFile": "/root/.openclaw/docs/README.md"
  }
}
```

**架构师**：同步流程：

1. 扫描当前所有文件，生成新指纹列表
2. 对比旧 Manifest：
   - 新文件 → `added`，全量索引
   - 指纹变了 → `updated`，删除旧索引 + 插入新索引
   - Manifest 里有但磁盘上没了 → `deleted`，删除索引
3. 更新 Manifest 文件

**小白**：如果文件内容没变但 touch 了一下（mtime 变了），会误判为更新吗？

**架构师**：不会。对比逻辑是 `mtimeNs` 和 `sha1` 同时变才算更新。如果只是 touch，mtime 变了但 sha1 没变，系统会跳过。这避免了不必要的重建。

---

## 十三、Indexer 双源恢复：缓存坏了也能恢复

**小白**：如果本地 JSON 缓存文件被删了或者损坏了，是不是要全量重建？

**架构师**：不需要。`Indexer.loadCache()` 实现了双源恢复：

```
加载索引:
  │
  ├──► 本地 JSON 缓存存在且有效？
  │      ├──► 是 ──► 加载缓存 + 重建 BM25 索引 ──► 完成
  │      │
  │      └──► 否 ──► 尝试从 ChromaDB 恢复
  │                    │
  │                    ├──► ChromaDB 有数据？
  │                    │      ├──► 是 ──► 分页拉取所有文档
  │                    │      │            ├──► 重建本地 chunks
  │                    │      │            ├──► 重建 BM25 索引
  │                    │      │            ├──► 写入新缓存
  │                    │      │            └──► 完成
  │                    │      │
  │                    │      └──► 否 ──► 全量重建（最后手段）
  │                    │
```

**架构师**：ChromaDB 是持久化存储，只要它没坏，即使本地缓存全丢，也能在几十秒内恢复。恢复后还会自动写一份新的 JSON 缓存，下次启动就快了。

---

## 十四、健康检查：不是简单的"通/不通"

**小白**：健康检查不就是返回 `{status: "ok"}` 吗？

**架构师**：太简单了。我们的健康检查返回一个多维状态评估：

```javascript
{
  "status": "ready",        // ready / stale / degraded
  "collections": {          // 各集合索引状态
    "rules": { "chromaCount": 45, "cacheChunks": 45 },
    "code": { "chromaCount": 0, "cacheChunks": 0, "state": "warming" }
  },
  "localmem": {             // 记忆系统状态
    "stats": { "total": 128, "active": 120, "wiki_candidate": 3 }
  },
  "governance": {           // 治理状态
    "pending_review_count": 3,
    "wiki_candidate_count": 3
  },
  "chroma": { "healthy": true },
  "embedding": { "healthy": true },
  "stale_flags": [],        // 异常标记列表
  "timestamp": "2026-04-22T..."
}
```

**架构师**：状态分三级：
- `ready`：一切正常
- `stale`：功能正常，但有需要注意的事项（比如有未审核的记忆、benchmark 过期）
- `degraded`：部分功能受影响（比如某个集合索引在重建中、ChromaDB 连接不稳定）

**小白**：这个状态有什么用？

**架构师**：可以作为负载均衡器的健康检查依据——`degraded` 时可以把流量切到备用实例；也可以作为监控告警的输入——`stale_flags` 非空就触发告警通知运维人员。

---

## 十五、技术选型的核心原则

**小白**：看了这么多设计，你们选技术的时候有什么统一的原则吗？

**架构师**：五条原则，贯穿整个项目：

1. **务实优先**：不追新，选择经过验证的技术。Fastify 2017 年发布，better-sqlite3 2016 年，都是成熟方案。
2. **生态统一**：与 OpenClaw 主程序（Node.js）保持一致，减少团队认知负担。
3. **各取所长**：JS 做编排（路由、融合、状态管理），Python 做 AI（Embedding 推理），ChromaDB 做存储（向量索引）。
4. **可替换性**：每个组件都有明确接口，未来可以独立升级。比如 Embedding 模型从 `bge-small` 换到 `bge-large`，只需改环境变量，接口完全兼容。
5. **可观测性**：健康检查、结构化日志、分数拆解——出问题的时候要知道"哪里坏了、为什么坏"。

---

## 附录：速查卡

### 速查卡 1：三个服务的启动顺序

```
1. ChromaDB  (:8000)  → 向量数据库必须先就绪
2. Embedding (:8902)  → 模型加载需要时间
3. JS 中间层 (:8901)  → 依赖上面两个服务
```

systemd 已配置 `After=openclaw-chromadb.service`，自动保证顺序。

### 速查卡 2：出问题先看哪里

| 问题现象 | 排查命令 |
|---------|---------|
| 搜索没结果 | `curl http://127.0.0.1:8901/api/stats` |
| 服务起不来 | `journalctl --user -u openclaw-context-engine.service` |
| ChromaDB 连不上 | `curl http://127.0.0.1:8000/api/v2/heartbeat` |
| Embedding 异常 | `curl http://127.0.0.1:8902/health` |
| 磁盘满了 | `du -sh /root/.openclaw/openclaw-engine-js/runtime/` |

### 速查卡 3：评分参数微调指南

| 问题 | 调整参数 | 方向 |
|------|---------|------|
| 精确匹配（文件名/端口号）排不到前面 | `SCORING_BM25_EXACT_WEIGHT` | 增大 |
| 语义相关但字面不同的结果太少 | `SCORING_DENSE_DEFAULT_WEIGHT` | 增大 |
| 搜索结果重复度高 | `SCORING_MMR_LAMBDA` | 减小（更重视多样性） |
| 路径搜索效果差 | `SCORING_BM25_PATH_WEIGHT` | 增大 |
| 规则文档排不到前面 | `SCORING_RULE_INTENT_BONUS` | 增大 |

---

*本文档最后更新：2026-04-22（补充 wiki 自愈机制、双发布函数、7 状态完整列表）*
*记录者：小白与架构师的技术对谈*
