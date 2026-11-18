import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
    'book_edit',
    'patch_paragraphs'
]);

/** 支持的终态门禁工具名 */
export const YieldToolNameSchema = z.enum([
    'yield_context_pack',
    'yield_outline',
    'yield_verdict',
    'yield_state_patch',
    'yield_dream_commit',
    'yield_boot_bundle',
    'yield_patched_draft'
]);

/** 外部化角色配置 YAML Schema (roles/*.yml) */
export const RoleConfigSchema = z.object({
    id: z.string().regex(ROLE_ID_RE, '角色 ID 仅允许字母、数字、下划线与连字符'),
    pool: RolePoolSchema,
    cleanroom: z.boolean(),
    promptFile: z.string().min(1),
    temperature: z.number().min(0).max(2),
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
    maxSteps: z.number().int().positive(),
    maxReadCalls: z.number().int().nonnegative(),
    tools: z.array(ControlledBookToolNameSchema).default([]),
    allowedOpsRead: z.array(z.string().min(1)).default([]),
    allowedOpsWrite: z.array(z.string().min(1)).default([]),
    blockedReadPaths: z.array(z.string().min(1)).default([]),
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
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | undefined;
    maxSteps: number;
    maxReadCalls: number;
    tools: ControlledBookToolName[];
    allowedOpsRead: string[];
    allowedOpsWrite: string[];
    blockedReadPaths: string[];
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

async function resolveRealPathWithAncestor(targetPath: string, label: string): Promise<string> {
    const resolved = resolve(targetPath);
    const suffix: string[] = [];
    let probe = resolved;

    while (true) {
        try {
            await lstat(probe);
            const real = await realpath(probe);
            return suffix.length > 0 ? join(real, ...suffix) : real;
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
            // 检测悬空符号链接，拒绝放行
            try {
                const st = await lstat(probe);
                if (st.isSymbolicLink()) {
                    throw new Error(`${label} 存在无效或悬空符号链接: ${targetPath}`);
                }
            } catch (lstatErr: unknown) {
                if ((lstatErr as { code?: string }).code !== 'ENOENT') {
                    throw lstatErr;
                }
            }
            const parent = dirname(probe);
            if (parent === probe) {
                throw new Error(`${label} 无法解析真实路径: ${targetPath}`);
            }
            suffix.unshift(basename(probe));
            probe = parent;
        }
    }
}

async function assertInsideDirectory(
    baseDir: string,
    targetPath: string,
    label: string
): Promise<void> {
    const base = resolve(baseDir);
    const target = resolve(targetPath);
    const lexicalRel = relative(base, target);
    if (lexicalRel === '' || lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) {
        throw new Error(`${label} 禁止越界访问目录: ${targetPath}`);
    }

    const realBase = await resolveRealPathWithAncestor(base, label);
    const realTarget = await resolveRealPathWithAncestor(target, label);
    const realRel = relative(realBase, realTarget);
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new Error(`${label} 禁止符号链接越界访问目录: ${targetPath}`);
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
            await assertInsideDirectory(bookRoot, bookRolesDir, '单书角色目录');
            const candidateBookRole = resolve(bookRolesDir, `${roleId}.yml`);
            await assertInsideDirectory(bookRolesDir, candidateBookRole, '角色配置路径');
            await assertInsideDirectory(bookRoot, candidateBookRole, '角色配置路径');
            if (await fileExists(candidateBookRole)) {
                roleFilePath = candidateBookRole;
                isBookOverride = true;
            }
        }

        if (!isBookOverride) {
            await assertInsideDirectory(presetRolesDir, roleFilePath, '预设角色配置路径');
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
            bookRoot && bookRoot.trim().length > 0 ? resolve(bookRoot) : null,
            bookRolesDir,
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
            allowedOpsRead: [...cfg.allowedOpsRead],
            allowedOpsWrite: [...cfg.allowedOpsWrite],
            blockedReadPaths: [...cfg.blockedReadPaths],
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
        resolvedBookRoot: string | null,
        bookRolesDir: string | null,
        presetRolesDir: string
    ): Promise<string> {
        if (isAbsolute(promptFile)) {
            throw new Error(`promptFile 必须为相对路径，禁止使用绝对路径: ${promptFile}`);
        }

        const candidates: Array<{ baseDir: string; path: string }> = [];

        // 1. 若存在单书 world/roles 目录且不同于预设目录，优先检查单书 Prompt 覆写（支持仅覆写 prompts/*.md）
        if (bookRolesDir && bookRolesDir !== presetRolesDir) {
            const fromBookRoles = resolve(bookRolesDir, promptFile);
            await assertInsideDirectory(bookRolesDir, fromBookRoles, 'promptFile');
            if (resolvedBookRoot) {
                await assertInsideDirectory(resolvedBookRoot, fromBookRoles, 'promptFile');
            }
            candidates.push({ baseDir: bookRolesDir, path: fromBookRoles });
        }

        // 2. 其次相对于命中的 role YAML 所在目录解析
        if (!bookRolesDir || roleYamlDir !== bookRolesDir) {
            const fromYamlDir = resolve(roleYamlDir, promptFile);
            await assertInsideDirectory(roleYamlDir, fromYamlDir, 'promptFile');
            candidates.push({ baseDir: roleYamlDir, path: fromYamlDir });
        }

        // 3. 回退至 <presetRoot>/roles/<promptFile>
        if (presetRolesDir !== roleYamlDir && presetRolesDir !== bookRolesDir) {
            const fromPresetRoles = resolve(presetRolesDir, promptFile);
            await assertInsideDirectory(presetRolesDir, fromPresetRoles, 'promptFile');
            candidates.push({ baseDir: presetRolesDir, path: fromPresetRoles });
        }

        for (const candidate of candidates) {
            if (await fileExists(candidate.path)) {
                return candidate.path;
            }
        }

        throw new Error(`未找到角色提示词文件: ${promptFile} (已检查 ${candidates.map((c) => c.path).join(', ')})`);
    }
}
