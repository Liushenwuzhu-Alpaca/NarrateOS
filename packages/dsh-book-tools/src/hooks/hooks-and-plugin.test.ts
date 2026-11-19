import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { afterEach, describe, expect, it } from 'vitest';
import * as bookToolsPlugin from '../index.js';
import { evaluateMainSessionWriteGuard } from '../hooks/main-session-guard.js';
import { attachYieldEnforcementHook } from './yield-enforcement.js';

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

function registerCleanup(fn: () => void | Promise<void>): void {
    cleanups.push(fn);
}

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-hooks-test-'));
    tempDirs.push(dir);
    return dir;
}

function makeToolExecution(name: string, args: unknown): ToolExecution {
    return {
        token: Symbol('exec') as ToolExecutionToken,
        callId: 'call-guard-1' as ToolCallId,
        rootCallId: 'call-guard-1' as ToolCallId,
        name,
        arguments: args,
        signal: new AbortController().signal
    };
}

afterEach(async () => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            await fn();
        }
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('防逃逸 Hook、主会话写保护守卫与 Cordis 插件集成', () => {
    it('Cordis Config 使用原生 @deepseek-ai/schemastery 并完整挂载 ctx.narrateTools 与 lock_charter_and_boot', async () => {
        const workspaceDir = await makeTempDir();
        const booksRoot = join(workspaceDir, 'books');
        await mkdir(booksRoot, { recursive: true });

        // 验证 Config 为 Schemastery 原生 Schema（满足 dsh-app-boot isNativeConfigSchema 协议）
        expect(typeof bookToolsPlugin.Config).toBe('function');
        expect(Reflect.get(bookToolsPlugin.Config, Symbol.for('schemastery'))).toBe(true);
        expect(Reflect.get(bookToolsPlugin.Config, 'type')).toBe('object');
        const normalizedCfg = bookToolsPlugin.Config({ booksRoot });
        expect(normalizedCfg.booksRoot).toBe(booksRoot);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsSvcFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsSvcFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin);
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        expect(ctx.narrateTools).toBeDefined();
        expect(ctx.tools.get('lock_charter_and_boot')).toBeDefined();

        await bookToolsFiber.dispose();
        await storeFiber.dispose();
        await toolsSvcFiber.dispose();
        await promptFiber.dispose();
        expect(ctx.get('narrateTools')).toBeUndefined();
    });

    it('主会话 tools/pre-execute 与 ToolsService.guard 拦截对 books/<slug>/ 的裸写/编辑/bash 篡改，放行受控工具与外部路径', async () => {
        const workspaceDir = await makeTempDir();
        const booksRoot = join(workspaceDir, 'books');
        const bookDir = join(booksRoot, 'demo-book');
        await mkdir(join(bookDir, 'world'), { recursive: true });
        await writeFile(join(bookDir, 'world/world_state.md'), 'test', 'utf8');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsSvcFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsSvcFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin);
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        // 1. 拦截裸 write / edit / apply_patch / str_replace_editor 写入 books/<slug>/
        const rawWriteAbs = makeToolExecution('write', {
            path: join(bookDir, 'manuscripts/ch_0001.md'),
            content: '越权正文'
        });
        const rawWriteReason = ctx.tools.checkGuards(rawWriteAbs);
        expect(rawWriteReason).toContain('主会话写保护拦截');
        expect(rawWriteReason).toContain('lock_charter_and_boot');
        expect(rawWriteReason).toContain('Studio');
        expect(rawWriteReason).not.toContain('book_edit');
        expect(rawWriteReason).not.toContain('yield_*');

        const rawEditRel = makeToolExecution('str_replace_editor', {
            path: join(booksRoot, 'demo-book/world/world_state.md'),
            old_str: 'test',
            new_str: 'hacked'
        });
        expect(ctx.tools.checkGuards(rawEditRel)).toContain('主会话写保护拦截');

        const rawPatch = makeToolExecution('apply_patch', {
            patch: `*** Begin Patch\n*** Update File: ${join(bookDir, 'world/world_state.md')}\n*** End Patch`
        });
        expect(ctx.tools.checkGuards(rawPatch)).toContain('主会话写保护拦截');

        // 2. 拦截 bash 篡改 books/ 的命令
        const rawBashRedirect = makeToolExecution('bash', {
            command: `echo "cheat" > ${join(bookDir, 'manuscripts/ch_0001.md')}`
        });
        expect(ctx.tools.checkGuards(rawBashRedirect)).toContain('主会话写保护拦截');

        const rawBashRm = makeToolExecution('bash', {
            command: 'rm -rf books/demo-book'
        });
        expect(ctx.tools.checkGuards(rawBashRm)).toContain('主会话写保护拦截');

        // 2.1 拦截 ./books/、../books/、紧贴重定向 >./books/、tee/cp/mv/sed/python/node 等绕过路径
        const bypassCommands = [
            'echo "cheat" > ./books/demo-book/manuscripts/ch_0001.md',
            'echo "cheat">>./books/demo-book/world/world_state.md',
            'cat <<EOF | tee ./books/demo-book/world/world_state.md',
            'cp /tmp/fake.md ../books/demo-book/manuscripts/ch_0001.md',
            'mv /tmp/fake.md ./books/demo-book/world/world_state.md',
            'sed -i "s/test/hack/" ./books/demo-book/world/world_state.md',
            'python -c "open(\'./books/demo-book/world/world_state.md\', \'w\').write(\'x\')"',
            'node -e "require(\'fs\').writeFileSync(\'./books/demo-book/world/world_state.md\', \'x\')"'
        ];
        for (const cmd of bypassCommands) {
            expect(
                evaluateMainSessionWriteGuard(makeToolExecution('bash', { command: cmd }), booksRoot)
            ).toContain('主会话写保护拦截');
        }

        // 2.2 booksRoot 目录名含正则元字符时不得抛出 SyntaxError，且精准拦截目录内修改并放行无关目录
        const specialBooksRoot = join(workspaceDir, 'my.books+(v1)[0]');
        expect(() =>
            evaluateMainSessionWriteGuard(
                makeToolExecution('bash', {
                    command: 'echo x > ./my.books+(v1)[0]/demo/ch_0001.md'
                }),
                specialBooksRoot
            )
        ).not.toThrow();
        expect(
            evaluateMainSessionWriteGuard(
                makeToolExecution('bash', {
                    command: 'echo x > ./my.books+(v1)[0]/demo/ch_0001.md'
                }),
                specialBooksRoot
            )
        ).toContain('主会话写保护拦截');
        expect(
            evaluateMainSessionWriteGuard(
                makeToolExecution('bash', {
                    command: 'echo x > ./notebooks/draft.md'
                }),
                specialBooksRoot
            )
        ).toBeUndefined();

        // 3. 验证 tools/pre-execute 瀑布流也返回 deny
        const preDecision = await ctx.waterfall(
            scopeTarget(ctx.tools, undefined),
            'tools/pre-execute',
            rawWriteAbs,
            async () => ({ kind: 'allow' as const })
        );
        expect(preDecision.kind).toBe('deny');

        // 4. 放行 NarrateOS 受控工具与 booksRoot 之外的常规路径
        expect(
            evaluateMainSessionWriteGuard(
                makeToolExecution('lock_charter_and_boot', { book_slug: 'demo-book' }),
                booksRoot
            )
        ).toBeUndefined();
        expect(
            evaluateMainSessionWriteGuard(
                makeToolExecution('book_edit', { path: 'world/open_threads.md' }),
                booksRoot
            )
        ).toBeUndefined();
        expect(
            evaluateMainSessionWriteGuard(
                makeToolExecution('yield_dream_commit', { summary: 'ok' }),
                booksRoot
            )
        ).toBeUndefined();
        expect(
            ctx.tools.checkGuards(
                makeToolExecution('write', { path: join(workspaceDir, 'notes/scratch.md'), content: 'ok' })
            )
        ).toBeUndefined();
    });

    it("'agent/turn-stopping' Hook 拦截未调 yield_* 的纯文本提前停止并注入 steer，达到 maxSteps 后安全中止并清理 StagingSession", async () => {
        const workspaceDir = await makeTempDir();
        const bookRoot = resolve(join(workspaceDir, 'books', 'hook-book'));
        await mkdir(join(bookRoot, 'world'), { recursive: true });
        await writeFile(join(bookRoot, 'world/open_threads.md'), '- [thread_001] 初始\n', 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-escape-test',
            bookRoot,
            yieldTool: 'yield_outline'
        });
        registerCleanup(() => roleSet.cleanup());
        await roleSet.toolMap.get('book_edit')!.execute(
            {
                path: 'world/open_threads.md',
                target_text: '- [thread_001] 初始',
                replacement_text: '- [thread_001] 暂存改写'
            },
            {
                token: Symbol('e') as ToolExecutionToken,
                callId: 'c1' as ToolCallId,
                rootCallId: 'c1' as ToolCallId,
                name: 'book_edit',
                arguments: {},
                signal: new AbortController().signal,
                deferContext() {},
                concludeTurn() {}
            }
        );
        expect(ctx.narrateStore.staging.has('run-escape-test')).toBe(true);

        const steeredMessages: UserMessage[] = [];
        let exhaustedCalled = 0;

        const mockAgent = {
            steer(msg: UserMessage) {
                steeredMessages.push(msg);
            }
        } as unknown as Agent;

        const disposeHook = ctx.narrateTools.attachYieldEnforcementHook(ctx, {
            expectedYieldTool: 'yield_outline',
            maxSteps: 3,
            hasYielded: () => roleSet.hasYielded(),
            cleanupStaging: () => roleSet.cleanup(),
            onExhausted: () => {
                exhaustedCalled += 1;
            }
        });
        registerCleanup(disposeHook);

        const ac = new AbortController();

        // Step 1 纯文本结束未调 yield_outline -> steer 第 1 次
        await ctx.serial('agent/turn-stopping', { agent: mockAgent, turn: 1, signal: ac.signal });
        expect(steeredMessages).toHaveLength(1);
        expect(steeredMessages[0]?.source.kind).toBe('narrateos-book-tools');
        expect(exhaustedCalled).toBe(0);
        expect(ctx.narrateStore.staging.has('run-escape-test')).toBe(true);

        // Step 2 仍未调 yield_outline -> steer 第 2 次（达到 maxSteps - 1 = 2 次上限）
        await ctx.serial('agent/turn-stopping', { agent: mockAgent, turn: 1, signal: ac.signal });
        expect(steeredMessages).toHaveLength(2);
        expect(exhaustedCalled).toBe(0);

        // Step 3 仍未调 yield_outline -> 达到 maxSteps 兜底上限，不再 steer，触发 onExhausted 并清理 StagingSession
        await ctx.serial('agent/turn-stopping', { agent: mockAgent, turn: 1, signal: ac.signal });
        expect(steeredMessages).toHaveLength(2);
        expect(exhaustedCalled).toBe(1);
        expect(ctx.narrateStore.staging.has('run-escape-test')).toBe(false);
    });

    it("'agent/turn-stopping' 在已成功调用 yield_* 后直接放行，不触发 steer", async () => {
        const workspaceDir = await makeTempDir();
        const bookRoot = resolve(join(workspaceDir, 'books', 'hook-pass-book'));
        await mkdir(join(bookRoot, 'world'), { recursive: true });

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-yielded-ok',
            bookRoot,
            yieldTool: 'yield_outline'
        });
        registerCleanup(() => roleSet.cleanup());

        await roleSet.toolMap.get('yield_outline')!.execute(
            {
                chapter_title: '第一章',
                target_word_count: 2000,
                focus_cast: ['char_001'],
                director_rationale: '幕后原因推演',
                chapter_turn: '突生变故',
                scene_plan: [{ scene_index: 1, location: '站台', summary: '遇袭', is_spotlight: true }],
                outline_text: '雨夜站台起风，黑影贴近柱后。'
            },
            {
                token: Symbol('e') as ToolExecutionToken,
                callId: 'c1' as ToolCallId,
                rootCallId: 'c1' as ToolCallId,
                name: 'yield_outline',
                arguments: {},
                signal: new AbortController().signal,
                deferContext() {},
                concludeTurn() {}
            }
        );

        const steeredMessages: UserMessage[] = [];
        const mockAgent = {
            steer(msg: UserMessage) {
                steeredMessages.push(msg);
            }
        } as unknown as Agent;

        const disposeHook = ctx.narrateTools.attachYieldEnforcementHook(ctx, {
            expectedYieldTool: 'yield_outline',
            maxSteps: 3,
            hasYielded: () => roleSet.hasYielded(),
            cleanupStaging: () => roleSet.cleanup()
        });
        registerCleanup(disposeHook);

        await ctx.serial('agent/turn-stopping', {
            agent: mockAgent,
            turn: 1,
            signal: new AbortController().signal
        });
        expect(steeredMessages).toHaveLength(0);
    });

    it('主会话写保护守卫拦截带引号/转义/时间戳的 apply_patch 路径，并支持动态保护 switchBook 切换后的外部 bookRoot', async () => {
        const workspaceDir = await makeTempDir();
        const booksRoot = join(workspaceDir, 'books');
        const externalBookRoot = resolve(join(workspaceDir, 'external-novels', 'side-story'));
        await mkdir(join(booksRoot, 'demo-book/world'), { recursive: true });
        await mkdir(join(externalBookRoot, '.ops'), { recursive: true });
        await mkdir(join(externalBookRoot, 'world'), { recursive: true });
        await writeFile(join(externalBookRoot, 'world/world_state.md'), 'init', 'utf8');

        // 1. 带双引号、Git a/b 前缀、八进制 UTF-8 转义及 \t<timestamp> 尾缀的 unified diff 均须拦截
        const quotedTimestampPatches = [
            `--- /dev/null\n+++ "b/books/demo-book/world/world_state.md"\t2026-11-18 12:00:00 +0800\n@@ -0,0 +1 @@\n+hack`,
            `--- "a/books/demo-book/manuscripts/ch_0001.md"\t2026-11-18 12:00:00 +0800\n+++ /dev/null`,
            `--- /dev/null\n+++ "b/books/demo-book/manuscripts/\\347\\254\\254\\344\\270\\200\\347\\253\\240.md"\t2026-11-18 12:00:00 +0800`,
            `+++ b/books/demo-book/world/world_state.md\t2026-11-18 12:00:00 +0800`
        ];
        for (const patch of quotedTimestampPatches) {
            expect(
                evaluateMainSessionWriteGuard(makeToolExecution('apply_patch', { patch }), booksRoot)
            ).toContain('主会话写保护拦截');
        }

        // booksRoot 之外的带引号/时间戳 patch 路径正常放行
        expect(
            evaluateMainSessionWriteGuard(
                makeToolExecution('apply_patch', {
                    patch: '--- /dev/null\n+++ "b/notes/scratch.md"\t2026-11-18 12:00:00 +0800'
                }),
                booksRoot
            )
        ).toBeUndefined();

        // 2. 挂载插件后通过 switchBook 切换到 booksRoot 之外的外部 bookRoot，守卫动态将其纳入写保护
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsSvcFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsSvcFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin);
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        await ctx.narrateStore.switchBook(externalBookRoot);

        const extWriteExec = makeToolExecution('write', {
            path: join(externalBookRoot, 'world/world_state.md'),
            content: 'tampered'
        });
        expect(ctx.tools.checkGuards(extWriteExec)).toContain('主会话写保护拦截');

        const extPreDecision = await ctx.waterfall(
            scopeTarget(ctx.tools, undefined),
            'tools/pre-execute',
            makeToolExecution('apply_patch', {
                patch: `+++ "b/${externalBookRoot.replace(/^\/+/, '/')}/world/world_state.md"\t2026-11-18 12:00:00 +0800`
            }),
            async () => ({ kind: 'allow' as const })
        );
        expect(extPreDecision.kind).toBe('deny');

        expect(
            ctx.tools.checkGuards(
                makeToolExecution('bash', {
                    command: `./fix.sh ${join(externalBookRoot, 'world/world_state.md')}`
                })
            )
        ).toContain('主会话写保护拦截');
        expect(
            ctx.tools.checkGuards(
                makeToolExecution('bash', {
                    command: `cat ${join(externalBookRoot, 'world/world_state.md')}`
                })
            )
        ).toBeUndefined();
    });

    it('主会话 Shell 守卫对受保护作品目录采用严格纯只读白名单：拦截未知脚本与高危工具，放行纯只读查看命令', async () => {
        const workspaceDir = await makeTempDir();
        const booksRoot = join(workspaceDir, 'books');
        await mkdir(join(booksRoot, 'demo-book/world'), { recursive: true });

        const blockedCommands = [
            './fix.sh books/demo-book/world/world_state.md',
            'bun run fix.ts books/demo-book',
            'deno eval "console.log(1)" books/demo-book',
            'tsx fix.ts books/demo-book',
            'jq ".a = 1" books/demo-book/meta.json',
            'rsync -a /tmp/x books/demo-book/',
            'tar -xf evil.tar -C books/demo-book',
            'find books/demo-book -delete',
            'find books/demo-book -exec rm {} +',
            'git -C books/demo-book checkout -- .',
            'cat books/demo-book/world/world_state.md > /tmp/leak.md',
            'ls books/demo-book && ./fix.sh',
            'rg --pre=./evil.sh foo books/demo-book',
            'GIT_EXTERNAL_DIFF=./evil.sh git -C books/demo-book diff'
        ];
        for (const cmd of blockedCommands) {
            expect(
                evaluateMainSessionWriteGuard(makeToolExecution('bash', { command: cmd }), booksRoot),
                `期望拦截命令: ${cmd}`
            ).toContain('主会话写保护拦截');
        }

        const allowedReadOnlyCommands = [
            'ls -la books/demo-book/world',
            'cat books/demo-book/world/world_state.md',
            'head -n 10 books/demo-book/world/world_state.md',
            'tail -n 5 books/demo-book/world/world_state.md',
            'wc -l books/demo-book/world/world_state.md',
            'stat books/demo-book/world/world_state.md',
            'rg -n "test" books/demo-book/world',
            'grep -rn "test" books/demo-book/world',
            'git -C books/demo-book status',
            'git -C books/demo-book log -n 5',
            'git -C books/demo-book diff HEAD~1',
            'cat books/demo-book/world/world_state.md | wc -l'
        ];
        for (const cmd of allowedReadOnlyCommands) {
            expect(
                evaluateMainSessionWriteGuard(makeToolExecution('bash', { command: cmd }), booksRoot),
                `期望放行只读命令: ${cmd}`
            ).toBeUndefined();
        }
    });

    it('连续工具步不能绕过 maxSteps；超额步在进入模型之前拒绝', async () => {
        const ctx = new Context();
        let exhausted = 0;
        let cleaned = 0;
        const dispose = attachYieldEnforcementHook(ctx, {
            expectedYieldTool: 'yield_outline', maxSteps: 2, hasYielded: () => false,
            onExhausted: () => { exhausted++; }, cleanupStaging: () => { cleaned++; }
        });
        try {
            for (const step of [1, 2, 3, 4]) {
                const decision = await ctx.waterfall('agent/pre-step', {
                    agent: {} as Agent, messages: [], turn: 1, step,
                    signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'mock' }
                }, async () => ({ kind: 'enter' as const, messages: [] }));
                expect(decision.kind).toBe(step <= 2 ? 'enter' : 'reject');
            }
            expect(exhausted).toBe(1);
        } finally {
            dispose();
        }
        expect(cleaned).toBe(1);
    });

    it('attachYieldEnforcementHook 将工具调用回合与 turn-stopping 纠偏合并计入 maxSteps 上限，并在 hasYielded 后于 agent/disposed 幂等清理 StagingSession', async () => {
        const workspaceDir = await makeTempDir();
        const bookRoot = resolve(join(workspaceDir, 'books', 'hook-steps-book'));
        await mkdir(join(bookRoot, 'world'), { recursive: true });
        await writeFile(join(bookRoot, 'world/open_threads.md'), '- [thread_001] 初始\n', 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const ac = new AbortController();
        const dummySelection = { provider: 'mock', model: 'mock-model' };

        // 场景 A：通过 tools/pre-execute 消耗 2 步后在 turn-stopping 纯文本停机（maxSteps = 3 -> 不再 steer，直接触发 onExhausted 并清理）
        {
            const roleSet = ctx.narrateTools.buildRoleTools({
                runId: 'run-tool-budget-a',
                bookRoot,
                yieldTool: 'yield_outline'
            });
            registerCleanup(() => roleSet.cleanup());
            expect(ctx.narrateStore.staging.has('run-tool-budget-a')).toBe(true);

            const steeredMessages: UserMessage[] = [];
            let exhaustedCalled = 0;
            const mockAgent = {
                steer(msg: UserMessage) {
                    steeredMessages.push(msg);
                }
            } as unknown as Agent;

            const disposeHook = ctx.narrateTools.attachYieldEnforcementHook(ctx, {
                expectedYieldTool: 'yield_outline',
                maxSteps: 3,
                hasYielded: () => roleSet.hasYielded(),
                cleanupStaging: () => roleSet.cleanup(),
                onExhausted: () => {
                    exhaustedCalled += 1;
                }
            });

            await ctx.waterfall(
                'tools/pre-execute',
                makeToolExecution('book_read', { path: 'world/open_threads.md' }),
                async () => ({ kind: 'allow' as const })
            );
            await ctx.waterfall(
                'tools/pre-execute',
                makeToolExecution('book_grep', { pattern: 'thread_001' }),
                async () => ({ kind: 'allow' as const })
            );
            await ctx.serial('agent/turn-stopping', { agent: mockAgent, turn: 1, signal: ac.signal });

            expect(steeredMessages).toHaveLength(0);
            expect(exhaustedCalled).toBe(1);
            expect(ctx.narrateStore.staging.has('run-tool-budget-a')).toBe(false);
            disposeHook();
        }

        // 场景 B：agent/pre-step 与并行 tools/pre-execute 联动，同一步内多次并行工具调用不重复扣步，第 3 步 turn-stopping 达上限停止
        {
            const roleSet = ctx.narrateTools.buildRoleTools({
                runId: 'run-tool-budget-b',
                bookRoot,
                yieldTool: 'yield_outline'
            });
            registerCleanup(() => roleSet.cleanup());
            expect(ctx.narrateStore.staging.has('run-tool-budget-b')).toBe(true);

            const steeredMessages: UserMessage[] = [];
            let exhaustedCalled = 0;
            const mockAgent = {
                steer(msg: UserMessage) {
                    steeredMessages.push(msg);
                }
            } as unknown as Agent;

            const disposeHook = ctx.narrateTools.attachYieldEnforcementHook(ctx, {
                expectedYieldTool: 'yield_outline',
                maxSteps: 3,
                hasYielded: () => roleSet.hasYielded(),
                cleanupStaging: () => roleSet.cleanup(),
                onExhausted: () => {
                    exhaustedCalled += 1;
                }
            });

            // Step 1: agent/pre-step + 两次并行工具调用 -> 合计仅占 1 步
            await ctx.waterfall(
                'agent/pre-step',
                {
                    agent: mockAgent,
                    messages: [],
                    turn: 1,
                    step: 1,
                    signal: ac.signal,
                    modelSelection: dummySelection
                },
                async () => ({ kind: 'enter' as const, messages: [] })
            );
            await ctx.waterfall(
                'tools/pre-execute',
                makeToolExecution('book_read', { path: 'world/open_threads.md' }),
                async () => ({ kind: 'allow' as const })
            );
            await ctx.waterfall(
                'tools/pre-execute',
                makeToolExecution('book_glob', { pattern: 'world/*.md' }),
                async () => ({ kind: 'allow' as const })
            );

            // Step 2: 纯文本提前停止 -> 允许 steer 第 1 次
            await ctx.waterfall(
                'agent/pre-step',
                {
                    agent: mockAgent,
                    messages: [],
                    turn: 1,
                    step: 2,
                    signal: ac.signal,
                    modelSelection: dummySelection
                },
                async () => ({ kind: 'enter' as const, messages: [] })
            );
            await ctx.serial('agent/turn-stopping', { agent: mockAgent, turn: 1, signal: ac.signal });
            expect(steeredMessages).toHaveLength(1);
            expect(exhaustedCalled).toBe(0);

            // Step 3: 再次纯文本停止 -> 达到 maxSteps = 3 上限，不再 steer，触发 onExhausted 并清理
            await ctx.waterfall(
                'agent/pre-step',
                {
                    agent: mockAgent,
                    messages: [],
                    turn: 1,
                    step: 3,
                    signal: ac.signal,
                    modelSelection: dummySelection
                },
                async () => ({ kind: 'enter' as const, messages: [] })
            );
            await ctx.serial('agent/turn-stopping', { agent: mockAgent, turn: 1, signal: ac.signal });
            expect(steeredMessages).toHaveLength(1);
            expect(exhaustedCalled).toBe(1);
            expect(ctx.narrateStore.staging.has('run-tool-budget-b')).toBe(false);
            disposeHook();
        }

        // 场景 C：非提交型工种调用 yield_outline 成功（hasYielded() === true）后未手动 cleanup，agent/disposed 仍无条件幂等清理 StagingSession
        {
            const roleSet = ctx.narrateTools.buildRoleTools({
                runId: 'run-disposed-after-yield',
                bookRoot,
                yieldTool: 'yield_outline'
            });
            registerCleanup(() => roleSet.cleanup());

            await roleSet.toolMap.get('book_edit')!.execute(
                {
                    path: 'world/open_threads.md',
                    target_text: '- [thread_001] 初始',
                    replacement_text: '- [thread_001] 已暂存但未提交'
                },
                {
                    token: Symbol('e') as ToolExecutionToken,
                    callId: 'c1' as ToolCallId,
                    rootCallId: 'c1' as ToolCallId,
                    name: 'book_edit',
                    arguments: {},
                    signal: ac.signal,
                    deferContext() {},
                    concludeTurn() {}
                }
            );
            await roleSet.toolMap.get('yield_outline')!.execute(
                {
                    chapter_title: '第一章',
                    target_word_count: 2000,
                    focus_cast: ['char_001'],
                    director_rationale: '幕后原因推演',
                    chapter_turn: '突生变故',
                    scene_plan: [{ scene_index: 1, location: '站台', summary: '遇袭', is_spotlight: true }],
                    outline_text: '雨夜站台起风，黑影贴近柱后。'
                },
                {
                    token: Symbol('e') as ToolExecutionToken,
                    callId: 'c2' as ToolCallId,
                    rootCallId: 'c2' as ToolCallId,
                    name: 'yield_outline',
                    arguments: {},
                    signal: ac.signal,
                    deferContext() {},
                    concludeTurn() {}
                }
            );
            expect(roleSet.hasYielded()).toBe(true);
            expect(ctx.narrateStore.staging.has('run-disposed-after-yield')).toBe(true);

            let cleanupCalls = 0;
            const disposeHook = ctx.narrateTools.attachYieldEnforcementHook(ctx, {
                expectedYieldTool: 'yield_outline',
                maxSteps: 3,
                hasYielded: () => roleSet.hasYielded(),
                cleanupStaging: () => {
                    cleanupCalls += 1;
                    roleSet.cleanup();
                }
            });

            ctx.emit('agent/disposed', { agent: {} as Agent });
            expect(cleanupCalls).toBe(1);
            expect(ctx.narrateStore.staging.has('run-disposed-after-yield')).toBe(false);

            // 再次调用 disposeHook 幂等，不重复触发 cleanupStaging
            disposeHook();
            expect(cleanupCalls).toBe(1);
        }
    });
});
