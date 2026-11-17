/** 路径围栏越权访问异常 */
export class PathFenceError extends Error {
    constructor(
        public readonly requestedPath: string,
        message: string
    ) {
        super(message);
        this.name = 'PathFenceError';
    }
}

/** 只读调用配额耗尽异常 */
export class ReadQuotaExceededError extends Error {
    constructor(
        public readonly toolName: string,
        public readonly maxReadCalls: number,
        public readonly yieldToolHint: string
    ) {
        super(
            `已达到只读调用配额上限 (${maxReadCalls} 次)，禁止继续调用 ${toolName}。请立即停止读取并调用 ${yieldToolHint} 提交结果。`
        );
        this.name = 'ReadQuotaExceededError';
    }
}

/** 终态门禁确定性校验失败异常 */
export class GateValidationError extends Error {
    constructor(
        public readonly gateTool: string,
        message: string
    ) {
        super(message);
        this.name = 'GateValidationError';
    }
}

/** 开书编译与锁定门禁失败异常 */
export class BootGateError extends Error {
    constructor(
        public readonly issues: string[],
        message?: string
    ) {
        super(message ?? `开书编译门禁校验失败: ${issues.join('; ')}`);
        this.name = 'BootGateError';
    }
}
