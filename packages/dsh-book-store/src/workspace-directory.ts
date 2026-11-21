import type { Context } from '@deepseek-ai/cordis';

/** 可选 DSH Host 端口；无头部署不依赖工作目录插件。 */
export interface WorkspaceSession {
    readonly header?: { readonly cwd?: string | undefined } | undefined;
}

export interface WorkspaceAgent {
    readonly session?: WorkspaceSession | undefined;
}

interface WorkingDirectoryPort {
    readonly defaultDirectory?: string | undefined;
    get(session: WorkspaceSession): string;
    ensure?(agent: WorkspaceAgent, signal?: AbortSignal): Promise<string>;
}

export function getWorkingDirectory(ctx: Context): WorkingDirectoryPort | undefined {
    // DSH 动态提供 workingDirectory；NarrateOS 的无头组合可不挂载该服务。
    return (ctx.get as (name: string) => unknown).call(ctx, 'workingDirectory') as WorkingDirectoryPort | undefined;
}

/** 读取已提交的有效目录，不触发会话恢复或目录修改。 */
export function readSessionWorkspaceDirectory(ctx: Context, session: WorkspaceSession): string | undefined {
    return getWorkingDirectory(ctx)?.get(session) ?? session.header?.cwd;
}

export async function resolveAgentWorkspaceDirectory(
    ctx: Context,
    agent: WorkspaceAgent | undefined,
    signal?: AbortSignal
): Promise<string | undefined> {
    const session = agent?.session;
    if (!session) return undefined;
    const port = getWorkingDirectory(ctx);
    if (port?.ensure) return await port.ensure(agent, signal);
    return port?.get(session) ?? session.header?.cwd;
}
