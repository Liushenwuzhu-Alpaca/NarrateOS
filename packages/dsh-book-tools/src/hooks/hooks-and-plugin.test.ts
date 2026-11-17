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
        expect(ctx.tools.checkGuards(rawWriteAbs)).toContain('主会话写保护拦截');

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
});
