import type { BookSnapshot, CraftPluginLoader, GateRuleId, LoadedCraftPlugin } from '@narrateos/dsh-book-store';

/** Writer 与声纹入池共用规则合并顺序：插件白名单顺序，然后应用书级覆盖。 */
export function resolveWriterGateRules(loader: CraftPluginLoader, plugins: LoadedCraftPlugin[], config: BookSnapshot['config']) {
    const rules = loader.mergeExtraGateRules(plugins, 'writer');
    for (const [id, override] of Object.entries(config.prose_gate.rules ?? {})) {
        const key = id as GateRuleId;
        rules[key] = {
            ...rules[key],
            ...(override.enabled !== undefined && { enabled: override.enabled }),
            ...(override.max_count !== undefined && { maxCount: override.max_count }),
            ...(override.scale_by_length !== undefined && { scaleByLength: override.scale_by_length }),
            ...(override.reference_chars !== undefined && { referenceChars: override.reference_chars }),
            ...(override.last_paragraphs_only !== undefined && { lastParagraphsOnly: override.last_paragraphs_only })
        };
    }
    return rules;
}
