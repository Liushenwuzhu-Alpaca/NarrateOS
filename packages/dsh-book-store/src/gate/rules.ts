import type { GateRuleConfig, GateRuleId } from './types.js';

/** 默认 AI 八股与陈腐比喻词表 */
export const DEFAULT_CLICHE_TERMS: readonly string[] = [
    '极其',
    '不由得',
    '下意识地',
    '某种难以言喻',
    '不置可否',
    '取而代之的是',
    '这意味着',
    '话音刚落',
    '声音不大却',
    '尾音微颤',
    '像被按下了暂停键',
    '像溺水者抓住救命稻草',
    '像触电般缩回手',
    '像精密运转的机器',
    '像精密运转的程序'
];

/** 默认静态文风门禁规则配置（均可通过 options.rules 覆盖） */
export const DEFAULT_GATE_RULES: Record<GateRuleId, Required<Pick<GateRuleConfig, 'enabled' | 'maxCount' | 'scaleByLength' | 'referenceChars'>> & {
    patterns: RegExp[];
    lastParagraphsOnly?: number;
    description: string;
}> = {
    tag_residue: {
        enabled: true,
        maxCount: 0,
        scaleByLength: false,
        referenceChars: 3000,
        patterns: [/<\/?blocking\b[^>]*>/gi, /\[SYSTEM\]/g, /<!--[\s\S]*?-->/g],
        description: '正文内不得残留思维标签或系统注释'
    },
    negation_contrast: {
        enabled: true,
        maxCount: 1,
        scaleByLength: true,
        referenceChars: 3000,
        patterns: [/(不是|并非|不像)[^。！？\n]{1,18}(而是|却是|更像)/g],
        description: '限制先否决对比句式'
    },
    subjective_judgment: {
        enabled: true,
        maxCount: 0,
        scaleByLength: false,
        referenceChars: 3000,
        patterns: [
            /(?:带着(?:几分|一丝|一抹|某种)?(?:笑意|审视|嘲弄|怜悯|轻蔑|深意)|(?:气氛|空气)顿时(?:缓和|凝固|紧张|沉重)下来|(?:天真|残忍|可笑|荒唐)得近乎[\u4e00-\u9fa5]{2,4}|(?:似乎|仿佛|大概)是?(?:想|意识|察觉)到什么|在我看来|老实说|说白了|简直就像|简直是)/g
        ],
        description: '客观镜头模式下抑制叙述者主观评判与抽象情绪定性'
    },
    micro_anatomy: {
        enabled: true,
        maxCount: 0,
        scaleByLength: false,
        referenceChars: 3000,
        patterns: [
            /(指节泛白|喉结(?:上下)?滚动|瞳孔(?:微缩|地震)|睫毛轻颤|指甲陷进掌心|眼眶泛起水汽|青筋暴起|表皮|角质|毛细血管|心率|肾上腺素)/g
        ],
        description: '封杀人体微距套话'
    },
    skeletal_quota: {
        enabled: true,
        maxCount: 1,
        scaleByLength: true,
        referenceChars: 3000,
        patterns: [/(肩胛骨|锁骨|脊椎|指骨|腕骨|肋骨)/g],
        description: '限制高频骨骼解剖词配额'
    },
    filler_trace: {
        enabled: true,
        maxCount: 0,
        scaleByLength: false,
        referenceChars: 3000,
        patterns: [/一(?:丝|抹)/g],
        description: '零容忍“一丝/一抹”空洞量词'
    },
    deictic_na: {
        enabled: true,
        maxCount: 2,
        scaleByLength: true,
        referenceChars: 3000,
        patterns: [/那(?:张|双|个|抹|丝)/g],
        description: '限制“那+量词”指示代词配额'
    },
    reduplication_verb: {
        enabled: true,
        maxCount: 2,
        scaleByLength: true,
        referenceChars: 3000,
        patterns: [/([\u4e00-\u9fa5])了\1/g],
        description: '限制“X了X”同字叠词配额'
    },
    deictic_density: {
        enabled: true,
        maxCount: 2,
        scaleByLength: true,
        referenceChars: 3000,
        patterns: [/一(?:股|阵)/g],
        description: '限制“一股/一阵”泛化量词密度'
    },
    filler_cliche: {
        enabled: true,
        maxCount: 1,
        scaleByLength: true,
        referenceChars: 3000,
        patterns: [],
        description: '限制 AI 八股填充词与陈腐比喻'
    },
    ending_moralizing: {
        enabled: true,
        maxCount: 0,
        scaleByLength: false,
        referenceChars: 3000,
        lastParagraphsOnly: 2,
        patterns: [/(他终于明白|她终于明白|(?:这|那)一刻|命运的齿轮|等着(?:你|他|她)的回答)/g],
        description: '末两段禁止空洞升华说教'
    },
    cross_chapter_simile: {
        enabled: true,
        maxCount: 1,
        scaleByLength: false,
        referenceChars: 3000,
        patterns: [],
        description: '跨章明喻/具象喻体复读检测'
    }
};

const SIMILE_PATTERN = /(?:像|如同|仿佛|好似)([\u4e00-\u9fa5]{2,12}?)(?=(?:一样|一般|似的|般)|[，。！？；：、\s]|$)/g;
const TRAILING_AUXILIARY_REGEX = /(?:一样|一般|似的|般).*$/;
const ACTION_OR_CLAUSE_TAIL_REGEX = /(?:劈进|刺得|压在|砸在|落在|掉在|划过|穿过)/;

export interface ExtractedSimile {
    vehicle: string;
    matchedText: string;
    index: number;
}

/**
 * 规范化喻体短语（剥离比喻助词及后续动作尾巴，提取核心具象喻体）
 */
export function normalizeSimileVehicle(raw: string): string {
    let cleaned = raw.trim().replace(TRAILING_AUXILIARY_REGEX, '').replace(/的$/, '');
    const tailMatch = ACTION_OR_CLAUSE_TAIL_REGEX.exec(cleaned);
    if (tailMatch && tailMatch.index > 1) {
        cleaned = cleaned.slice(0, tailMatch.index);
    }
    return cleaned.trim();
}

/**
 * 从文本中提取所有明喻短语及其归一化具象喻体
 */
export function extractConcreteSimiles(text: string): ExtractedSimile[] {
    const results: ExtractedSimile[] = [];
    const regex = new RegExp(SIMILE_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        const rawBody = match[1] ?? '';
        const vehicle = normalizeSimileVehicle(rawBody);
        if (vehicle.length >= 2) {
            results.push({
                vehicle,
                matchedText: match[0],
                index: match.index
            });
        }
    }

    return results;
}

/**
 * 将字符串转义为安全的正则字面量
 */
export function escapeRegExp(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
