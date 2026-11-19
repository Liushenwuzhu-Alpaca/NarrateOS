import { execFile } from 'node:child_process';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { BookStore, NodeSystemAdapter } from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleLoader } from '../roles/role-loader.js';
import { DshLlmAdapter } from '../runner/dsh-llm-adapter.js';
import { RoleRunner } from '../runner/role-runner.js';
import { createGitBookWorkspace, createHeadlessMockServices, textToStreamChunks } from '../test-harness.js';
import { ChapterPipeline } from './chapter-pipeline.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
const ledgerPaths = ['world/arc_director_plan.md', 'world/open_threads.md'] as const;
const initialPlan = [
    '# 开篇节拍',
    '',
    '- [status: PENDING] 节拍一：核对封港日期',
    '- [status: PENDING] 节拍三：查验西门',
    '- [status: PENDING] beat 3: 查验东门',
    '- [status: PENDING] 节拍十：查明船票去向',
    ''
].join('\n');
const initialThreads = [
    '# 活跃伏笔',
    '',
    '- [thread_1 | status: ACTIVE] 封港日期有误',
    '- [thread_10 | status: ACTIVE] 船票去向不明',
    '- [thread_legacy] 账册缺页',
    ''
].join('\n');
const finalConfirmations = {
    completed_beats: ['beat 01', '3'],
    resolved_threads: ['thread_1', 'thread_legacy']
};

async function readLedgers(root: string): Promise<string[]> {
    return await Promise.all(ledgerPaths.map(path => readFile(join(root, path), 'utf8')));
}

async function ledgerCommits(root: string, since: string): Promise<string[]> {
    const { stdout } = await execFileAsync('git', [
        '-C', root, 'log', '--format=%H', `${since}..HEAD`, '--', ...ledgerPaths
    ]);
    return stdout.trim().split('\n').filter(Boolean);
}

async function setupChapter(slug: string, rewriteFirst = false) {
    const root = await createGitBookWorkspace(tempDirs, slug, { storyDay: 5 });
    await writeFile(join(root, ledgerPaths[0]), initialPlan, 'utf8');
    await writeFile(join(root, ledgerPaths[1]), initialThreads, 'utf8');
    // 声纹采样不属于账本协议，使用正式配置避免恢复期额外调用 LLM。
    await appendFile(join(root, 'world/book_config.yaml'), 'opening:\n  voice_seed_mode: manual_only\n', 'utf8');
    const system = new NodeSystemAdapter();
    await system.commitPaths(root, [...ledgerPaths, 'world/book_config.yaml'], 'test: seed confirmation ledgers');
    const baseline = await system.currentRevision(root);
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt);
    cleanups.push(() => promptFiber.dispose());
    const serviceFiber = await ctx.plugin(ToolsService);
    cleanups.push(() => serviceFiber.dispose());
    const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: root });
    cleanups.push(() => storeFiber.dispose());
    const toolsFiber = await ctx.plugin(bookToolsPlugin);
    cleanups.push(() => toolsFiber.dispose());

    const script = { checkerCalls: 0, writerCalls: 0, extractorCalls: 0, failExtraction: false };
    await createHeadlessMockServices(ctx, {
        onAgent: async ({ tools, execTool }) => {
            if (tools.has('yield_context_pack')) {
                // 真实工具产出完整工种结果，包括 selectedLoreSources: []，不伪造 RoleRunner 返回值。
                await execTool('yield_context_pack', {
                    selected_entity_ids: ['char_001'], recall_queries: [], selected_lore_files: []
                });
                return;
            }
            if (tools.has('yield_outline')) {
                await execTool('yield_outline', {
                    chapter_title: '核对封港日期',
                    target_word_count: 1200,
                    focus_cast: ['char_001'],
                    background_cast: [],
                    ending_beat: 'CLOSURE',
                    director_rationale: '本章核对日期并合上账册。',
                    chapter_turn: '沈默发现封港日期抄错了一日。',
                    scene_plan: [{ scene_index: 1, location: '旧账房', summary: '核对封港日期', is_spotlight: true }],
                    outline_text: '沈默核对封港日期，整理账册缺页。'
                });
                return;
            }
            if (tools.has('yield_verdict')) {
                script.checkerCalls += 1;
                if (rewriteFirst && script.checkerCalls === 1) {
                    await execTool('yield_verdict', {
                        passed: false,
                        issues: [{
                            severity: 'MULTI_REWRITE',
                            description: '封港尚未发生，请重写日期判断。',
                            quote_draft: '海港已经封港。',
                            quote_source: '海港处于封港戒备前夕',
                            source_ref: 'world/world_state.md'
                        }],
                        confirmed_completed_beats: ['节拍十'],
                        confirmed_resolved_threads: ['thread_10']
                    });
                    return;
                }
                await execTool('yield_verdict', {
                    passed: true,
                    issues: [],
                    confirmed_completed_beats: finalConfirmations.completed_beats,
                    confirmed_resolved_threads: finalConfirmations.resolved_threads
                });
                return;
            }
            if (tools.has('yield_state_patch')) {
                script.extractorCalls += 1;
                if (script.failExtraction) throw new Error('账本回归：Extractor 在正文提交后中断');
                await execTool('yield_state_patch', {
                    entity_patches: [],
                    story_day_delta: 0,
                    chapter_summary: '沈默核对封港日期并整理账册缺页。',
                    appeared_entity_ids: ['char_001'],
                    prose_anchors: ['账册'],
                    next_chapter_options: ['查验船票']
                });
            }
        },
        onLlmStream: () => {
            script.writerCalls += 1;
            const date = rewriteFirst && script.writerCalls === 1 ? '海港已经封港。' : '海港尚未封港。';
            return textToStreamChunks(`# 核对封港日期\n\n${date}\n\n沈默把账册摊在桌上，逐行核对日期。他抽出夹在末页的纸条，抄下更正后的数字。\n\n窗外传来船笛声。他将缺页归回原处，合上账册。\n`);
        }
    });
    const roleLoader = new RoleLoader();
    const poolRouting = {
        strong_creative: { provider: 'deepseek', model: 'v4' },
        fast_retrieval: { provider: 'deepseek', model: 'flash' }
    };
    const llm = new DshLlmAdapter(ctx.llm, { poolRouting });
    const roleRunner = new RoleRunner({
        ctx, storeService: ctx.narrateStore, toolsService: ctx.narrateTools,
        roleLoader, llmAdapter: llm, poolRouting
    });
    const createPipeline = () => {
        // 恢复用新 Store 与 Pipeline，确认来源只能是磁盘 WAL 而不是前次内存。
        const store = new BookStore(root, system);
        return { store, pipeline: new ChapterPipeline({ store, system, roleLoader, roleRunner, llm }) };
    };
    return { root, baseline, system, script, createPipeline };
}

afterEach(async () => {
    try {
        while (cleanups.length > 0) await cleanups.pop()!();
    } finally {
        await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
    }
});

describe('ChapterPipeline 终审确认与主线账本提交', () => {
    it('只持久化最后通过的终审确认，Extractor 中断后从 FEAT 恢复并且仅结账一次', async () => {
        const fixture = await setupChapter('ledger-recovery', true);
        const { root, baseline, script, system } = fixture;
        const first = fixture.createPipeline();
        script.failExtraction = true;
        await expect(first.pipeline.stepChapter({ chapterGoal: '核对封港日期', timelineMode: 'MAINLINE' }))
            .rejects.toThrow('账本回归：Extractor 在正文提交后中断');

        expect(script.checkerCalls).toBe(2);
        expect(script.extractorCalls).toBeGreaterThan(0);
        const failedTx = await first.store.readTxState();
        expect(failedTx.phase).toBe('FEAT_COMMITTED');
        expect(failedTx.chapter_context?.fact_confirmations).toEqual(finalConfirmations);
        const featSha = await system.currentRevision(root);
        expect(featSha).not.toBe(baseline);
        // 正文已提交，但账本既不能先写工作区，也不能抢先进入 feat 提交。
        expect(await readLedgers(root)).toEqual([initialPlan, initialThreads]);
        expect(await Promise.all(ledgerPaths.map(path => system.readFileAtRef(root, featSha, path))))
            .toEqual([initialPlan, initialThreads]);
        expect(await ledgerCommits(root, baseline)).toEqual([]);

        const callsBeforeRecovery = { checker: script.checkerCalls, writer: script.writerCalls };
        script.failExtraction = false;
        const recovered = fixture.createPipeline();
        const result = await recovered.pipeline.stepChapter({ chapterGoal: '恢复已通过终审的章节' });
        expect(result).toMatchObject({ status: 'COMMITTED', recoveredFromPhase: 'FEAT_COMMITTED', featCommitSha: featSha });
        expect(script.checkerCalls).toBe(callsBeforeRecovery.checker);
        expect(script.writerCalls).toBe(callsBeforeRecovery.writer);
        expect((await recovered.store.readTxState()).phase).toBe('STATE_COMMITTED');

        const expectedPlan = [
            '# 开篇节拍', '',
            '- [status: COMPLETED | ch:01] 节拍一：核对封港日期',
            '- [status: PENDING] 节拍三：查验西门',
            '- [status: PENDING] beat 3: 查验东门',
            '- [status: PENDING] 节拍十：查明船票去向', ''
        ].join('\n');
        const expectedThreads = [
            '# 活跃伏笔', '',
            '- [thread_1 | status: RESOLVED | ch:01] 封港日期有误',
            '- [thread_10 | status: ACTIVE] 船票去向不明',
            '- [thread_legacy | status: RESOLVED | ch:01] 账册缺页', ''
        ].join('\n');
        // 中文与数字编号可以对应；两个“3”有歧义，不能任选其一；thread_1 不得前缀命中 thread_10。
        expect(await readLedgers(root)).toEqual([expectedPlan, expectedThreads]);
        const stateSha = await system.currentRevision(root);
        expect(await ledgerCommits(root, baseline)).toEqual([stateSha]);
        expect(await Promise.all(ledgerPaths.map(path => system.readFileAtRef(root, stateSha, path))))
            .toEqual([expectedPlan, expectedThreads]);

        // 已完成的同一章不能再次消费确认，也不能追加结案章号或第二个账本提交。
        await expect(fixture.createPipeline().pipeline.stepChapter({ chapterNumber: 1, chapterGoal: '重复恢复' }))
            .rejects.toThrow(/章号/);
        expect(await system.currentRevision(root)).toBe(stateSha);
        expect(await readLedgers(root)).toEqual([expectedPlan, expectedThreads]);
        expect(await ledgerCommits(root, baseline)).toEqual([stateSha]);
    });

    it.each(['FLASHBACK', 'PARALLEL'] as const)('%s 终审通过不能改写主线的两个 world 账本', async timelineMode => {
        const fixture = await setupChapter(`ledger-${timelineMode.toLowerCase()}`);
        const { root, baseline, system } = fixture;
        const before = await readLedgers(root);
        const { pipeline, store } = fixture.createPipeline();
        if (timelineMode === 'PARALLEL') {
            await pipeline.forkParallelWindow({ windowId: 'ledger-window', maxChapters: 2 });
        }
        const result = await pipeline.stepChapter({
            chapterGoal: '核对封港日期',
            timelineMode,
            ...(timelineMode === 'FLASHBACK'
                ? { targetDay: 0 }
                : { parallelWindowId: 'ledger-window', parallelBranchId: 'branch-a' })
        });
        expect(result.status).toBe('COMMITTED');
        expect(fixture.script.checkerCalls).toBe(1);
        expect((await store.readTxState()).chapter_context).toMatchObject({
            timelineMode, fact_confirmations: finalConfirmations
        });
        expect(await readLedgers(root)).toEqual(before);
        expect(await Promise.all(ledgerPaths.map(path => system.readFileAtRef(root, 'HEAD', path))))
            .toEqual(before);
        expect(await ledgerCommits(root, baseline)).toEqual([]);
    });
});
