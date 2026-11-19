import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrationSubjectivity } from '@narrateos/dsh-book-store';
import { validateBootBundle } from '../boot/boot-validation.js';
import { GateValidationError } from '../errors.js';
import { BootBundleOutputSchema, type BootBundleOutput } from './schemas.js';
import { COMPILED_ENTITY_TOOL_SCHEMA } from '../boot/compiled-entity-input.js';

export interface YieldBootBundleOptions {
    narrationSubjectivity?: NarrationSubjectivity | undefined;
    onYield?: ((bundle: BootBundleOutput) => void) | undefined;
}

/** 创建 Boot Compiler 终态门禁工具 yield_boot_bundle（校验开书三把手术刀编译产物） */
export function createYieldBootBundleTool(options: YieldBootBundleOptions = {}): ToolDefinition {
    const { narrationSubjectivity = 'objective_third', onYield } = options;

    return defineTool({
        name: 'yield_boot_bundle',
        description:
            'Boot Compiler 终态交接门禁。校验开书编译产物（>=1 卷、>=1 实体、允许 0 条 OMNISCIENT_SECRET 与 0 条声纹样本、无 T0 未来泄露、通过静态文风门禁）。',
        parameters: {
            world_summary: { type: 'string', description: '成功编译必填：世界观与开局核心局势总结' },
            static_base_and_voice: { type: 'string', description: '成功编译必填：世界底层法则与抽象句法纪律' },
            current_arc_envelope: { type: 'string', description: '成功编译必填：正向当前卷舞台常态与主冲突' },
            stage_ceiling: { type: 'string', description: '成功编译必填：本卷阶段天花板禁区' },
            opening_sequence_beats: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        beat_label: { type: 'string' },
                        craft_focus: { type: 'string', required: true },
                        clue_budget: { type: 'string', required: true },
                        completion_sign: { type: 'string', required: true }
                    }
                },
                description: '3~5 个不绑定章号的开篇序列节拍'
            },
            unrevealed_pivots: {
                type: 'array',
                items: { type: 'string' },
                description: '未揭秘三幕拐点'
            },
            l0_sagas_markdown: { type: 'string', description: 'L0 纪元折叠总表' },
            l1_volumes_markdown: { type: 'string', description: '成功编译必填：L1 活跃卷级总表（>=1 卷）' },
            voice_samples: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        tag: { type: 'string', required: true },
                        sample: { type: 'string', required: true },
                        source: {
                            type: 'string',
                            enum: ['author_sample', 'boot_seed', 'chapter_harvest']
                        }
                    }
                },
                description:
                    '声纹标本（支持 source: "author_sample" | "boot_seed" | "chapter_harvest"，须通过 StaticProseGate；无作者样章时可传 [] 或 3~4 条 15~45 字无角色专名硬动作/对话 boot_seed）'
            },
            open_threads: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        thread_id: { type: 'string', required: true },
                        title: { type: 'string', required: true },
                        wakeup_condition: { type: 'string', required: true }
                    }
                },
                description: '首批跨卷伏笔'
            },
            future_horizon_events: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        event_id: { type: 'string', required: true },
                        story_day: { type: 'integer', required: true },
                        premise: { type: 'string', required: true },
                        description: { type: 'string', required: true }
                    }
                },
                description: 'T0 之后预定世界惯性事件'
            },
            lore_entries: {
                type: 'array',
                items: { type: 'json' },
                description: '世界书词条列表'
            },
            entities: {
                type: 'array',
                items: COMPILED_ENTITY_TOOL_SCHEMA,
                description: '初始实体档案列表（>=1 个，允许 0 条 OMNISCIENT_SECRET）'
            },
            contract_conflicts: {
                type: 'array',
                items: { type: 'string' },
                description: '若作者契约本身存在物理/因果矛盾，在此列出退回主对话裁决'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    entityCount: { type: 'integer', required: true },
                    loreCount: { type: 'integer', required: true },
                    conflictCount: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                if (value.conflictCount > 0) {
                    return [
                        {
                            type: 'text',
                            text: `yield_boot_bundle 检测到 ${value.conflictCount} 项契约矛盾，需退回主对话裁决。`
                        }
                    ];
                }
                return [
                    {
                        type: 'text',
                        text: `yield_boot_bundle 门禁通过：实体 ${value.entityCount} 个，世界书 ${value.loreCount} 条。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const parsed = BootBundleOutputSchema.parse(args);

            if (!('entities' in parsed)) {
                onYield?.(parsed);
                exec.concludeTurn();
                return {
                    accepted: true,
                    entityCount: 0,
                    loreCount: 0,
                    conflictCount: parsed.contract_conflicts.length
                };
            }

            const outcome = validateBootBundle(parsed, {
                narrationSubjectivity,
                voiceSampleMode: 'filter'
            });
            if (outcome.issues.length > 0) {
                throw new GateValidationError('yield_boot_bundle', outcome.issues.join('; '));
            }

            onYield?.({ ...parsed, voice_samples: outcome.cleanVoiceSamples });
            exec.concludeTurn();

            return {
                accepted: true,
                entityCount: parsed.entities.length,
                loreCount: parsed.lore_entries.length,
                conflictCount: 0
            };
        }
    });
}
