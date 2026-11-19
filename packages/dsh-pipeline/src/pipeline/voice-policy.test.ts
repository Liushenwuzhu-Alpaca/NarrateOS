import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BookStore, NodeSystemAdapter, type LlmPort } from '@narrateos/dsh-book-store';
import { createGitBookWorkspace } from '../test-harness.js';
import { harvestVoiceWithPool } from './voice-harvest.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const usage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 };

it('过滤编造原句、含别名标签和书级插件违例，首章不足三句不动池', async () => {
    const root = await createGitBookWorkspace(dirs, 'voice-policy', { storyDay: 1, currentChapter: 1 });
    const store = new BookStore(root, new NodeSystemAdapter());
    const whole = '潮落。门响。船停。风息。';
    const config = await store.readBookConfig();
    const pluginDir = join(root, 'plugins');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'v.json'), JSON.stringify({ id: 'book-voice', name: '声纹规则', version: '1', description: '文风', applicable_roles: ['writer'], prompt_injection: '文风', extra_gate_rules: { fog: { terms: ['风息'] } } }));
    await store.writeBookConfig({ ...config, craft_plugins: ['book-voice'] });
    const llm: LlmPort = { generate: async () => ({ usage, text: JSON.stringify({ samples: [
        { text: '潮落。', tag: '平静' }, { text: '门响。', tag: '默哥' }, { text: '船停。', tag: '动作' },
        { text: '风息。', tag: '天气' }, { text: '谎报。', tag: '虚构' }
    ] }) }) };
    const before = await store.readVoiceSamples();
    await expect(harvestVoiceWithPool({ store, llm, chapterText: whole, pluginSearchDirs: [pluginDir] })).rejects.toThrow('有效原句不足');
    expect(await store.readVoiceSamples()).toEqual(before);
});

it('等待模型期间声纹池有新版本，拒绝整池覆盖', async () => {
    const root = await createGitBookWorkspace(dirs, 'voice-concurrent', { storyDay: 1, currentChapter: 1 });
    const store = new BookStore(root, new NodeSystemAdapter());
    const samples = ['风停。', '门开。', '帆落。'].map((text) => ({ tag: '动作', text }));
    const llm: LlmPort = { generate: async () => {
        await store.writeVoiceSamples({ samples: [{ id: 'author', text: '新样章', tag: '新增', last_used_ch: 0 }] });
        return { usage, text: JSON.stringify({ samples }) };
    } };
    await expect(harvestVoiceWithPool({ store, llm, chapterText: '风停。门开。帆落。' })).rejects.toThrow('声纹池已更新');
    expect((await store.readVoiceSamples()).samples[0]?.id).toBe('author');
});

it.each(['boot_seed', 'chapter_harvest'] as const)('滚动池不足目标时替换并补齐，已有来源为 %s', async (source) => {
    const root = await createGitBookWorkspace(dirs, `voice-refill-${source}`, { storyDay: 2, currentChapter: 2 });
    const store = new BookStore(root, new NodeSystemAdapter());
    const currentPool = { samples: ['旧门。', '旧帆。'].map((text, i) => ({ id: `old_${i}`, tag: '动作', text, last_used_ch: 0, source })) };
    await store.writeVoiceSamples(currentPool);
    const samples = ['风停。', '门开。', '帆落。', '潮退。'].map((text) => ({ tag: '动作', text }));
    const llm: LlmPort = { generate: async () => ({ usage, text: JSON.stringify({ samples }) }) };
    const result = await harvestVoiceWithPool({ store, llm, chapterNumber: 2, chapterText: '风停。门开。帆落。潮退。', rollingReplaceBootSeeds: true });
    expect(result.skipped).toBe(false);
    expect(result.updatedPool.samples).toHaveLength(4);
    expect(result.updatedPool.samples.every((sample) => sample.source === 'chapter_harvest')).toBe(true);
    expect(result.replacedIds).toEqual(source === 'boot_seed' ? ['old_0', 'old_1'] : []);
    expect(result.harvestedCount).toBe(source === 'boot_seed' ? 4 : 2);
    expect(await store.readVoiceSamples()).toEqual(result.updatedPool);
});
