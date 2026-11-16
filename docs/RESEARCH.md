# 外部前沿对标、API 契约边界与底座勘探参考 (RESEARCH)

> **定位**：合并长篇叙事学术流派、开源软件拆解、跨厂商 LLM API 共性约束与 `@deepseek-ai/dsh` 源码核查的唯一外部事实参考库。所有论文数据、源码结论与 API 边界均已完成一手来源交叉核验。

---

## 1. 长篇叙事生成四大技术流派与核心论文实证对标

### 1.1 学术界核心代表作与关键实证数据（2022-2026）

| 代表工作 | 核心架构与规模 | 经核验的核心实证发现与工程启示 | 结构性局限 |
| :--- | :--- | :--- | :--- |
| **[`DOC`](https://arxiv.org/abs/2212.10077)** / **[`LongWriter`](https://arxiv.org/abs/2408.07055)** | 递归细纲控制 / `Plan-Write` 字数拆分微调（10K+ 词） | 证明分阶段拆解计划可突破单次输出长度瓶颈（后续 [`LongWriter-Zero`](https://arxiv.org/abs/2506.18841) 进一步用 RL 强化长文生成）。 | 面向单次长指令扩写，缺乏跨百章动态演化的人物/物品外部状态账本。 |
| **[`Agents' Room`](https://arxiv.org/abs/2410.02603)** (ICLR 2025) | 编剧室分工（规划/执笔智能体）+ `Shared Scratchpad`（~1K-2K 词） | 人类评审与模型裁判相关性实验证实：规划与执笔职责解耦可显著减少模板套话并提升戏剧张力。 | 实验篇幅仅短中篇，未触及长程状态突变与窗口膨胀。 |
| **[`DOME`](https://aclanthology.org/2025.naacl-long.63/)** (NAACL 2025) / **[`StoryWriter`](https://arxiv.org/abs/2506.16445)** (CIKM 2025) | 动态分层大纲 + 时序知识图谱三元组 / 事件子图（~8K-10K 词） | 验证了动态大纲调整与事件粒度拆分的必要性。 | 细粒度图谱维护极重：`DOME` 在 10K 词对比测试中耗费 **3,501 次模型调用**，且长程一致性与文笔得分偏低。 |
| **[`SCORE`](https://arxiv.org/abs/2503.23512)** / **[`PLOTTER`](https://arxiv.org/abs/2604.21253)** / **[`CreAgentive`](https://arxiv.org/abs/2509.26461)** | 物品 `active/lost/destroyed` 状态机；写前事件图/角色图拓扑审计；逻辑与文风双图谱解耦 | 证明拦截“已毁/已失物品重现”及写前审计因果图比写后全文返工更廉价高效。 | 纯三元组图谱难以承载微妙的人物主观认知偏差（谎言/误信）与声纹质感。 |
| **[`BookWorld`](https://arxiv.org/abs/2504.14538)** (ACL 2025) | 从既有长篇抽取**离散地理可达图** + 静态世界法则与动态角色心理分离 | 强制角色跨地点移动消耗时间步，从物理拓扑上根除“瞬移穿帮”，与本引擎 `static_base` 空间连通表高度同构。 | 偏重既有世界多角色交互模拟，未覆盖零基础原创冷启动卷纲倒推。 |
| **[`Magnet`](https://arxiv.org/abs/2607.00918)** (2026) | 角色代理行动提案 + `Goal Sequencing` + `Critic` 过滤（20-100 页） | 消融实验证实独立角色动机碰撞与 `Critic` 动作精炼对抑制百页幻觉具统计显著贡献（`p < 0.05`）。 | 每步全员轮询提案开销随在场人数超线性增长，共享单份覆盖式状态。 |
| **[`ConStory-Bench`](https://aclanthology.org/2026.findings-acl.410/)** (Findings of ACL 2026) | 2,000 条长篇评测指令、5 大类 19 子类一致性错误基准 | 1. 事实锚点多埋于前 `15%-30%`，而吃书集中爆发在 **`40%-60%` 中盘死亡谷**；<br>2. 事实细节错误与人设（`r=0.304`）、世界观（`r=0.255`）、时间线（`r=0.176`）崩坏强相关；<br>3. 1,000 处注入错误中专用模型检出率 **`55.0%`**，高于人类专家均值（`17.1%`），但仍漏检 `45%`。 | 仅靠扩大模型上下文窗口无法消除中段崩溃，必须引入外部显式状态与卷中里程碑对表。 |
| **[`NstAgent`](https://arxiv.org/abs/2609.35759)** (清华, 2026) | 单智能体 + 类型化三状态（角色快照 / 过往事件 / 未兑现义务）+ GRPO（实测 **100K 词**） | 1. 100K 词错误密度平稳（`6.39 -> 7.24`，优于滚动摘要 `9.17 -> 11.82`），前缀缓存下保持线性低成本；<br>2. 分项评测显示**数量与算术穿帮（`Quantitative Mismatches`，1.26-1.58/万词）**高居榜首；<br>3. 披露三大实战暴雷：死卡 `±20%` 字数引发无错稿被迫重写；写手同源改状态导致**配角改名/错龄永久锁死**；LLM 裁判对无错组目标子类误报 `25%`、**任意子类总误报高达 `79%`**。 | `past_events` 每章净增只增不减，千万字级会撑爆窗口；未处理同人原著参数引力与多时间线隔离。 |

### 1.2 注意力退化、记忆即环境补集、反参数引力与文风坍缩实证

1. **长窗口注意力稀释——Chroma [`Context Rot`](https://research.trychroma.com/context-rot) (2025)**：对 18 款跨厂商模型近 19.5 万次实测证明，远未触及窗口上限时，只要目标约束与当前场景字面语义相似度低（如“第 8 章左肩旧伤”与“第 60 章日常搬书箱”），召回准确率即剧烈衰减——证实**永久负向红线必须随实体出场确定性挂载，不可依赖向量 RAG**。
2. **记忆即环境的补集——Anthropic *The components of agent memory* (2026-11) & 工程同构**：
   - **记什么比怎么存重要**：宝可梦长程实验显示，堆砌 413 个含屏幕可见临时状态的文件（近百万字符）仅获 1 枚徽章，而仅记 9 个文件（4 万余字符，只存屏幕外不可见的策略与已验证不变量）拿下 4 枚徽章——直接支撑本引擎**“环境补集提取原则”**；
   - **强弱模型记忆分化与先验拐杖负收益**：`CL-Bench` 中旗舰强模型挂记忆大幅跃升（`0.655 -> 0.838`），弱模型仅微涨（`0.330 -> 0.364`），且给强模型套死板先验记忆/思维填表规矩反而降低收益；
   - **视图与原始语料成对检索黄金率**：实测 `仅看互链 Wiki (48%) < 仅搜原始语料 (53%) < 两者成对结合 (61%，且单次省约 2 万 Tokens)`——直接印证本引擎「`entities/ & L2` 物化视图 + `L3 ripgrep` 原稿切片」成对挂载架构。
3. **零样本审美裁判上限——Stanford [`LitBench`](https://arxiv.org/abs/2507.00769) (2025)**：去长度偏差实测显示，顶级商用零样本 LLM 裁判与人类文学偏好一致率仅 **`73%`**（专用奖励模型最高 `78%`）——直接支撑**“严禁轻量模型评判文学审美”**公理。
4. **参数记忆冲突与「粉红大象效应」**：
   - [`arXiv:2305.13300`](https://arxiv.org/abs/2305.13300) 与 [`arXiv:2506.15732`](https://arxiv.org/abs/2506.15732) 证实多跳长程生成中模型存在强烈的预训练参数回归惯性；
   - [`arXiv:2402.07896`](https://arxiv.org/abs/2402.07896)（*Suppressing Pink Elephants*）与 [`arXiv:2503.22395`](https://arxiv.org/abs/2503.22395) 证实：在生成 Prompt 中直接写入含原著高频共现词的否定禁令，自注意力层必须先高权重激活被禁词簇而诱发词法启动泄露；有效解法是 **“灰象双视图隔离”**——对写手物理隐去被禁原著词，仅投喂占满同一时空槽位的正向排他事实。
5. **长篇文风坍缩与零模型熵率检测**：
   - [`Antislop` (arXiv:2510.15061)](https://arxiv.org/abs/2510.15061) 与 [EQ-Bench Creative Writing v3](https://eqbench.com/creative_writing.html) 揭示部分典型 AI 套话与对比句式出现率超人类语料 **1,000 倍**；
   - [`arXiv:2608.12630`](https://arxiv.org/abs/2608.12630) 揭示 AI 小说跨章节**形式方差坍缩（句段长分布被挤压在窄均值）**，并确立 **`MATTR-500`** 为抗章长波动的标准词汇丰富度指标；
   - [`arXiv:2610.01493` (NeurIPS 2026)](https://arxiv.org/abs/2610.01493) 提出纯文本最长匹配长度计算的 **Kontoyiannis 非参数熵率估计器 $\hat{H}_K$**，无需模型权重与 `logprobs` 即可精准捕捉多代自回归坍缩。

---

## 2. 开源长篇小说工程与专业写作软件拆解

| 项目 / 产品 | 技术路线与核心亮点 | 暴露的工程教训 / 借鉴点 |
| :--- | :--- | :--- |
| **[`voocel/ainovel-cli`](https://github.com/voocel/ainovel-cli)** (Go) | 穷举单测的确定性 `Route` 决策表（主循环 0 LLM 开销）+ 卷/弧/章三级摘要 + Step 级原子写盘断点恢复 + 基于正文 `SHA-256` 的 `/sync` 人工改稿增量同步。 | **[Issue #152](https://github.com/voocel/ainovel-cli/issues)** 实锤“重写旧章时混入后期人物状态导致时间穿越污染”（印证历史旧章手改只做下游只读冲突扫描与插叙冻结的必要性）。 |
| **[`tianming-novel-ai-writer`](https://github.com/zy-zmc/tianming-novel-ai-writer)** (C#/.NET 8) | 15 维事实快照（含秘密知情列表与揭露态）+ `CHANGES` 确定性门禁。 | 自曝“状态过早落盘会误导后续重试”，印证先定稿 `feat` 后提状态 `state` 双粒度提交与临时路人缓建档的必要性。 |
| **[`Claude-Code-Novel-Writer`](https://github.com/forsonny/Claude-Code-Novel-Writer)** / **[`storygen-skill`](https://github.com/kashyab12/storygen-skill)** | **Novel-as-Code** 范式：纯文本手稿为唯一真源 + 脚本派生状态 + 工单隔离主从上下文 + 只读连续性扫描。 | 若直接在长对话主会话回传整章正文，极易撑爆上下文触发有损摘要压缩。 |
| **[NovelCrafter](https://www.novelcrafter.com/help/docs/codex/codex-tracking)** / **[Sudowrite](https://docs.sudowrite.com/)** / **[SillyTavern](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)** | Codex 别名确定性注入；属性级隐藏防剧透；世界书递归激活。 | 动态词条若插入消息前部，每轮进出都会**反复击穿前缀 KV 缓存**；中文无空格须关闭整词匹配；混有原著结局的设定包须在开书期做 `T0` 切分。 |

---

## 3. 主流 LLM API 跨厂商契约共性与兼容边界

1. **前缀 KV 缓存的两种后端范式**：
   - **零配置自动前缀匹配**（DeepSeek 磁盘缓存、OpenAI Prompt Caching、Gemini 隐式缓存、vLLM/SGLang RadixAttention）：无写入溢价（`1.0x`），前部字节一致即自动命中折扣。
   - **显式生命周期断点**（显式 `cache_control` 或 Context Caching API）：支持指定 TTL，命中读价低至 `0.025x-0.1x`，但首次写入或失效重建存在 `1.25x-2.0x` 写入溢价，且断点数量有限。
   - **四条跨平台铁律**：① 强模型与轻量模型物理张量异构，**跨模型绝不共享缓存**；② 请求首部 `tools` 声明与推理档位参数一旦不一致，**第 0 字节即发生前缀分叉**；③ 每章追加变动的当前活跃卷索引必须置于已封旧卷静态区**之后**；④ 多家平台对超长输入（`>100K/128K`）设 **2-5 倍阶梯涨价**，检索目录压在 `<100K` 内最安全。
2. **多语言分词率跨度**：不同模型词表跨度达 **`0.6 ~ 1.9 Tokens/汉字`**（相差逾 3 倍），因此写手窗口预算不可写死单一全局 Token 魔数，须支持按模型配置并在试播集阶段按实测 `usage` 自动标定 `tokens_per_char`。
3. **推理思考块与 `logprobs` 互斥现实**：主流商用推理模型在思考模式下禁用或省略输出端 `logprobs`，且多轮保留思考块会持续计费污染注意力；故执笔写手统一采用**无历史零工具单轮调用**，退化遥测统一采用纯文本 `MATTR-500` + Kontoyiannis 熵率 $\hat{H}_K$。

---

## 4. 宿主底座源码核查：`@deepseek-ai/dsh` (Cordis 微内核)

针对 `@deepseek-ai/dsh`（`0.1.1-rc.2` 本地源码及上游 `0.2.2-rc.x` 演进）的一手源码审计结论：

1. **官方交互面与 Cordis 可插拔架构**：
   - 官方核心交互面为 **`dsh-web-app`（浏览器工作台）**、`headless` 与 `sdk-app / acp-app`（官方无内置终端 TUI；本机 `dsh-cc-tui` 系第三方社区包，其斜杠命令签名滞后与缺失审批弹窗等限制不属于 `dsh` 官方底座）。
   - 基于 `@deepseek-ai/cordis`「万物皆插件」机制，可通过 Profile 级 `cordis.patch.yml` 将编码向冗余插件（`tool-subagent`、`tool-ralph`、`tool-workflow`、`compaction-basic`、`tool-result-pruner`、`agent-instructions` 等）全部显式设为 `disabled: true`（注意：按 `id` 覆写时整块替换 `config` 而非深度合并）。
   - **`dsh-agent-presets` 原生模式集合机制**：每个模式仅需一个包含 `agent.cordis.yml` 与 `preset.yml` 的目录，配合 `@deepseek-ai/dsh-persona`（`complete: true, includeRuntimeContext: false`）可 100% 屏蔽宿主默认身份提示词与运行时动态快照，支持在 Web 端一键切换专属写作模式。
2. **模型直连、缓存控制与 Web 扩展点**：
   - 插件直调不带 `sessionId` 的 `ctx.llm.stream(options)` 时，可彻底绕过主会话循环、动态时钟与工具注入，实现多厂商异构双池路由并获取标准化无交集 `TokenUsage`（`inputTokens` + `cacheReadTokens` + `cacheWriteTokens`）。
   - 内置 `dsh-llm-pi-ai` 在显式断点协议下会自动给最后一条动态 `user` 消息附加 `cache_control`；但 `ctx.llm.registerAdapter()` 本身开放了 `LlmAdapter` 插件扩展点，需要精细多断点控制时可挂载轻量自定义适配器，而自动前缀缓存路线则开箱零损耗。
   - Web 端完整开放 `@deepseek-ai/dsh-client-ui-slots`（侧栏/浮层插槽）、`ctx.userQuestions`（交互式单选/多选问卷）与 `ctx.commands`（斜杠命令）。
3. **工程解耦边界**：鉴于 `dsh` 尚处 `0.x-rc` 快速演进期（要求 `Node >= 24.9`），将纯 TypeScript 写作内核做零 `cordis` 依赖隔离，外包一层薄 `dsh` 插件与 `agent-preset` 胶水，可同时兼得开箱即用的 Web 工作台与零底座升级耦合风险。

---

## 5. 学术发表潜力客观评估备忘（CCF 推荐目录口径）

仅正式长文（Full/Regular Paper）计入 CCF 等级（Demo、Workshop 与 Findings 不计入）：

- **CCF-C 类（NLPCC / CCL / PRICAI）及顶会 Demo / Findings**：完成系统实现并在 `ConStory-Bench`（100K 词区间）对比 `RollSum`、`NstAgent` 取得稳定优势且开源可复现代码，把握较高（约 60%-75%）。
- **CCF-B 类（EMNLP / NAACL / COLING / CIKM）**：需实测多本百万字级长程错误密度（CED）退化曲线，补齐模块消融实验（四段补集履历、灰象双视图隔离、时序信封、双原句验真），并开源**反事实同人抗参数引力基准（Counterfactual Fanfic Benchmark）**。
- **CCF-A 类（ACL / AAAI / IJCAI）**：纯提示词与外部编排极难命中（`<10%`），需升格为跨领域通用非平稳记忆理论或将双关校验信号闭环用于强化学习（RL/DPO）训练并配大规模人类盲测。
