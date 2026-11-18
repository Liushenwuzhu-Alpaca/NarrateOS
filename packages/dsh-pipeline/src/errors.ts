import type { GateViolation } from '@narrateos/dsh-book-store';
import type { FactCheckIssue } from '@narrateos/dsh-book-tools';

/** 新任务准入闸门已关闭异常（插件正在停机或已卸载） */
export class AdmissionClosedError extends Error {
    public readonly statusCode = 503 as const;

    constructor(message = 'NarrateOS 管线服务正在停机或已卸载，拒绝接收新任务') {
        super(message);
        this.name = 'AdmissionClosedError';
    }
}

/** 并发任务冲突异常（HTTP 409） */
export class TaskConflictError extends Error {
    public readonly statusCode = 409 as const;

    constructor(message: string) {
        super(message);
        this.name = 'TaskConflictError';
    }
}

/** 路径安全或请求参数校验异常（HTTP 400） */
export class PathValidationError extends Error {
    public readonly statusCode = 400 as const;

    constructor(message: string) {
        super(message);
        this.name = 'PathValidationError';
    }
}

/** 目标资源不存在异常（HTTP 404） */
export class NotFoundError extends Error {
    public readonly statusCode = 404 as const;

    constructor(message: string) {
        super(message);
        this.name = 'NotFoundError';
    }
}

/** 业务规则或静态门禁校验未通过异常（HTTP 422） */
export class ValidationError extends Error {
    public readonly statusCode = 422 as const;

    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

/** 细纲级物理悖论异常（触发退回 Planner 改纲 v2） */
export class PlanConflictError extends Error {
    readonly chapterNumber: number;
    readonly reason: string;

    constructor(chapterNumber: number, reason: string) {
        super(`第 ${chapterNumber} 章细纲存在物理/因果悖论，需重规划: ${reason}`);
        this.name = 'PlanConflictError';
        this.chapterNumber = chapterNumber;
        this.reason = reason;
    }
}

/** 安全挂起诊断快照 (.ops/safe_halt.json) */
export interface SafeHaltSnapshot {
    status: 'SAFE_HALT';
    chapterNumber: number;
    reason: string;
    replanCount: number;
    rewriteCount: number;
    patchRounds: number;
    issues: FactCheckIssue[];
    gateViolations: GateViolation[];
    timestamp: string;
}

/** 审校重试耗尽或 v2 仍失败后的安全挂起异常 */
export class SafeHaltError extends Error {
    readonly snapshot: SafeHaltSnapshot;

    constructor(snapshot: SafeHaltSnapshot) {
        super(`第 ${snapshot.chapterNumber} 章触发 SAFE_HALT 安全挂起: ${snapshot.reason}`);
        this.name = 'SafeHaltError';
        this.snapshot = snapshot;
    }
}
