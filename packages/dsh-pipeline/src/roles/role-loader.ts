import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlledBookToolName, YieldToolName } from '@narrateos/dsh-book-tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const ROLE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** 支持的模型池标识 */
export const RolePoolSchema = z.enum(['strong_creative', 'fast_retrieval', 'audit']);
export type RolePool = z.infer<typeof RolePoolSchema>;

/** 支持的受控读写工具名 */
export const ControlledBookToolNameSchema = z.enum([
    'book_read',
    'book_grep',
    'book_glob',
    'book_edit'
]);

/** 支持的终态门禁工具名 */
export const YieldToolNameSchema = z.enum([
    'yield_context_pack',
    'yield_outline',
    'yield_verdict',
    'yield_state_patch',
    'yield_dream_commit',
    'yield_boot_bundle'
]);

/** 外部化角色配置 YAML Schema (roles/*.yml) */
export const RoleConfigSchema = z.object({
    id: z.string().regex(ROLE_ID_RE, '角色 ID 仅允许字母、数字、下划线与连字符'),
    pool: RolePoolSchema,
    cleanroom: z.boolean(),
    promptFile: z.string().min(1),
    temperature: z.number().min(0).max(2),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    maxSteps: z.number().int().positive(),
    maxReadCalls: z.number().int().nonnegative(),
    tools: z.array(ControlledBookToolNameSchema).default([]),
    yieldTool: YieldToolNameSchema.nullable().default(null)
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

/** 加载并解析后的完整角色配置（含外部提示词文本与来源路径） */
export interface LoadedRoleConfig {
    id: string;
    pool: RolePool;
    cleanroom: boolean;
    promptFile: string;
    temperature: number;
    reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
    maxSteps: number;
    maxReadCalls: number;
    tools: ControlledBookToolName[];
    yieldTool: YieldToolName | null;
    promptText: string;
    roleFilePath: string;
    promptFilePath: string;
    isBookOverride: boolean;
}

async function fileExists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function assertInsideDirectory(baseDir: string, targetPath: string, label: string): void {
    const base = resolve(baseDir);
    const target = resolve(targetPath);
    const rel = relative(base, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`${label} 禁止越界访问目录: ${targetPath}`);
    }
}

/**
 * 解析 @narrateos/dsh-preset-narrateos 预设包根目录：
 * - 显式传入 presetRoot 时直接使用其绝对路径；
 * - 否则优先通过 import.meta.resolve('@narrateos/dsh-preset-narrateos/package.json') 定位。
 */
export function resolvePresetRoot(explicitPresetRoot?: string): string {
    if (explicitPresetRoot && explicitPresetRoot.trim().length > 0) {
        return resolve(explicitPresetRoot.trim());
    }
    try {
        const resolvedUrl = import.meta.resolve('@narrateos/dsh-preset-narrateos/package.json');
        return dirname(fileURLToPath(resolvedUrl));
    } catch {
        // 兜底：当作为源码直接运行且尚未构建链接时回退至仓库相对位置
        const currentDir = dirname(fileURLToPath(import.meta.url));
        return resolve(currentDir, '../../../../presets/dsh-preset-narrateos');
    }
}

/**
 * 外部化角色配置加载器：
 * - 优先加载 <bookRoot>/world/roles/<roleId>.yml 单书覆盖；
 * - 未覆盖时回退至 <presetRoot>/roles/<roleId>.yml；
 * - promptFile 先按角色 YAML 所在目录（及单书 world/roles/）相对解析，再回退至 <presetRoot>/roles/<promptFile>。
 */
export class RoleLoader {
    public readonly presetRoot: string;

    constructor(explicitPresetRoot?: string) {
        this.presetRoot = resolvePresetRoot(explicitPresetRoot);
    }

    /** 加载并校验指定角色配置与外部化系统提示词 */
    async loadRoleConfig(roleId: string, bookRoot?: string): Promise<LoadedRoleConfig> {
        if (!ROLE_ID_RE.test(roleId)) {
            throw new Error(`非法的角色标识: ${roleId}`);
        }

        const presetRolesDir = resolve(this.presetRoot, 'roles');
        const presetRolePath = resolve(presetRolesDir, `${roleId}.yml`);

        let roleFilePath = presetRolePath;
        let isBookOverride = false;
        let bookRolesDir: string | null = null;

        if (bookRoot && bookRoot.trim().length > 0) {
            bookRolesDir = resolve(bookRoot, 'world/roles');
            const candidateBookRole = resolve(bookRolesDir, `${roleId}.yml`);
            assertInsideDirectory(bookRolesDir, candidateBookRole, '角色配置路径');
            if (await fileExists(candidateBookRole)) {
                roleFilePath = candidateBookRole;
                isBookOverride = true;
            }
        }

        if (!isBookOverride) {
            assertInsideDirectory(presetRolesDir, roleFilePath, '预设角色配置路径');
            if (!(await fileExists(roleFilePath))) {
                throw new Error(`未找到角色配置文件: ${roleFilePath}`);
            }
        }

        const rawYaml = await readFile(roleFilePath, 'utf8');
        const parsedYaml = parseYaml(rawYaml) as unknown;
        const cfg = RoleConfigSchema.parse(parsedYaml);

        if (cfg.id !== roleId) {
            throw new Error(`角色配置文件 ${roleFilePath} 中的 id (${cfg.id}) 与请求角色 (${roleId}) 不一致`);
        }

        const promptFilePath = await this.resolvePromptFilePath(
            cfg.promptFile,
            dirname(roleFilePath),
            isBookOverride ? bookRolesDir : bookRolesDir,
            presetRolesDir
        );
        const promptText = (await readFile(promptFilePath, 'utf8')).trim();
        if (promptText.length === 0) {
            throw new Error(`角色 ${roleId} 的提示词文件为空: ${promptFilePath}`);
        }

        return {
            id: cfg.id,
            pool: cfg.pool,
            cleanroom: cfg.cleanroom,
            promptFile: cfg.promptFile,
            temperature: cfg.temperature,
            ...(cfg.reasoningEffort !== undefined ? { reasoningEffort: cfg.reasoningEffort } : {}),
            maxSteps: cfg.maxSteps,
            maxReadCalls: cfg.maxReadCalls,
            tools: [...cfg.tools],
            yieldTool: cfg.yieldTool,
            promptText,
            roleFilePath,
            promptFilePath,
            isBookOverride
        };
    }

    private async resolvePromptFilePath(
        promptFile: string,
        roleYamlDir: string,
        bookRolesDir: string | null,
        presetRolesDir: string
    ): Promise<string> {
        if (isAbsolute(promptFile)) {
            throw new Error(`promptFile 必须为相对路径，禁止使用绝对路径: ${promptFile}`);
        }

        const candidates: Array<{ baseDir: string; path: string }> = [];

        // 1. 先相对于命中的 role YAML 所在目录解析
        const fromYamlDir = resolve(roleYamlDir, promptFile);
        assertInsideDirectory(roleYamlDir, fromYamlDir, 'promptFile');
        candidates.push({ baseDir: roleYamlDir, path: fromYamlDir });

        // 2. 若提供了 bookRoot 但 YAML 来自 presetRoot，也允许仅覆盖 world/roles/prompts/<name>.md
        if (bookRolesDir && roleYamlDir !== bookRolesDir) {
            const fromBookRoles = resolve(bookRolesDir, promptFile);
            assertInsideDirectory(bookRolesDir, fromBookRoles, 'promptFile');
            candidates.push({ baseDir: bookRolesDir, path: fromBookRoles });
        }

        // 3. 回退至 <presetRoot>/roles/<promptFile>
        const fromPresetRoles = resolve(presetRolesDir, promptFile);
        assertInsideDirectory(presetRolesDir, fromPresetRoles, 'promptFile');
        candidates.push({ baseDir: presetRolesDir, path: fromPresetRoles });

        for (const candidate of candidates) {
            if (await fileExists(candidate.path)) {
                return candidate.path;
            }
        }

        throw new Error(`未找到角色提示词文件: ${promptFile} (已检查 ${candidates.map((c) => c.path).join(', ')})`);
    }
}
