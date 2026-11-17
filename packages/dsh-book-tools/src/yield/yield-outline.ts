import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PlannerOutline } from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PlannerOutlineSchema } from './schemas.js';

export interface YieldOutlineOptions {
    onYield?: ((outline: PlannerOutline) => void) | undefined;
}

/** 创建 Planner 终态门禁工具 yield_outline（校验 director_rationale 与 outline_text 物理分离） */
export function createYieldOutlineTool(options: YieldOutlineOptions = {}): ToolDefinition {
    const { onYield } = options;

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

            const rationaleTrimmed = outline.director_rationale.trim();
            if (rationaleTrimmed.length >= 20 && outline.outline_text.includes(rationaleTrimmed)) {
                throw new GateValidationError(
                    'yield_outline',
                    '里表分流校验失败：outline_text 不得直接包含 director_rationale 全知内参原文'
                );
            }

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
