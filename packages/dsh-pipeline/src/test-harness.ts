import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import {
    agentEvents,
    type Agent,
    type AgentHandle,
    type CreateAgentOptions
} from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, LlmCallConfig, LlmRuntime, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition, ToolExecutor, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { BookStore, NodeSystemAdapter } from '@narrateos/dsh-book-store';

const execFileAsync = promisify(execFile);

export interface RecordedAgentRun {
    sessionId: string;
    origin: string | undefined;
    cwd: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    temperature: number | undefined;
    reasoningEffort: string | undefined;
    toolNames: string[];
    systemPromptText: string;
    taskPrompt: string;
}

export interface RecordedLlmCall {
    options: GenerateOptions;
}

export type MockAgentDriver = (ctx: {
    sessionId: string;
    taskPrompt: string;
    systemPromptText: string;
    tools: Map<string, ToolDefinition>;
    execTool: (name: string, args: unknown) => Promise<unknown>;
    agentCtx: Context;
    agent: Agent;
    signal: AbortSignal;
}) => Promise<void>;

/** 创建带 Git 初始提交的测试作品工作区 */
export async function createGitBookWorkspace(
    tempDirs: string[],
    slug: string,
    options: {
        title?: string;
        povCharId?: string;
        storyDay?: number;
        currentChapter?: number;
        voiceSamplesYaml?: string;
        extraEntities?: Record<string, string>;
        extraChapters?: Record<string, string>;
    } = {}
): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `narrateos-pipe-${slug}-`));
    tempDirs.push(root);

    for (const dir of [
        'world',
        'lore_library',
        'index/L2_cards',
        'entities/cold_archive',
        'manuscripts',
        '.ops'
    ]) {
        await mkdir(join(root, dir), { recursive: true });
    }

    const povCharId = options.povCharId ?? 'char_001';
    const storyDay = options.storyDay ?? 0;
    const currentChapter = options.currentChapter ?? 0;

    await writeFile(
        join(root, 'world/book_config.yaml'),
        [
            `book_slug: ${slug}`,
            `title: ${options.title ?? slug}`,
            'tokens_per_char: 0.6',
            'narration_subjectivity: objective_third',
            'trace_level: full',
            'max_auto_rollback_chapters: 3',
            'structured_json_retry:',
            '  max_retries: 2',
            '  backoff_ms: [0, 0]'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/world_state.md'),
        [
            '---',
            `story_day: ${storyDay}`,
            'current_volume: 1',
            `current_chapter: ${currentChapter}`,
            `pov_character: ${povCharId}`,
            'timeline_mode: MAINLINE',
            '---',
            '',
            '海港处于封港戒备前夕，旧账房与泊位调度仍在运转。'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/author_charter.md'),
        [
            '# 作者契约 (Author Charter)',
            '',
            '## T0 开局现场原话锚点',
            'CHARTER_SECRET_ANCHOR: 沈默在三号码头旧货栈核对潮汐账册，严禁出现超自然读心。',
            '',
            '## 已排除廉价套路',
            '- 禁止天降机械降神救场'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/arc_director_plan.md'),
        [
            '# 导演禁区与开篇节拍计划',
            '',
            '## Stage Ceiling (阶段天花板禁区)',
            'DIRECTOR_SECRET_CEILING: 本阶段严禁揭露海关副署长与沉船保险金的黑幕交易。',
            '',
            '## Opening Sequence Beats',
            '- [status: PENDING] Beat 1: 码头核对潮汐单与旧钥匙现身'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/current_arc_envelope.md'),
        [
            '# 当前卷正向舞台',
            '',
            '三号码头货栈夜间清点潮汐账册，老舵工与新到验货员各自盘算货轮停靠时机。'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/static_base_and_voice.md'),
        [
            '# 世界静态基线与文风纪律',
            '',
            '- 写实海港物流背景，无超自然能力。',
            '- 第三人称客观镜头推进，通过人物动作与对白展现态度。'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/future_horizon.md'),
        [
            '# 世界默认惯性表 (Future Horizon)',
            '',
            '- [event:evt_tide | day:2 | status:ACTIVE] 港务局将在涨潮后查封二号仓库',
            '- [event:evt_warped | day:1 | status:WARPED] WARPED_SECRET_ENTRY: 原定周三出发的货轮已提前离港'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'world/open_threads.md'),
        [
            '# 跨卷伏笔台账 (Open Threads)',
            '',
            '## 活跃未解伏笔 (Active Threads)',
            '- [thread_key | status: ACTIVE] item_001 黄铜钥匙究竟能打开哪一扇旧闸门',
            '',
            '## 已回收伏笔归档 (Resolved Archive)'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'index/L0_sagas.md'),
        '# L0 纪元折叠总表\n',
        'utf8'
    );
    await writeFile(
        join(root, 'index/L1_volumes.md'),
        '# L1 活跃卷级总表\n\n- 第 1 卷：潮汐旧账（进行中）\n',
        'utf8'
    );
    await writeFile(
        join(root, 'index/L2_cards/vol_01_cards.md'),
        '# 第 1 卷双轨章卡\n',
        'utf8'
    );

    await writeFile(
        join(root, `entities/${povCharId}.md`),
        [
            '---',
            `entity_id: ${povCharId}`,
            'canonical_name: 沈默',
            'unique_aliases: ["默哥", "沈验货"]',
            'contextual_titles: ["验货员"]',
            'historical_anchors: []',
            `last_seen_ch: ${currentChapter}`,
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 右手虎口有旧日缆绳勒伤浅疤',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级更新)',
            '- [day:0 | ch:0 | vis: PUBLIC] 驻留节点：三号码头货栈',
            '- [day:0 | ch:0 | vis: SELF_ONLY] 怀疑账簿页码被人为撕走一页',
            '- [day:0 | ch:0 | vis: OMNISCIENT_SECRET] OMNISCIENT_SECRET_TOKEN: 沈默其实在暗中替失踪兄长查账',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '- [day:0 | ch:0] 接下三号码头夜班清点任务',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            '- [day:0 | ch:0] 提灯走进货栈西门'
        ].join('\n') + '\n',
        'utf8'
    );

    await writeFile(
        join(root, 'entities/char_002.md'),
        [
            '---',
            'entity_id: char_002',
            'canonical_name: 林小满',
            'unique_aliases: ["小满"]',
            'contextual_titles: ["记账学徒"]',
            'historical_anchors: []',
            'last_seen_ch: 0',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 左耳垂有小块缺口',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级更新)',
            '- [day:0 | ch:0 | vis: SELF_ONLY] SELF_ONLY_CHAR002_SECRET: 林小满私下把半张船票缝在棉袄里',
            '- [day:0 | ch:0 | vis: PUBLIC] 在东侧账房抄录船期表',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '- [day:0 | ch:0] 来到码头当学徒',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            '- [day:0 | ch:0] 低头拨弄算盘珠子'
        ].join('\n') + '\n',
        'utf8'
    );

    if (options.extraEntities) {
        for (const [id, md] of Object.entries(options.extraEntities)) {
            await writeFile(join(root, 'entities', `${id}.md`), md, 'utf8');
        }
    }

    if (options.extraChapters) {
        for (const [fileName, content] of Object.entries(options.extraChapters)) {
            await writeFile(join(root, 'manuscripts', fileName), content, 'utf8');
        }
    }

    await writeFile(
        join(root, '.ops/voice_samples.yaml'),
        options.voiceSamplesYaml ?? 'samples: []\n',
        'utf8'
    );

    // 初始化 git 仓并登记 WAL 指纹
    await execFileAsync('git', ['init', '-b', 'main', root]);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'NarrateOS Test']);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@narrateos.local']);

    const store = new BookStore(root, new NodeSystemAdapter());
    await store.initializeWalFromDisk();

    await execFileAsync('git', ['-C', root, 'add', '.']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'chore: init test book']);
    return root;
}

/** 创建可注入 Cordis 的无头 mock ctx.llm 与 ctx.agents（通过 Cordis inject 继承 tools 与 systemPrompt，行为与 dsh-agent-loop 一致） */
export async function createHeadlessMockServices(
    ctx: Context,
    handlers: {
        onAgent: MockAgentDriver;
        onLlmStream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
        resolveModelInfo?: LlmRuntime['resolveModelInfo'];
    }
): Promise<{
    agentRuns: RecordedAgentRun[];
    llmCalls: RecordedLlmCall[];
}> {
    const agentRuns: RecordedAgentRun[] = [];
    const llmCalls: RecordedLlmCall[] = [];

    const mockLlm = {
        stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
            llmCalls.push({ options });
            return handlers.onLlmStream(options);
        },
        ...(handlers.resolveModelInfo ? { resolveModelInfo: handlers.resolveModelInfo } : {})
    } as unknown as LlmRuntime;

    ctx.provide('llm', mockLlm);

    await ctx.plugin({
        name: 'mock-agent-loop',
        inject: ['tools', 'systemPrompt'] as const,
        apply(loopCtx) {
            const mockExecutor: ToolExecutor = {
                describe(tools) {
                    return {
                        schemas: [],
                        knownNames: tools.map((tool) => tool.name)
                    };
                },
                async execute(input) {
                    return {
                        results: input.calls.map((call) => ({
                            callId: call.id,
                            result: {
                                value: null,
                                content: [],
                                isError: false
                            }
                        })),
                        additionalContexts: [],
                        concluded: false
                    };
                }
            };
            const disposeExecutor = loopCtx.tools.setExecutor(mockExecutor);
            loopCtx.effect(() => disposeExecutor);

            const mockAgents = {
                async create(options: CreateAgentOptions): Promise<AgentHandle> {
                    let idleResolve: (() => void) | undefined;
                    const idlePromise = new Promise<void>((r) => {
                        idleResolve = r;
                    });
                    const ac = new AbortController();
                    const fakeAgent = {
                        id: options.sessionId,
                        session: { id: options.sessionId },
                        options: options.agentOptions ?? {},
                        status: 'idle' as const
                    } as unknown as Agent;

                    const scope = createScope(loopCtx, fakeAgent);
                    const agentCtx = scope.ctx;
                    (fakeAgent as { ctx: Context }).ctx = agentCtx;

                    if (options.setup) {
                        await options.setup(agentCtx, fakeAgent);
                    }

                    const registeredTools = new Map<string, ToolDefinition>();
                    for (const def of agentCtx.tools.definitions(fakeAgent)) {
                        registeredTools.set(def.name, def);
                    }

                    let capturedSystemPrompt = '';
                    if (agentCtx.systemPrompt) {
                        const assembly = await agentCtx.systemPrompt.assemble({
                            scope: fakeAgent
                        });
                        capturedSystemPrompt = renderPrompt(assembly);
                    }

                    const callConfig = await agentEvents(agentCtx, fakeAgent).waterfall(
                        'agent/request',
                        { turn: 1, step: 1, signal: ac.signal },
                        () =>
                            Promise.resolve({
                                provider: options.agentOptions?.provider ?? '',
                                model: options.agentOptions?.model ?? ''
                            } as LlmCallConfig)
                    );

                    const execTool = async (name: string, args: unknown): Promise<unknown> => {
                        const def = registeredTools.get(name);
                        if (!def) {
                            throw new Error(`工具 ${name} 未在当前工种作用域内注册`);
                        }
                        const runCtx: ToolRunContext = {
                            token: Symbol('exec') as ToolRunContext['token'],
                            callId: `call-${name}` as ToolCallId,
                            rootCallId: `call-${name}` as ToolCallId,
                            name,
                            arguments: args,
                            signal: ac.signal,
                            deferContext() {},
                            concludeTurn() {}
                        };
                        return await def.execute(args as never, runCtx);
                    };

                    let started = false;
                    const steerQueue: unknown[] = [];

                    (fakeAgent as { cancel: Agent['cancel'] }).cancel = () => {
                        ac.abort(new Error('Agent cancelled'));
                    };
                    (fakeAgent as { steer: Agent['steer'] }).steer = (msg) => {
                        steerQueue.push(msg);
                    };
                    (fakeAgent as { whenIdle: Agent['whenIdle'] }).whenIdle = () => idlePromise;
                    (fakeAgent as { followup: Agent['followup'] }).followup = (msg) => {
                        if (typeof msg.id !== 'string' || msg.id.length === 0 || msg.role !== 'user') {
                            throw new Error(
                                `Invalid UserMessage passed to agent.followup: id=${String(msg.id)}, role=${String(msg.role)}`
                            );
                        }
                        if (started) return;
                        started = true;
                        const taskPrompt = msg.content
                            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                            .map((b) => b.text)
                            .join('\n');

                        agentRuns.push({
                            sessionId: String(options.sessionId),
                            origin: options.meta?.origin,
                            cwd: options.meta?.cwd,
                            provider: options.agentOptions?.provider,
                            model: options.agentOptions?.model,
                            temperature: callConfig.temperature,
                            reasoningEffort: options.agentOptions?.reasoningEffort,
                            toolNames: [...registeredTools.keys()],
                            systemPromptText: capturedSystemPrompt,
                            taskPrompt
                        });

                        void (async () => {
                            try {
                                await handlers.onAgent({
                                    sessionId: String(options.sessionId),
                                    taskPrompt,
                                    systemPromptText: capturedSystemPrompt,
                                    tools: registeredTools,
                                    execTool,
                                    agentCtx,
                                    agent: fakeAgent,
                                    signal: ac.signal
                                });
                            } catch {
                                // 忽略 mock agent 被取消或测试断言触发的内部抛错
                            } finally {
                                idleResolve?.();
                            }
                        })();
                    };

                    return {
                        agent: fakeAgent,
                        async dispose() {
                            agentCtx.emit(scopeTarget(fakeAgent, fakeAgent), 'agent/disposed', {
                                agent: fakeAgent
                            });
                            await scope.dispose();
                        }
                    };
                }
            };

            loopCtx.provide('agents', mockAgents as never);
        }
    });

    return { agentRuns, llmCalls };
}

/** 将纯文本包装为标准 StreamChunk 异步生成器 */
export async function* textToStreamChunks(text: string): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield {
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 40, cacheWriteTokens: 10 }
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
}
