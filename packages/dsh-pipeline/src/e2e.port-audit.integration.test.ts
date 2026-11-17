import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import type { LockCharterAndBootResult } from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as pipelinePlugin from './index.js';
import { createHeadlessMockServices, textToStreamChunks } from './test-harness.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

function registerCleanup(fn: () => Promise<void> | void): void {
    cleanupCallbacks.push(fn);
}

function createMockWebServer(ctx: Context) {
    const routes = new Map<string, WebRoute['handler']>();
    const mockWebServer = {
        register(route: WebRoute) {
            const key = `${route.kind}:${route.path}`;
            routes.set(key, route.handler);
            return () => {
                routes.delete(key);
            };
        }
    } as unknown as Pick<WebServer, 'register'>;
    ctx.provide('webServer', mockWebServer as WebServer);

    async function invoke(
        method: string,
        url: string,
        body?: unknown
    ): Promise<{ statusCode: number; json: Record<string, unknown> }> {
        const parsedUrl = new URL(url, 'http://127.0.0.1');
        const handler = routes.get(`exact:${parsedUrl.pathname}`);
        if (!handler) {
            return { statusCode: 404, json: { error: `Route not found: ${parsedUrl.pathname}` } };
        }
        const reqStream = new PassThrough();
        const req = reqStream as unknown as IncomingMessage;
        req.method = method;
        req.url = url;
        reqStream.end(body !== undefined ? JSON.stringify(body) : undefined);

        const chunks: Buffer[] = [];
        let resolveDone: (() => void) | undefined;
        const done = new Promise<void>((r) => {
            resolveDone = r;
        });
        const res = Object.assign(new EventEmitter(), {
            writableEnded: false,
            destroyed: false,
            statusCode: 200,
            setHeader() {},
            write(chunk: string | Buffer) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return true;
            },
            end(chunk?: string | Buffer) {
                if (chunk) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                (res as { writableEnded: boolean }).writableEnded = true;
                resolveDone?.();
            }
        }) as unknown as ServerResponse;

        await handler(req, res);
        await done;
        const raw = Buffer.concat(chunks).toString('utf8');
        return {
            statusCode: res.statusCode,
            json: raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
        };
    }

    async function openSse() {
        const handler = routes.get('exact:/api/narrate/events');
        if (!handler) {
            throw new Error('SSE 路由未注册');
        }
        const req = new EventEmitter() as unknown as IncomingMessage;
        req.method = 'GET';
        req.url = '/api/narrate/events';

        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        const waiters: Array<{
            predicate: (evt: { event: string; data: Record<string, unknown> }) => boolean;
            resolve: (evt: { event: string; data: Record<string, unknown> }) => void;
        }> = [];
        let buffer = '';

        const res = Object.assign(new EventEmitter(), {
            writableEnded: false,
            destroyed: false,
            statusCode: 200,
            setHeader() {},
            flushHeaders() {},
            write(chunk: string | Buffer) {
                buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
                const frames = buffer.split('\n\n');
                buffer = frames.pop() ?? '';
                for (const frame of frames) {
                    if (!frame.trim() || frame.startsWith(':')) continue;
                    const eventMatch = /^event:\s*(.+)$/m.exec(frame);
                    const dataMatch = /^data:\s*(.+)$/m.exec(frame);
                    if (eventMatch?.[1] && dataMatch?.[1]) {
                        const evt = {
                            event: eventMatch[1].trim(),
                            data: JSON.parse(dataMatch[1]) as Record<string, unknown>
                        };
                        events.push(evt);
                        for (let i = waiters.length - 1; i >= 0; i -= 1) {
                            const w = waiters[i]!;
                            if (w.predicate(evt)) {
                                waiters.splice(i, 1);
                                w.resolve(evt);
                            }
                        }
                    }
                }
                return true;
            },
            end(chunk?: string | Buffer) {
                if (chunk) {
                    this.write(chunk);
                }
                (res as { writableEnded: boolean }).writableEnded = true;
            }
        }) as unknown as ServerResponse;

        await handler(req, res);
        return {
            events,
            waitForEvent(
                predicate: (evt: { event: string; data: Record<string, unknown> }) => boolean,
                fromIndex = events.length
            ) {
                const hit = events.slice(fromIndex).find(predicate);
                if (hit) return Promise.resolve(hit);
                return new Promise<{ event: string; data: Record<string, unknown> }>((resolve) => {
                    waiters.push({ predicate, resolve });
                });
            },
            close: () => {
                (req as unknown as EventEmitter).emit('close');
            }
        };
    }

    return { invoke, openSse };
}

function createMockCommandsRuntime(ctx: Context) {
    const defs = new Map<string, CommandDefinition>();
    ctx.provide('commands', {
        register(def: CommandDefinition) {
            defs.set(def.name, def);
            return () => {
                defs.delete(def.name);
            };
        }
    } as never);

    return {
        async invokeCommand(name: string, rawInput = '') {
            const def = defs.get(name);
            if (!def) throw new Error(`未注册命令 /${name}`);
            return await def.handler({
                commandId: `cmd-${name}` as never,
                agent: { id: 'main-session' } as unknown as Agent,
                rawInput,
                attachments: [],
                signal: new AbortController().signal
            });
        }
    };
}

afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
        const fn = cleanupCallbacks.pop();
        if (fn) {
            try {
                await fn();
            } catch {
                // 清理期容错
            }
        }
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('Phase 3 港口审计同源种子端到端集成测试 (无头真实 Git + Cordis 多智能体管线)', () => {
    it('完整跑通：lock_charter_and_boot 0 声纹停机 -> Ch.01 + Voice Harvest -> Ch.02 + 信号注入 -> Dreaming -> 换卷 -> 0-Token 斜杠命令与 HTTP 详情下钻', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-e2e-port-audit-'));
        tempDirs.push(booksRoot);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const skillFiber = await ctx.plugin(SkillRegistry);
        registerCleanup(() => skillFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const web = createMockWebServer(ctx);
        const cmdRuntime = createMockCommandsRuntime(ctx);

        let chapterCounter = 0;
        const plannerTaskPrompts: string[] = [];

        const { llmCalls } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ sessionId, taskPrompt, tools, execTool }) => {
                // 模拟真实 DSH assistant/message usage 事件以便汇总多轮 token usage
                ctx.emit('session/event' as never, { id: sessionId } as never, {
                    type: 'assistant/message',
                    data: {
                        usage: {
                            inputTokens: 150,
                            cacheReadTokens: 30,
                            cacheWriteTokens: 10,
                            outputTokens: 60
                        }
                    }
                } as never);

                if (tools.has('yield_context_pack')) {
                    const globRes = (await execTool('book_glob', { pattern: '*.md' })) as {
                        files: string[];
                    };
                    await execTool('book_read', { path: 'world/world_state.md' });
                    const hasPriorManuscripts = globRes.files.some((f) =>
                        f.startsWith('manuscripts/')
                    );
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_shen', 'item_tally'],
                        recall_queries: hasPriorManuscripts
                            ? [{ entity_id: 'item_tally', extra_keywords: ['提货单'] }]
                            : [],
                        selected_lore_files: []
                    });
                    return;
                }

                if (tools.has('yield_outline')) {
                    chapterCounter += 1;
                    plannerTaskPrompts.push(taskPrompt);
                    await execTool('book_read', { path: 'entities/char_shen.md' });
                    await execTool('yield_outline', {
                        chapter_title:
                            chapterCounter === 1
                                ? '三号仓冷账'
                                : chapterCounter === 2
                                  ? '夜班墨迹'
                                  : '锚地换防',
                        target_word_count: 2200,
                        focus_cast: ['char_shen'],
                        background_cast: ['char_zhou'],
                        ending_beat: 'HOOK',
                        director_rationale:
                            'DIRECTOR_SECRET_RATIONALE: 海关副署长将在第二卷浮出水面，首卷仅查账册差额。',
                        chapter_turn: '沈默核出三号仓夜间出库单缺少复核印章。',
                        scene_plan: [
                            {
                                scene_index: 1,
                                location: '北港三号仓',
                                summary: '核对夜班货单与船期表',
                                is_spotlight: true
                            }
                        ],
                        outline_text:
                            chapterCounter === 1
                                ? '沈默提灯步入北港三号仓外廊，翻开夜班交接簿核对油印日期。'
                                : '沈默顺着老周的班次记录追查驳船去向，在风灯下比对拖轮号牌。'
                    });
                    return;
                }

                if (tools.has('yield_verdict')) {
                    await execTool('book_read', { path: 'entities/char_shen.md' });
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }

                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [
                            {
                                entity_id: 'char_shen',
                                last_seen_ch: chapterCounter,
                                acquired_state_ops: [
                                    {
                                        op: 'upsert_slot',
                                        slot_key: 'location',
                                        entry: {
                                            storyDay: chapterCounter,
                                            chapter: chapterCounter,
                                            visibility: 'PUBLIC',
                                            text:
                                                chapterCounter === 1
                                                    ? '北港三号仓账房'
                                                    : '北港驳船泊位'
                                        }
                                    }
                                ],
                                buffer_ops: [
                                    {
                                        op: 'append',
                                        entry: {
                                            storyDay: chapterCounter,
                                            chapter: chapterCounter,
                                            visibility: 'PUBLIC',
                                            text: `第 ${chapterCounter} 章核验完成`
                                        }
                                    }
                                ]
                            }
                        ],
                        story_day_delta: 1,
                        chapter_summary: `第 ${chapterCounter} 章推进港口账册核验。`,
                        next_chapter_options: ['查验拖轮交接簿', '核对仓库封条记录']
                    });
                    return;
                }

                if (tools.has('yield_dream_commit')) {
                    await execTool('book_read', { path: 'world/arc_director_plan.md' });
                    await execTool('book_edit', {
                        path: 'world/arc_director_plan.md',
                        target_text: '- [status: PENDING] 节拍一 |',
                        replacement_text: '- [status: DONE] 节拍一 |'
                    });
                    await execTool('yield_dream_commit', {
                        summary: '睡眠整理完成：节拍一已兑现并记录焦点实体状态',
                        chapter_number: 2,
                        accumulated_words: 1500,
                        spotlight_triggers: [
                            {
                                entity_id: 'char_zhou',
                                reason: '值班仓管老周的夜间交接单将在下章正面对质',
                                suggested_mode: 'MAINLINE'
                            }
                        ]
                    });
                }
            },
            onLlmStream: (opts) => {
                const sys = opts.system ?? '';
                if (sys.includes('Voice Harvest')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            samples: [
                                {
                                    tag: '白描动作',
                                    text: '铁皮棚门推开半寸，冷风卷着雪末落在算盘木框上。'
                                },
                                {
                                    tag: '克制对白',
                                    text: '「骑缝章歪了三分，昨夜到底是谁点过的货？」'
                                },
                                {
                                    tag: '感官节奏',
                                    text: '煤油灯芯爆了个灯花，账页边缘的红墨印子渐渐显了出来。'
                                }
                            ]
                        })
                    );
                }
                if (sys.includes('卷级归档编纂器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            volume_summary: '第 1 卷核明北港三号仓夜间倒运与账册缺页真相。',
                            story_day_span: 'day 0 ~ day 2'
                        })
                    );
                }
                if (sys.includes('卷级大纲编译器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            current_arc_envelope:
                                '# 第 2 卷正向舞台\n\n外港锚地与缉私队交接全面展开。',
                            future_horizon:
                                '# 第 2 卷未来惯性\n\n- [event:evt_anchorage | day:3 | status:ACTIVE] 外港锚地封锁检查'
                        })
                    );
                }
                // 净室 Writer 产出
                return textToStreamChunks(
                    [
                        '<blocking>北港三号仓账房内，沈默立于木桌前。</blocking>',
                        '',
                        '雪水顺着铁皮屋檐往下滴，砸在门前青石板上发出规律的轻响。',
                        '',
                        '沈默把提灯往账册左角挪近两寸，对照手里半张提货单，指腹顺着骑缝编号逐行往下滑，停在十二月十七日那栏空白处。'
                    ].join('\n')
                );
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { booksRoot, heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        // =========================================================================
        // 1. 以「港口审计」种子通过 lock_charter_and_boot 开书（0 声纹样本）
        // =========================================================================
        const bootTool = ctx.tools.get('lock_charter_and_boot');
        expect(bootTool).toBeDefined();

        const bootExecCtx: ToolRunContext = {
            token: Symbol('boot') as ToolRunContext['token'],
            callId: 'call-boot' as ToolRunContext['callId'],
            rootCallId: 'call-boot' as ToolRunContext['rootCallId'],
            name: 'lock_charter_and_boot',
            arguments: {},
            signal: new AbortController().signal,
            deferContext() {},
            concludeTurn() {}
        };
        const bootRes = (await bootTool!.execute(
            {
                book_slug: 'port-audit',
                title: '港口审计',
                pov_character: 'char_shen',
                t0_anchor: 'PORT_AUDIT_CHARTER_SECRET: 腊月大雪夜，北港三号仓只剩半张盖过戳的提货单。',
                commitments: [
                    '写实海港审计与缉私推演',
                    '以真实账目单据与人物交锋推进'
                ],
                stage_ceiling:
                    'PORT_AUDIT_STAGE_CEILING: 第一卷严禁揭露海关副署长幕后签批名单。',
                opening_sequence_beats: [
                    {
                        beat_label: '节拍一',
                        craft_focus: '建立冬夜三号仓清点压迫感',
                        clue_budget: '仅放出仓号与油印日期',
                        completion_sign: '确认夜间货单缺少复核章'
                    },
                    {
                        beat_label: '节拍二',
                        craft_focus: '盘问值班仓管老周',
                        clue_budget: '放出异常交接班次',
                        completion_sign: '墨水未干露出破绽'
                    },
                    {
                        beat_label: '节拍三',
                        craft_focus: '锁定驳船泊位号牌',
                        clue_budget: '拖轮船号尾数',
                        completion_sign: '引出第一幕主线转折'
                    }
                ],
                current_arc_envelope:
                    '寒冬凌晨的北港三号泊位，沈默沿码头账册与交接班次核验货物去向。',
                static_base_and_voice:
                    '第三人称客观镜头，短句克制，注重单据编号、灯火光影与器械动作。',
                world_summary: '腊月封港前夕，北港三号仓发生一宗账实不符的夜班提货异动。',
                l1_volumes_markdown: '# L1 活跃卷级总表\n\n- vol_01: 腊月冷账（进行中）\n',
                future_horizon_events: [
                    {
                        event_id: 'evt_audit_seal',
                        story_day: 2,
                        premise: '港务局例行盘库',
                        description: 'WARPED_HIDDEN_FUTURE: 港务局将在涨潮前查封三号仓'
                    }
                ],
                entities: [
                    {
                        entityId: 'char_shen',
                        canonicalName: '沈默',
                        uniqueAliases: ['沈验货'],
                        innateLocks: [{ visibility: 'PUBLIC', text: '右手食指微曲' }],
                        acquiredState: [
                            { storyDay: 0, visibility: 'PUBLIC', slotKey: 'location', text: '北港三号仓外廊' },
                            {
                                storyDay: 0,
                                visibility: 'OMNISCIENT_SECRET',
                                text: 'OMNISCIENT_SECRET_SHEN: 沈默暗中带着总署密令核查港口旧账'
                            }
                        ],
                        irreversibleTrajectory: [{ storyDay: 0, text: '签收半张提货单并赶往三号仓' }],
                        recentBuffer: []
                    },
                    {
                        entityId: 'char_zhou',
                        canonicalName: '老周',
                        uniqueAliases: ['周仓管'],
                        innateLocks: [{ visibility: 'PUBLIC', text: '左脚微跛' }],
                        acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', text: '三号仓夜班值守' }],
                        irreversibleTrajectory: [],
                        recentBuffer: []
                    },
                    {
                        entityId: 'item_tally',
                        canonicalName: '半张提货单',
                        uniqueAliases: ['残单'],
                        innateLocks: [{ visibility: 'PUBLIC', text: '右下角缺角且盖有蓝色油印戳' }],
                        acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', text: '由 char_shen 贴身保管' }],
                        irreversibleTrajectory: [],
                        recentBuffer: []
                    }
                ],
                voice_samples: []
            },
            bootExecCtx
        )) as LockCharterAndBootResult;

        expect(bootRes.halted).toBe(true);
        expect(bootRes.voiceSampleCount).toBe(0);
        expect(existsSync(join(bootRes.bookRoot, 'manuscripts/ch_0001.md'))).toBe(false);
        expect(existsSync(join(bootRes.bookRoot, 'world/author_charter.md'))).toBe(true);
        expect(existsSync(join(bootRes.bookRoot, 'world/arc_director_plan.md'))).toBe(true);
        const initVoiceYaml = await readFile(join(bootRes.bookRoot, '.ops/voice_samples.yaml'), 'utf8');
        expect(initVoiceYaml.trim()).toBe('samples: []');

        // 切书激活港口审计工作区
        await ctx.narratePipeline.switchBook(bootRes.bookRoot);

        // =========================================================================
        // 2. Ch.01 stepChapter + Voice Harvest + Cleanroom Writer 物理隔离校验
        // =========================================================================
        const ch1Res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '夜访三号仓核对提货单与交接簿（消费节拍一）'
        });
        expect(ch1Res.status).toBe('COMMITTED');
        expect(ch1Res.chapterNumber).toBe(1);
        expect(ch1Res.totalUsage.inputTokens).toBeGreaterThan(0);
        expect(ch1Res.totalUsage.outputTokens).toBeGreaterThan(0);

        const ch1Disk = await readFile(join(bootRes.bookRoot, 'manuscripts/ch_0001.md'), 'utf8');
        expect(ch1Disk).toContain('骑缝编号');
        const { stdout: gitLogCh1 } = await execFileAsync(
            'git',
            ['-C', bootRes.bookRoot, 'log', '--oneline', '-n', '5'],
            { encoding: 'utf8' }
        );
        expect(gitLogCh1).toContain('feat(ch-0001)');
        expect(gitLogCh1).toContain('state(ch-0001)');

        // 验证 Cleanroom Writer 物理不可见 author_charter / arc_director_plan / OMNISCIENT_SECRET / WARPED
        expect(llmCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of llmCalls) {
            expect(call.options.tools).toBeUndefined();
            expect(call.options.sessionId).toBeUndefined();
            const fullText = `${call.options.system ?? ''}\n${JSON.stringify(call.options.messages)}`;
            expect(fullText).not.toContain('PORT_AUDIT_CHARTER_SECRET');
            expect(fullText).not.toContain('PORT_AUDIT_STAGE_CEILING');
            expect(fullText).not.toContain('OMNISCIENT_SECRET_SHEN');
            expect(fullText).not.toContain('WARPED_HIDDEN_FUTURE');
            expect(fullText).not.toContain('DIRECTOR_SECRET_RATIONALE');
        }

        // 触发首章校准 Voice Harvest 写入 .ops/voice_samples.yaml
        const harvestRes = await ctx.narratePipeline.harvestVoiceFromChapter(1);
        expect(harvestRes.skipped).toBe(false);
        expect(harvestRes.harvestedCount).toBe(3);
        const harvestedPool = await ctx.narrateStore.openStore().readVoiceSamples();
        expect(harvestedPool.samples).toHaveLength(3);

        // =========================================================================
        // 3. Ch.02 + 信号注入 + Dreaming + 换卷 + 0-Token 斜杠命令 + HTTP 详情下钻
        // =========================================================================
        // 3.1 /narrate-status（0 Token 只读）
        const llmCountBeforeCmds = llmCalls.length;
        const statusCmd = await cmdRuntime.invokeCommand('narrate-status');
        expect(statusCmd.kind).toBe('success');
        expect(statusCmd.text).toContain('港口审计');
        expect(statusCmd.text).toContain('第 1 卷 第 1 章');
        expect(llmCalls.length).toBe(llmCountBeforeCmds);

        // 3.2 /narrate-signal 注入读者微调指令（0 Token）
        const sigCmd = await cmdRuntime.invokeCommand(
            'narrate-signal',
            '第二章增加驳船码头雪夜探照灯扫射的压迫感'
        );
        expect(sigCmd.kind).toBe('success');
        expect(llmCalls.length).toBe(llmCountBeforeCmds);

        // 3.3 推进 Ch.02，校验信号注入 Planner 且游标持久化消费
        const ch2Res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 2,
            chapterGoal: '追查夜间驳船去向'
        });
        expect(ch2Res.status).toBe('COMMITTED');
        expect(plannerTaskPrompts[1]).toContain('雪夜探照灯');
        expect(await ctx.narratePipeline.countPendingSignals()).toBe(0);

        // 3.4 多轮 Dreaming 更新节拍与实体，验证 usage 汇总与 DREAM_COMMITTED
        const dreamRes = await ctx.narratePipeline.runDreaming({
            currentChapter: 2,
            force: true
        });
        expect(dreamRes.skipped).toBe(false);
        expect(dreamRes.committedPaths).toContain('world/arc_director_plan.md');
        expect(dreamRes.committedTxState?.phase).toBe('DREAM_COMMITTED');
        expect(dreamRes.usage.inputTokens).toBe(150);
        expect(dreamRes.usage.outputTokens).toBe(60);

        // 3.5 /narrate-step 异步推进第 3 章并通过 SSE 确定性等待收束
        const ch3Committed = sse.waitForEvent(
            (e) =>
                e.event === 'chapter:phase' &&
                e.data['phase'] === 'COMMITTED' &&
                e.data['chapterNumber'] === 3
        );
        const stepIdle = sse.waitForEvent(
            (e) => e.event === 'task:idle' && e.data['task'] === 'STEPPING'
        );
        const stepCmd = await cmdRuntime.invokeCommand('narrate-step', '锚地核验');
        expect(stepCmd.kind).toBe('success');
        expect(stepCmd.text).toContain('异步启动');
        await Promise.all([ch3Committed, stepIdle]);

        // 3.6 advanceVolume 五步换卷
        const volRes = await ctx.narratePipeline.advanceVolume({
            companionEntityIds: ['char_zhou']
        });
        expect(volRes.sealedVolume).toBe(1);
        expect(volRes.nextVolume).toBe(2);
        expect(volRes.tagName).toBe('arc-seal-vol-01');

        // 3.7 HTTP GET /api/narrate/runs 与 /api/narrate/runs/detail?sessionId=... 下钻校验
        const runsRes = await web.invoke('GET', '/api/narrate/runs?chapter=1');
        expect(runsRes.statusCode).toBe(200);
        const runs = runsRes.json['runs'] as Array<{ stage: string; sessionId: string }>;
        const libRun = runs.find((r) => r.stage === 'LIBRARIAN');
        expect(libRun).toBeDefined();

        const detailRes = await web.invoke(
            'GET',
            `/api/narrate/runs/detail?sessionId=${encodeURIComponent(libRun!.sessionId)}`
        );
        expect(detailRes.statusCode).toBe(200);
        const events = detailRes.json['events'] as Array<{
            kind: string;
            toolName?: string;
            status?: string;
        }>;
        // 验证包含唯一真实的 tool-call / tool-result 记录（无重复）
        expect(events.filter((e) => e.kind === 'tool-call' && e.toolName === 'book_glob')).toHaveLength(1);
        expect(events.filter((e) => e.kind === 'tool-result' && e.toolName === 'book_glob')).toHaveLength(1);
        expect(events.filter((e) => e.kind === 'tool-call' && e.toolName === 'yield_context_pack')).toHaveLength(1);
        expect(events.filter((e) => e.kind === 'tool-result' && e.toolName === 'yield_context_pack' && e.status === 'completed')).toHaveLength(1);

        // 验证遥测视图中的 token_usage 统计
        const telemetryRes = await web.invoke('GET', '/api/narrate/views?kind=telemetry');
        expect(telemetryRes.statusCode).toBe(200);
        const telemetryEntries = telemetryRes.json['entries'] as Array<{
            chapter: number;
            token_usage: { inputTokens: number; outputTokens: number };
        }>;
        expect(telemetryEntries.length).toBeGreaterThanOrEqual(2);
        expect(telemetryEntries[0]!.token_usage.inputTokens).toBeGreaterThan(0);
        expect(telemetryEntries[0]!.token_usage.outputTokens).toBeGreaterThan(0);
    });
});
