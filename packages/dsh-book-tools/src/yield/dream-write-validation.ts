import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
    assertEntryTagsSafe,
    InnateLockViolationError,
    parseEntityMarkdown,
    type EntityEntry,
    type EntityProfile
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import { isEnoentError, matchesAnyPathPrefix } from '../tools/shared.js';
import { ENTITY_ID_PATTERN_RE, hasOmniscientSecretMarker } from './shared.js';

export const ENTITY_PROFILE_PATH_RE = /^entities\/(?:cold_archive\/)?([^/]+)\.md$/;
const DREAM_READONLY_PROTECTED_PATHS = [
    'manuscripts', 'world/roles', 'world/author_charter.md', 'world/book_config.yaml',
    'world/ops_style_amendments.md', 'world/current_arc_envelope.md', 'world/static_base_and_voice.md'
] as const;

export function dreamRevertHint(path: string): string {
    return `请调用 book_edit(path="${path}", mode="revert") 撤销该非法暂存修改后重新提交`;
}

/** 只归一化表示差异；多行正文、权限、时序、槽位与附加标签仍完整参与锁比较。 */
function normalizeLock(entry: EntityEntry): EntityEntry {
    return {
        ...entry,
        text: entry.text.trim(),
        status: entry.status ?? 'ACTIVE',
        owner: entry.owner ?? '',
        extraTags: entry.extraTags ?? {},
        ledger: entry.ledger ?? {}
    };
}

export function areInnateLocksEquivalent(a: readonly EntityEntry[], b: readonly EntityEntry[]): boolean {
    return a.length === b.length && a.every((entry, index) =>
        isDeepStrictEqual(normalizeLock(entry), normalizeLock(b[index]!))
    );
}

async function readExistingEntity(bookRoot: string, path: string, fence: PathFence): Promise<string | null> {
    await fence.assertReadFile(path);
    try {
        if ((await lstat(join(bookRoot, path))).isSymbolicLink()) {
            throw new GateValidationError('yield_dream_commit', `实体档案不能是符号链接: ${path}`);
        }
        return await readFile(join(bookRoot, path), 'utf8');
    } catch (error) {
        if (isEnoentError(error)) return null;
        throw error;
    }
}

/** 编辑时的非阻塞预警与终态提交复用同一条路径、格式及先天属性检查。 */
export async function validateDreamWrite(
    bookRoot: string,
    path: string,
    content: string,
    fence: PathFence
): Promise<EntityProfile | null> {
    try {
        if (matchesAnyPathPrefix(path, DREAM_READONLY_PROTECTED_PATHS)) {
            throw new GateValidationError('yield_dream_commit', `禁止 Dreamer 修改只读保护路径: ${path}`);
        }
        await fence.assertWriteFile(path);
        const match = ENTITY_PROFILE_PATH_RE.exec(path);
        if (!match?.[1]) return null;
        const id = match[1];
        if (!ENTITY_ID_PATTERN_RE.test(id)) {
            if (path.startsWith('entities/cold_archive/')) return null;
            throw new GateValidationError('yield_dream_commit', `非法活跃实体文件名: ${path}`);
        }
        const profile = parseEntityMarkdown(content);
        if (profile.metadata.entity_id !== id) {
            throw new GateValidationError('yield_dream_commit', `实体档案 ${path} 的 entity_id (${profile.metadata.entity_id}) 与文件名不一致`);
        }
        for (const entries of [profile.innateLocks, profile.acquiredState, profile.irreversibleTrajectory, profile.recentBuffer]) {
            for (const entry of entries) assertEntryTagsSafe(entry);
        }
        let original = await readExistingEntity(bookRoot, path, fence);
        if (original === null && !path.startsWith('entities/cold_archive/')) {
            original = await readExistingEntity(bookRoot, `entities/cold_archive/${id}.md`, fence);
        }
        if (original !== null) {
            const before = parseEntityMarkdown(original);
            if (profile.metadata.canonical_name !== before.metadata.canonical_name) {
                throw new InnateLockViolationError(id, `禁止篡改实体 ${id} 的 canonical_name`);
            }
            if (!areInnateLocksEquivalent(before.innateLocks, profile.innateLocks)) {
                const index = before.innateLocks.findIndex((entry, i) =>
                    !profile.innateLocks[i] || !areInnateLocksEquivalent([entry], [profile.innateLocks[i]!])
                );
                throw new InnateLockViolationError(id, `禁止篡改实体 ${id} 的 1. Innate Locks（第 ${index < 0 ? before.innateLocks.length + 1 : index + 1} 条）`);
            }
        } else if (profile.innateLocks.some(hasOmniscientSecretMarker)) {
            throw new GateValidationError('yield_dream_commit', `新建实体 ${id} 第 1 区 Innate Locks 严禁包含 OMNISCIENT_SECRET`);
        }
        const headings = content.split(/\r?\n/).filter((line) => /^#{2,3}\s+/.test(line.trim()));
        for (const [number, title] of [[1, 'Innate Locks'], [2, 'Acquired State'], [3, 'Irreversible Trajectory'], [4, 'Recent Sliding Buffer']] as const) {
            if (!headings.some((line) => new RegExp(`^#{2,3}\\s+${number}\\.`).test(line.trim()) || line.includes(title))) {
                throw new GateValidationError('yield_dream_commit', `实体档案 ${path} 缺少第 ${number} 区 ${title}`);
            }
        }
        return profile;
    } catch (error) {
        const hint = dreamRevertHint(path);
        if (error instanceof InnateLockViolationError || error instanceof GateValidationError) {
            error.message = `${error.message}；${hint}`;
            throw error;
        }
        throw new GateValidationError('yield_dream_commit', `实体档案或暂存路径 ${path} 校验失败：${error instanceof Error ? error.message : String(error)}；${hint}`);
    }
}
