/** 文风纪律与剧情场景使用不同的否定指令识别强度，掩码保留原文索引。 */
export interface NegativeDirectiveMatch {
    text: string;
    index: number;
    context: string;
}

const NEGATIVE_WORDS = '(?:禁止|严禁|禁用|不要|不得|切忌|绝不|决不|不能|不可|切勿|莫要)';
const IDIOMS_RE = /微不可察|不可思议|不可或缺|不可避免|不得已|迫不得已|不能自已|欲罢不能|不约而同/g;
const SHORT_QUOTES_RE = /“[^”，。！？；\n]{1,15}”|「[^」，。！？；\n]{1,15}」|『[^』，。！？；\n]{1,15}』|"[^"，。！？；\n]{1,15}"/g;

/** 剧情只拦明确写作指令；角色保密动作和道具短引文仍属剧情。 */
export function findNegativeDirectives(
    text: string,
    mode: 'narrative' | 'discipline'
): NegativeDirectiveMatch[] {
    let masked = text.replace(IDIOMS_RE, value => ' '.repeat(value.length));
    if (mode === 'narrative') {
        masked = masked.replace(SHORT_QUOTES_RE, value => ' '.repeat(value.length));
    }
    const pattern = mode === 'discipline'
        ? new RegExp(NEGATIVE_WORDS, 'g')
        : new RegExp(
            `(?:写手|本章|本场|文中|正文|行文|叙事上|描写上|细纲中)[^，、。！？；\\n]{0,12}${NEGATIVE_WORDS}` +
            `|作者[^，、。！？；\\n]{0,12}${NEGATIVE_WORDS}[^，、。！？；\\n]{0,8}(?:描写|写出|写成|写作)` +
            `|(?:^|[，。！？；\\n])\\s*(?:[-*]\\s*)?${NEGATIVE_WORDS}[^，、。！？；\\n]{0,8}(?:描写|写出|写成|写作|剧透|泄底|写破|点破真相)`,
            'g'
        );
    return Array.from(masked.matchAll(pattern), match => {
        const index = match.index;
        return {
            text: text.slice(index, index + match[0].length),
            index,
            context: text.slice(Math.max(0, index - 15), index + match[0].length + 15)
        };
    });
}

/** 对每个字段分别报告所有命中，定位始终使用未掩码的原文。 */
export function formatNegativeDirectiveViolations(
    fields: Readonly<Record<string, string>>,
    mode: 'narrative' | 'discipline'
): string[] {
    return Object.entries(fields).flatMap(([field, text]) =>
        findNegativeDirectives(text, mode).map(hit =>
            `[${field}] 写手受限否定禁令「${hit.text}」（位置 ${hit.index + 1}）：…${hit.context}…`
        )
    );
}
