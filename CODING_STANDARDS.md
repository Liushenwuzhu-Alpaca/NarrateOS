# CODING_STANDARDS.md

本文承载机械 Linter（`scripts/lint-repo.mjs`、`tsc`、`preset.test.mjs`）无法替代的跨文件架构与领域不变量准则，供代码审查（`code-review` Standards 轴与 `reviewer` 子代理）核验。

---

## 1. WAL 双粒度事务与排他锁收口

- **单锁单登记原则**：一切修改作品 `entities/`、`world/`、`index/` 或 `.ops/tx_state.json` 的落盘操作（含 `cold_archive` 迁移与 `Sync` 修正）必须收口在 `BookStore` 同一 `withTxLock` 事务内，并由同一次 `recordPendingWrites` 统一登记待提交路径；严禁管线层在外部覆写 `pending_writes.json`。
- **锁外网络调用**：外部 LLM / HTTP 流式调用必须在获取 `.ops/tx.lock` 之前完成，或仅在纯内存 `StagingSession` 内运行，避免网络超时阻塞文件锁。
- **历史章 `Sync` 状态防倒流**：当修改非最新已归档章节（`dirtyChapter < last_committed_ch`）时，只允许刷新对应卷的 `L2` 章卡与章节哈希并输出下游只读冲突报告，严禁重放旧章 `EntityPatch` 覆盖最新实体第 2 区或 `world_state.md`。

## 2. 三态时间线与 `StagingSession` 成对一致性

- **读写覆盖与时间线双过滤**：凡读取作品资产、构建目录或执行原稿回表（`IndexRecall`、`book_read`、`book_grep`、`book_glob`），必须同时满足：
  1. 优先读取活跃 `StagingSession` 内存脏页并过滤已标记删除路径（read-your-writes）；
  2. 严格按当前 `timeline_mode` 裁剪可见范围（`MAINLINE` 顺叙、`PARALLEL` 仅见分叉基线加本分支增量、`FLASHBACK` 屏蔽当前第 2 区与近期缓冲且原稿/履历严格限制 `story_day < target_day`）。
- **分支与插叙冻结边界**：`PARALLEL` 与 `FLASHBACK` 期间冻结主线 `story_day` 累加，且禁止将 `entities/cold_archive/` 下的休眠档案物理迁回主线 `entities/`（仅允许内存临时加载只读视图）。

## 3. 净室正向隔离与路径围栏完备性

- **整条剥离优于行级截断**：面向净室工种（`Writer` / `REWRITE` / `Patch`）渲染切片或修订反馈时，凡未通过原稿双侧去标点存在性验真，或命中 `OMNISCIENT_SECRET`、非当前 POV `SELF_ONLY`、`WARPED` 的条目，必须**整条丢弃或整条拒绝**；严禁仅按单行正则删去首行而残留无主语的多行秘密续文（`continuationLines`）。
- **全入口路径围栏**：`PathFence` 的可读/可写/禁读规则必须通过外部 `roles/*.yml` 声明注入，禁止在代码中硬编码工种名；禁读路径（如 `world/author_charter.md`、`world/arc_director_plan.md`）必须在单文件读取（`book_read`）与目录扫描（`book_grep`、`book_glob`）两侧同步拦截，并校解析后的真实物理路径防符号链接逃逸。
- **正向具象表述**：所有进入净室窗口的提示词、卷包络与重写反馈统一陈述目标正向行为，不引入否定禁令词触发词法反噬。

## 4. Cordis 插件生命周期对称释放

- **零残留卸载**：在 Cordis `Service` 或插件入口注册的一切子服务、HTTP/SSE 路由、斜杠命令、钩子监听器、`AbortController` 与后台定时器，必须在 `ctx.on('dispose', ...)` 或返回清理句柄中对称释放，确保热重载与多实例测试互不串扰。
- **零模块级可变单例**：运行期作品状态、工作区路径与会话缓存绑定于服务实例或 `BookStore` 实例，不使用模块顶层可变全局变量跨书共享。

## 5. `ovnfs` 隔离工作树与门禁闭环

- **一任务一检出**：并行实现或独立修复在各自命名的 `ovnfs` 检出（`/home/alpaca/checkouts/<task-name>`）及独立 Git 分支内闭环，互不跨检出直接改写文件。
- **合入前双检**：合入主目录前，必须确认检出内 `pnpm run check` 退出码为 `0`、`ovnfs diff <task-name>` 不含计划外改动或临时调试残留，且 `ovnfs apply <task-name> --dry-run` 零冲突，随后通过 `git fetch /home/alpaca/checkouts/<task-name> <branch> && git merge FETCH_HEAD`（或 `ovnfs land <task-name>`）保留提交历史合入。
