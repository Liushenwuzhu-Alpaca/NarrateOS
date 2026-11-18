import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    BookOpeningConfigSchema,
    normalizeForQuoteMatch,
    parseEntityMarkdown,
    type EntityProfile,
    type NarrateStoreService,
    type PlannerOutline
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { isEnoentError, readOptionalBookConfig } from '../tools/shared.js';
import { PlannerOutlineSchema } from './schemas.js';
import { ENTITY_FILENAME_RE, toVisibleEntityMap } from './shared.js';

const DEFAULT_FIRST_CHAPTER_MAX_BEATS = BookOpeningConfigSchema.parse({}).first_chapter_max_beats;
const OUTLINE_RESTRICTED_RE =
    /\b(?:OMNISCIENT_SECRET|WARPED|SELF_ONLY)\b|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale/i;
const OUTLINE_NEGATIVE_PROHIBITION_RE =
    /(?:禁止|严禁|禁用|不要|不得|切忌|绝不|决不|不能|不可|切勿|莫要)/;

export interface YieldOutlineOptions {
    store?: NarrateStoreService | undefined;
    bookRoot?: string | undefined;
    targetChapter?: number | undefined;
    visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined;
    onYield?: ((outline: PlannerOutline) => void) | undefined;
}

const MIN_SECRET_CLAUSE_NORM_LEN = 10;

function extractSubstantiveNormalizedClauses(text: string): string[] {
    const clauses: string[] = [];
    for (const rawClause of text.split(/[。！？；，,;\n]/)) {
        const trimmed = rawClause.trim();
        if (!trimmed) continue;
        const candidates = [trimmed];
        const colonIdx = trimmed.search(/[:：]/);
        if (colonIdx > 0 && colonIdx < trimmed.length - 1) {
            candidates.push(trimmed.slice(colonIdx + 1).trim());
        }
        for (const candidate of candidates) {
            const norm = normalizeForQuoteMatch(candidate);
            if (norm.length >= MIN_SECRET_CLAUSE_NORM_LEN) {
                clauses.push(norm);
            }
        }
    }
    return clauses;
}

async function loadKnownEntityProfiles(
    bookRoot: string | undefined,
    visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile>
): Promise<Map<string, EntityProfile>> {
    const profiles = new Map<string, EntityProfile>();
    if (bookRoot) {
        for (const subDir of ['entities', 'entities/cold_archive']) {
            try {
                const entries = await readdir(join(bookRoot, subDir));
                for (const entry of entries) {
                    const match = ENTITY_FILENAME_RE.exec(entry);
                    if (!match?.[1] || profiles.has(match[1])) continue;
                    try {
                        const raw = await readFile(join(bookRoot, subDir, entry), 'utf8');
                        profiles.set(match[1], parseEntityMarkdown(raw));
                    } catch {
                        // 忽略损坏文件
                    }
                }
            } catch (err: unknown) {
                if (!isEnoentError(err)) {
                    throw err;
                }
            }
        }
    }
    for (const [id, profile] of toVisibleEntityMap(visibleEntities).entries()) {
        profiles.set(id, profile);
    }
    return profiles;
}

function assertOutlineCleanroomIsolation(
    outline: PlannerOutline,
    knownProfiles: ReadonlyMap<string, EntityProfile>
): void {
    const rationaleTrimmed = outline.director_rationale.trim();
    if (rationaleTrimmed.length >= 20 && outline.outline_text.includes(rationaleTrimmed)) {
        throw new GateValidationError(
            'yield_outline',
            '里表分流校验失败：outline_text 不得直接包含 director_rationale 全知内参原文'
        );
    }

    const spoilerHit = OUTLINE_RESTRICTED_RE.exec(outline.outline_text);
    if (spoilerHit) {
        throw new GateValidationError(
            'yield_outline',
            `outline_text 禁止包含全知或导演禁区标签「${spoilerHit[0]}」`
        );
    }
    const negativeHit = OUTLINE_NEGATIVE_PROHIBITION_RE.exec(outline.outline_text);
    if (negativeHit) {
        throw new GateValidationError(
            'yield_outline',
            `outline_text 禁止包含写手受限否定禁令「${negativeHit[0]}」，请改写为正向动作/镜头指令`
        );
    }

    const normalizedOutline = normalizeForQuoteMatch(outline.outline_text);
    if (normalizedOutline.length === 0) {
        return;
    }

    for (const clauseNorm of extractSubstantiveNormalizedClauses(rationaleTrimmed)) {
        if (normalizedOutline.includes(clauseNorm)) {
            throw new GateValidationError(
                'yield_outline',
                '里表分流校验失败：outline_text 命中 director_rationale 全知内参实质子句，请改写为净室镜头表现'
            );
        }
    }

    for (const profile of knownProfiles.values()) {
        const secretEntries = [
            ...profile.innateLocks,
            ...profile.acquiredState,
            ...profile.irreversibleTrajectory,
            ...profile.recentBuffer
        ].filter((entry) => entry.visibility === 'OMNISCIENT_SECRET');
        for (const entry of secretEntries) {
            const fullEntryText = [entry.text, ...entry.continuationLines].join('\n');
            for (const secretClause of extractSubstantiveNormalizedClauses(fullEntryText)) {
                if (normalizedOutline.includes(secretClause)) {
                    throw new GateValidationError(
                        'yield_outline',
                        `里表分流校验失败：outline_text 疑似泄露实体 ${profile.metadata.entity_id} 的 OMNISCIENT_SECRET 未揭底牌`
                    );
                }
            }
        }
    }
}

async function resolveOutlineMaxBeats(
    store: NarrateStoreService | undefined,
    bookRoot: string | undefined,
    targetChapter: number | undefined
): Promise<number> {
    if (targetChapter !== 1) {
        return 2;
    }
    if (!store || !bookRoot) {
        return DEFAULT_FIRST_CHAPTER_MAX_BEATS;
    }
    const cfg = await readOptionalBookConfig(store, bookRoot);
    return cfg?.opening?.first_chapter_max_beats ?? DEFAULT_FIRST_CHAPTER_MAX_BEATS;
}

async function assertPreferredVoiceTagValid(
    store: NarrateStoreService | undefined,
    bookRoot: string | undefined,
    preferredVoiceTag: string | undefined
): Promise<void> {
    if (preferredVoiceTag === undefined || !store || !bookRoot) {
        return;
    }
    try {
        const pool = await store.openStore(bookRoot).readVoiceSamples();
        if (
            pool.samples.length > 0 &&
            !pool.samples.some((sample) => sample.tag === preferredVoiceTag)
        ) {
            throw new GateValidationError(
                'yield_outline',
                `preferred_voice_tag (${preferredVoiceTag}) 不在当前声纹池已有标签集内`
            );
        }
    } catch (err: unknown) {
        if (err instanceof GateValidationError) {
            throw err;
        }
    }
}

/** 创建 Planner 终态门禁工具 yield_outline（校验里表分流、合法 entity_id、节拍与戏眼上限） */
export function createYieldOutlineTool(options: YieldOutlineOptions = {}): ToolDefinition {
    const { store, bookRoot, targetChapter, visibleEntities, onYield } = options;

    return defineTool({
        name: 'yield_outline',
        description:
            'Planner 终态交接门禁。校验结构化细纲与里表物理分流（director_rationale 全知推演与面向写手的 outline_text 严格隔离），全部通过后结束回合。',
        parameters: {
            chapter_title: { type: 'string', required: true, description: '章节标题' },
            target_word_count: { type: 'integer', required: true, description: '目标字数' },
            focus_cast: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '本场核心对手戏角色 ID 列表'
            },
            background_cast: {
                type: 'array',
                items: { type: 'string' },
                description: '环境陪衬角色 ID 列表'
            },
            ending_beat: {
                type: 'string',
                enum: ['HOOK', 'AFTERGLOW', 'CLOSURE'],
                description: '收尾画面节拍类型'
            },
            director_rationale: {
                type: 'string',
                required: true,
                description: '全知导演内参推演（写手物理不可见）'
            },
            chapter_turn: { type: 'string', required: true, description: '本章实质波折与预期偏差' },
            scene_plan: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        scene_index: { type: 'integer', required: true },
                        location: { type: 'string', required: true },
                        summary: { type: 'string', required: true },
                        is_spotlight: { type: 'boolean' }
                    }
                },
                description: '1~2 个连续场景编排'
            },
            outline_text: {
                type: 'string',
                required: true,
                description: '面向写手的净室表演与镜头指令（含潜台词方向，严禁泄底或包含否定禁令）'
            },
            preferred_voice_tag: {
                type: 'string',
                description: '可选声纹标签'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    chapter_title: { type: 'string', required: true },
                    sceneCount: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `yield_outline 门禁通过：《${value.chapter_title}》（${value.sceneCount} 个场景）。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const outline = PlannerOutlineSchema.parse(args);

            const knownProfiles = await loadKnownEntityProfiles(bookRoot, visibleEntities);
            assertOutlineCleanroomIsolation(outline, knownProfiles);

            if (knownProfiles.size > 0) {
                for (const id of [...outline.focus_cast, ...outline.background_cast]) {
                    if (!knownProfiles.has(id)) {
                        throw new GateValidationError(
                            'yield_outline',
                            `focus_cast / background_cast 必须填写真实存在的 entity_id，收到未知实体标识: ${id}`
                        );
                    }
                }
            }

            const maxBeats = await resolveOutlineMaxBeats(store, bookRoot, targetChapter);
            if (outline.scene_plan.length < 1 || outline.scene_plan.length > maxBeats) {
                throw new GateValidationError(
                    'yield_outline',
                    `scene_plan 拍数 (${outline.scene_plan.length}) 必须在 1..${maxBeats} 之间`
                );
            }

            const spotlightCount = outline.scene_plan.filter((s) => s.is_spotlight).length;
            if (spotlightCount > 1) {
                throw new GateValidationError(
                    'yield_outline',
                    `单章最多允许 1 个 is_spotlight=true 戏眼场景，收到 ${spotlightCount} 个`
                );
            }

            await assertPreferredVoiceTagValid(store, bookRoot, outline.preferred_voice_tag);

            onYield?.(outline);
            exec.concludeTurn();

            return {
                accepted: true,
                chapter_title: outline.chapter_title,
                sceneCount: outline.scene_plan.length
            };
        }
    });
}
