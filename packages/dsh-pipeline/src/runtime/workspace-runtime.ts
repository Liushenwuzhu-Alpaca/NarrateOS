import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation } from '@deepseek-ai/dsh-commands';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
    getWorkingDirectory, readSessionWorkspaceDirectory, resolveAgentWorkspaceDirectory, type WorkspaceSession
} from '@narrateos/dsh-book-store';
import { AdmissionClosedError, NotFoundError, PathValidationError, TaskConflictError } from '../errors.js';
import type { HostDefaultModelSelection } from '../schemas.js';
import { NarrateRuntimeController, type NarrateControllerConfig } from './controller.js';

interface SessionObservation extends Disposable {
    header: { cwd?: string | undefined };
    projections?: { values: { workingDirectory?: string | undefined } } | undefined;
}

interface SessionQueryPort {
    observeSession(sessionId: string): Promise<SessionObservation>;
}

function readModelSelection(raw: unknown): HostDefaultModelSelection | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const data = raw as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
    const provider = typeof data.provider === 'string' ? data.provider.trim() : '';
    const model = typeof data.model === 'string' ? data.model.trim() : '';
    if (!provider || !model) return undefined;
    const reasoningEffort = typeof data.reasoningEffort === 'string' ? data.reasoningEffort.trim() : '';
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** 每个实际作品库只保留一组控制器、暂存和选书状态；请求本身不改变任何共享目录。 */
export function createWorkspaceRuntime(ctx: Context, config: NarrateControllerConfig) {
    const defaultTools = ctx.narrateTools.forWorkspace(undefined);
    const defaultController = new NarrateRuntimeController(ctx, defaultTools.narrateStore, defaultTools, config);
    const byRoot = new Map([[defaultController.booksRoot, defaultController]]);
    const pendingModelSelections = new Map<string, HostDefaultModelSelection>();
    let executionContext = ctx;
    let closed = false;

    async function select(directory?: string, expectedRoot?: string): Promise<NarrateRuntimeController> {
        if (closed) throw new AdmissionClosedError();
        if (!directory) return defaultController;
        const booksRoot = ctx.narrateTools.booksRootFor(directory);
        if (expectedRoot !== undefined && expectedRoot !== booksRoot) {
            throw new TaskConflictError('会话工作区已变化，请刷新 Studio 后重试');
        }
        let controller = byRoot.get(booksRoot);
        if (!controller) {
            const tools = ctx.narrateTools.forWorkspace(directory);
            controller = new NarrateRuntimeController(ctx, tools.narrateStore, tools, {
                ...config, booksRoot, bookRoot: undefined
            });
            controller.roleRunner.setExecutionContext(executionContext);
            byRoot.set(booksRoot, controller);
            const modelSelection = pendingModelSelections.get(booksRoot);
            if (modelSelection) {
                pendingModelSelections.delete(booksRoot);
                controller.handleHostSessionModelSelection(modelSelection);
            }
        }
        await controller.trackBackgroundTask(controller.ensureDefaultBookSelected());
        if (closed) throw new AdmissionClosedError();
        return controller;
    }

    return {
        defaultController,
        controllers: () => byRoot.values(),
        onSessionModelSelection(session: WorkspaceSession, data: unknown): void {
            if (closed) return;
            const selection = readModelSelection(data);
            if (!selection) return;
            const directory = readSessionWorkspaceDirectory(ctx, session);
            const booksRoot = directory ? ctx.narrateTools.booksRootFor(directory) : defaultController.booksRoot;
            const controller = byRoot.get(booksRoot);
            if (controller) controller.handleHostSessionModelSelection(selection);
            else pendingModelSelections.set(booksRoot, selection);
        },
        setExecutionContext(scope: Context): void {
            executionContext = scope;
            for (const controller of byRoot.values()) controller.roleRunner.setExecutionContext(scope);
        },
        async forCommand(invocation: CommandInvocation): Promise<NarrateRuntimeController> {
            return await select(await resolveAgentWorkspaceDirectory(ctx, invocation.agent, invocation.signal));
        },
        async forRequest(req: IncomingMessage): Promise<NarrateRuntimeController> {
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const scopeSessionId = query.get('scopeSessionId');
            const scopeBooksRoot = query.get('scopeBooksRoot') ?? undefined;
            if (scopeSessionId === null) return defaultController;
            if (closed) throw new AdmissionClosedError();
            if (!scopeSessionId || query.getAll('scopeSessionId').length > 1 ||
                query.getAll('scopeBooksRoot').length > 1) {
                throw new PathValidationError('无效的 Studio 工作区标识');
            }
            const live = ctx.agents.get?.(SessionId(scopeSessionId));
            let directory = live ? readSessionWorkspaceDirectory(ctx, live.session) : undefined;
            if (!directory) {
                const sessions = (ctx.get as (key: string) => unknown).call(ctx, 'sessionQuery') as SessionQueryPort | undefined;
                if (!sessions) throw new NotFoundError('无法定位 Studio 会话工作区');
                try {
                    using observation = await sessions.observeSession(scopeSessionId);
                    directory = observation.projections?.values.workingDirectory ?? observation.header.cwd ??
                        getWorkingDirectory(ctx)?.defaultDirectory;
                } catch (error) {
                    if (error && typeof error === 'object' && 'code' in error &&
                        error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
                        throw new NotFoundError('Studio 会话不存在');
                    }
                    throw error;
                }
            }
            if (!directory) throw new NotFoundError('Studio 会话没有工作目录');
            return await select(directory, scopeBooksRoot);
        },
        async shutdown(): Promise<void> {
            closed = true;
            pendingModelSelections.clear();
            await Promise.all([...byRoot.values()].map((controller) => controller.shutdown()));
        }
    };
}
