# NarrateOS

**Deterministic Multi-Agent Long-Form Fiction Engine Built on the `@deepseek-ai/dsh` Plugin Ecosystem**

[简体中文](./README.md) | [English](./README.en.md)

---

## Overview

**NarrateOS** is a general-purpose multi-agent novel-writing engine built on top of `@deepseek-ai/dsh` (Cordis plugin architecture). It addresses the four fundamental failure modes of million-word serialized fiction generation:

1. **Cross-Volume Causality & State Drift**: Entity profiles are partitioned into four deterministic sections (`Innate Locks`, `Acquired State & Numeric Ledger`, `Irreversible Trajectory`, and `Current Volume Unconsolidated Buffer`), governed by a tri-state timeline filter (`MAINLINE` / `FLASHBACK` / `PARALLEL`) and a two-phase Git-backed WAL state machine (`DRAFTING -> FEAT_COMMITTED -> STATE_COMMITTED -> [DREAM_COMMITTED]`).
2. **POV Violations & Omniscient Spoiler Leakage**: A strict filesystem fence (`PathFence`) and dual-track scene outlines physically strip omniscient secrets (`OMNISCIENT_SECRET`), the Author Charter (`world/author_charter.md`), and the Arc Director Plan (`world/arc_director_plan.md`) from the cleanroom `Writer` and in-memory `Patch` roles.
3. **Negative Prompt Backfire (Pink Elephant Effect)**: The cleanroom `Writer` runs as a zero-tool, single-turn invocation receiving only positive, concrete camera-and-action directives. Gate feedback and rewrite prompts state only the target positive state rather than `"do not write X"` prohibitions.
4. **AI Cliche Accumulation & Voice Degradation**: A deterministic `StaticProseGate` enforces lexical blacklists, structural rhythm bounds, paragraph length caps, and cross-chapter simile deduplication, paired with an in-memory paragraph patching loop (`InMemoryDraftPatchSession`) and a hybrid rolling voice sample pool (`.ops/voice_samples.yaml`).

> **Strict Separation of Engine and Books**: This root repository contains only generic plugin source code, preset configurations, and test fixtures. Every novel lives in its own isolated Git repository under `books/<slug>/`.

---

## Architecture

### 1. Dual-Surface Human-AI Collaboration
- **DSH Main Conversation (Author & Showrunner Entry)**: Exposes a single top-level preset mode (`NarrateOS Creative Mode`, `id: narrateos`). Authors collaborate with the Showrunner to align on premise, lock the Author Charter, compile initial book assets (`lock_charter_and_boot`), and orchestrate chapters via slash commands (`/narrate-step`, `/narrate-yolo [n]`, `/narrate-halt`, `/narrate-dream`, `/narrate-sync`, `/narrate-signal <text>`).
- **Operator Studio (`/studio` Browser Workbench)**: Delivered by `@narrateos/dsh-client-ui-studio`, providing a three-pane editorial control room:
  - Live 6-stage pipeline visualization with single-step and continuous (`YOLO`) execution controls;
  - Manuscript reader/editor, dual-track chapter outlines, diff inspection, and full Codex browser (Entities & Items, Open Threads, Horizon & Scrapped Plans);
  - Deep stage-session drill-down (reasoning traces, tool calls, attempt switchers) and quantitative prose telemetry (MATTR-500, Kontoyiannis entropy, sentence-length CV, cache hit ratio);
  - Per-book model routing across `strong_creative` / `fast_retrieval` pools and fine-grained per-role model overrides.

### 2. Deterministic 6-Stage Chapter Pipeline & Periodic Dreaming

```text
[1. Librarian] ---> [2. Planner] ---> [3. Writer (Cleanroom)] ---> [4. ProseGate / LocalPatch (In-Memory)]
                                                                             |
[WAL & Git Commit] <--- [6. Extractor (Sync)] <--- [5. FactChecker (Dual-Quote Verbatim Audit)]
        |
        +---> (Watermark Trigger) ---> [Dreamer (Multi-Turn Memory Consolidation & Voice Rolling)]
```

| Role | Role ID | Default Pool | Cleanroom | Core Responsibility & Terminal Yield Gate |
|---|---|---|---|---|
| **Boot Compiler** | `boot-compiler` | `strong_creative` | No | Compile the Author Charter, T0 anchor, initial entities, lore, and voice seeds (`yield_boot_bundle` / `lock_charter_and_boot`) |
| **Librarian** | `librarian` | `fast_retrieval` | No | Recall timeline-filtered entities, lore entries, and L3 manuscript slices with paired co-mounting checks (`yield_context_pack`) |
| **Planner** | `planner` | `strong_creative` | No | Produce internal `director_rationale` and cleanroom-safe positive `outline_text` (`yield_outline`) |
| **Writer** | `writer` | `strong_creative` | **Yes** | Zero-tool single-turn cleanroom prose drafting from visible entity slices, voice specimens, and positive scene beats |
| **Local Patch** | `patch` | `strong_creative` | **Yes** | Pure in-memory 0-based paragraph replacement (`patch_paragraphs`) to resolve `StaticProseGate` or local fact issues (`yield_patched_draft`) |
| **Fact Checker** | `fact-checker` | `strong_creative` | No | Zero-aesthetic factual audit of `Innate Locks`, POV boundaries, ledgers, and `Stage Ceiling` with punctuation-stripped dual-quote verification and confirmation of fulfilled beats/threads (`yield_verdict`) |
| **Extractor** | `extractor` | `fast_retrieval` | No | Extract incremental entity slot patches, dual-track L2 chapter cards, and next-chapter options for two-phase Git commit and idempotent beat/thread settlement (`yield_state_patch`) |
| **Dreamer** | `dreamer` | `strong_creative` | No | Offline multi-turn buffer consolidation, cold-storage archiving, cross-chapter open-thread audit, and rolling voice pool curation (`book_edit` + `yield_dream_commit`) |

---

## Repository Layout

```text
.
├── design/                      # SSoT formal models: C4 architecture views (structure/), requirements (requirements.md), VDM-SL contracts (contract/), and Quint behavior wiring (behavior/)
├── packages/
│   ├── dsh-book-store/          # @narrateos/dsh-book-store: 4-section entity parser, tri-state timeline filter, L0-L3 recall, StaticProseGate, WAL & Git transactions
│   ├── dsh-book-tools/          # @narrateos/dsh-book-tools: PathFence, ReadQuotaCounter, StagingSession, controlled read/edit/patch tools, and 7 yield_* gates
│   ├── dsh-pipeline/            # @narrateos/dsh-pipeline: chapter pipeline, Dreaming loop, cascading rollback, slash commands, and HTTP/SSE controller
│   └── dsh-client-ui-studio/    # @narrateos/dsh-client-ui-studio: Operator Studio browser UI and DSH Web Workbench integration
├── presets/
│   └── dsh-preset-narrateos/    # @narrateos/dsh-preset-narrateos: top-level DSH preset, externalized roles/*.yml, prompts/*.md, and narrate-boot skill
├── plugins/
│   └── craft/                   # Optional per-book cognitive craft plugins (vad-bdi / dual-reaction / scene-act / dialogue-subtext / sensory-grounding)
├── scripts/
│   ├── dev-sandbox.sh           # Isolated sandbox initializer and launcher (defaults to /tmp/narrateos-sandbox)
│   └── lint-repo.mjs            # Deterministic repository gate (ASCII hyphen enforcement, no hardcoded private models, read-only fixture check)
├── docs/
│   ├── ARCHITECTURE.md          # Domain workflows, data contracts, POV isolation, chapter pipeline, WAL state machine, and invariant/variable matrix
│   ├── WRITING-CRAFT.md         # Prose craft discipline, narration subjectivity, voice specimens, and static gate lexicon
│   ├── DEVELOPMENT-PLAN.md      # DSH plugin architecture, Cordis service contracts, role schemas, and Phase 5 roadmap
│   ├── RESEARCH.md              # Long-form evaluation benchmarks and @deepseek-ai/dsh runtime notes
│   ├── impeccable/              # Product boundaries (PRODUCT.md), visual system (DESIGN.md), and Studio frontend brief
│   └── adr/                     # Architecture Decision Records (ADR-0004)
├── ROADMAP.md                   # Domain Glossary
└── CODING_STANDARDS.md          # Engineering gates and code review invariants
```

---

## Quick Start

### Prerequisites
- **Node.js**: `>= 22` (Node 24 recommended)
- **pnpm**: `10.33.0+`
- **Git**: Required for per-book transactional state commits and chapter rollbacks

### 1. Install & Build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### 2. Launch the Isolated Sandbox (Operator Studio + DSH Web Workbench)

Configure your model routing via environment variables or a gitignored `.env` file in the repo root, then launch the isolated sandbox:

```bash
# Initialize and validate the sandbox directory only (defaults to /tmp/narrateos-sandbox)
pnpm run dev:sandbox -- --init-only

# Start the sandbox server (optionally specify PORT, e.g. PORT=42893)
PORT=42893 pnpm run dev:sandbox
```

Once started, open the authenticated localhost URL printed in the terminal:
- **DSH Main Chat Workbench**: Switch to **NarrateOS Creative Mode** (`narrateos`) to brainstorm a new book with the Showrunner or run `/narrate-step` and `/narrate-yolo` commands.
- **Operator Studio**: Click the **NarrateOS Studio** icon in the activity bar (or open the `/studio` view) to drive chapters, inspect the Codex, view stage reasoning sessions, and configure per-role model routing.

### 3. Run Verification Gates & Tests

Before committing or shipping changes, run the unified verification suite (builds all packages, runs TypeScript typechecking, enforces repository lint gates, validates preset constraints, and runs all Vitest suites):

```bash
pnpm run check
```

Individual & formal verification commands:

```bash
pnpm run build        # Build all 4 workspace packages and bundle Studio client modules
pnpm run typecheck    # Build and run TypeScript typechecking across all packages
pnpm run lint         # Run scripts/lint-repo.mjs deterministic repository checks
pnpm test             # Run unit tests, preset tests, and release gate checks
ssot check design     # Run SSoT formal structure, VDM-SL contract, and Quint behavior replay checks
ssot serve design     # Launch interactive live-reloading architecture and contract diagram viewer
```

---

## Per-Book Sub-Repository Overview (`books/<slug>/`)

Each book compiled by `lock_charter_and_boot` is initialized as a standalone Git repository partitioned into five top-level areas (for the complete file tree, access matrix, and schemas, see [`docs/ARCHITECTURE.md` §2](./docs/ARCHITECTURE.md#2-作品工作区纯文本数据库结构与原子事务协议)):

- `world/`: Book configuration (`book_config.yaml`), read-only Author Charter (`author_charter.md`), Arc Director Plan & Opening Sequence Beats (`arc_director_plan.md`), public volume envelope, static prose baseline, world state, active foreshadowing ledger (`open_threads.md`), future horizon events, and on-demand lore (`lore_library/`).
- `entities/`: Four-section character and key item profiles (`char_*.md`, `item_*.md`) plus archived dormant profiles (`cold_archive/`).
- `index/`: `L0` saga overview, `L1` active volume outline, and `L2_cards/vol_XX_cards.md` dual-track chapter cards.
- `manuscripts/`: Settled chapter manuscripts (`ch_XXXX.md`, 4-digit zero-padded chapter numbers, authoritative WAL source of truth).
- `.ops/`: Operational runtime ledger (transaction state & pending write recovery lists, rolling voice samples, steering signals & cursor, sync conflict reports, heal checkpoints, session logs, and prose telemetry).

---

## Documentation Index

- **Formal Architecture, Contracts & Behavior Wiring (SSoT)**: [design/](./design/)
- **Domain Glossary**: [ROADMAP.md](./ROADMAP.md)
- **Workflows, Data Contracts & Invariant/Variable Matrix**: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Writing Craft & Static Gate Lexicon**: [docs/WRITING-CRAFT.md](./docs/WRITING-CRAFT.md)
- **DSH Plugin Architecture & Phase 5 Roadmap**: [docs/DEVELOPMENT-PLAN.md](./docs/DEVELOPMENT-PLAN.md)
- **Product Boundaries & Visual Design System**: [docs/impeccable/PRODUCT.md](./docs/impeccable/PRODUCT.md), [docs/impeccable/DESIGN.md](./docs/impeccable/DESIGN.md)
- **Coding Standards & Review Invariants**: [CODING_STANDARDS.md](./CODING_STANDARDS.md)
