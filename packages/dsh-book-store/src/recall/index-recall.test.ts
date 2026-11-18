import { cp, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSystemAdapter } from '../ports/index.js';
import { EntityProfile, EntryStatus } from '../store/schemas.js';
import { IndexRecall, parseL2CardSections } from './index.js';

const FIXTURE_BOOK_DIR = resolve(import.meta.dirname, '../../../../fixtures/sample-book');
const tempDirs: string[] = [];

async function createTempBookDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-recall-test-'));
    tempDirs.push(dir);
    await cp(FIXTURE_BOOK_DIR, dir, { recursive: true });
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

function createSampleProfile(overrides: Partial<EntityProfile> = {}): EntityProfile {
    return {
        metadata: {
            entity_id: 'char_002',
            canonical_name: '神代雪乃',
            unique_aliases: ['雪乃', '冰之审判官'],
            contextual_titles: ['风纪委员长', '铁血委员长'],
            historical_anchors: ['ch_0001:旧校舍四楼音乐室异响委托'],
            last_seen_ch: 1
        },
        sectionHeadings: {
            innateLocks: '## 1. Innate Locks',
            acquiredState: '## 2. Acquired State',
            irreversibleTrajectory: '## 3. Irreversible Trajectory',
            recentBuffer: '## 4. Recent Sliding Buffer'
        },
        innateLocks: [],
        acquiredState: [],
        irreversibleTrajectory: [],
        recentBuffer: [],
        ...overrides
    };
}

describe('IndexRecall', () => {
    it('通用职务称谓仅在 L2 出场白名单内召回，未知出场集合不全书放行', async () => {
        const bookRoot = await createTempBookDir();
        await writeFile(join(bookRoot, 'manuscripts/ch_0001.md'), '风纪委员长推开门。', 'utf8');
        await writeFile(join(bookRoot, 'manuscripts/ch_0002.md'), '风纪委员长走进另一所学校。', 'utf8');
        const recall = new IndexRecall(new NodeSystemAdapter());
        const query = { profile: createSampleProfile(), targetChapter: 3, targetDay: 10 };
        expect(await recall.recallEntitySlices(bookRoot, query)).toEqual([]);
        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), '## ch_0001 (day:1)\n- 出场实体：char_002\n\n## ch_0002 (day:2)\n- 出场实体：char_003\n', 'utf8');
        const slices = await recall.recallEntitySlices(bookRoot, query);
        expect(slices.map((slice) => slice.chapterNumber)).toEqual([1]);
    });

    it('构建双层章节目录：区分已封旧卷静态区与活跃卷动态尾，且活跃卷变更不破坏静态区字节稳定性', async () => {
        const bookRoot = await createTempBookDir();
        const system = new NodeSystemAdapter();
        const recall = new IndexRecall(system);

        await mkdir(join(bookRoot, 'lore_library'), { recursive: true });
        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });

        await writeFile(
            join(bookRoot, 'lore_library/lore_school.md'),
            '# 樱丘学园旧校舍档案\n- 三楼：社团活动室\n- 四楼：封存音乐室\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L0_sagas.md'),
            '# L0 纪元总表\n- 第一纪元：旧校舍异响篇\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L1_volumes.md'),
            '# L1 卷级总表\n- Vol 01 (day 1-3): 废部危机与四楼琴声 [已封卷]\n- Vol 02 (day 4-?): 深夜调查 [活跃]\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            '## ch_0001 (day:1)\n- 主干：神代雪乃下达废部预先通知书。\n- 锚点：四楼音乐室《月光》奏鸣曲。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_02_cards.md'),
            '## ch_0002 (day:4)\n- 主干：夜间巡查旧校舍。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/open_threads.md'),
            '- [open] 谁在傍晚六点弹奏《月光》？\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '<!-- story_day: 4 -->\n# 第二章：夜巡的回声\n\n夜风吹过旧校舍走廊。\n',
            'utf8'
        );

        const catalog1 = await recall.buildLibrarianCatalog(bookRoot, { currentVolume: 2 });

        expect(catalog1.currentVolume).toBe(2);
        expect(catalog1.sealedVolumes).toEqual([1]);
        expect(catalog1.staticPrefix).toContain('樱丘学园旧校舍档案');
        expect(catalog1.staticPrefix).toContain('L0 纪元总表');
        expect(catalog1.staticPrefix).toContain('vol_01_cards');
        expect(catalog1.staticPrefix).toContain('神代雪乃下达废部预先通知书');
        expect(catalog1.staticPrefix).not.toContain('夜间巡查旧校舍');
        expect(catalog1.staticPrefix).not.toContain('谁在傍晚六点弹奏');

        expect(catalog1.dynamicTail).toContain('夜间巡查旧校舍');
        expect(catalog1.dynamicTail).toContain('谁在傍晚六点弹奏');
        expect(catalog1.chapters.map((c) => c.chapterId)).toEqual(['ch_0001', 'ch_0002']);

        // 活跃卷新增章节并更新活跃卷章卡与伏笔台账
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            '<!-- story_day: 5 -->\n# 第三章：琴房门锁\n\n黄铜钥匙插进锁孔。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_02_cards.md'),
            '## ch_0002 (day:4)\n- 主干：夜间巡查旧校舍。\n## ch_0003 (day:5)\n- 主干：打开琴房门锁。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/open_threads.md'),
            '- [open] 谁在傍晚六点弹奏《月光》？\n- [open] 门锁内部为何有新划痕？\n',
            'utf8'
        );

        const catalog2 = await recall.buildLibrarianCatalog(bookRoot, { currentVolume: 2 });

        // 已封旧卷静态区必须保持字节级完全不变
        expect(catalog2.staticPrefix).toBe(catalog1.staticPrefix);
        expect(catalog2.dynamicTail).not.toBe(catalog1.dynamicTail);
        expect(catalog2.dynamicTail).toContain('打开琴房门锁');
        expect(catalog2.chapters.map((c) => c.chapterId)).toEqual(['ch_0001', 'ch_0002', 'ch_0003']);
    });

    it('极简工作区（仅含 sample-book 原生文件）也能构建双层目录', async () => {
        const bookRoot = await createTempBookDir();
        const system = new NodeSystemAdapter();
        const recall = new IndexRecall(system);

        const catalog = await recall.buildLibrarianCatalog(bookRoot);
        expect(catalog.currentVolume).toBe(1);
        expect(catalog.sealedVolumes).toEqual([]);
        expect(catalog.chapters).toHaveLength(1);
        expect(catalog.chapters[0]?.chapterId).toBe('ch_0001');
        expect(catalog.dynamicTail).toContain('ch_0001');
    });

    it('多身份键 rg -C 2 检索：按 active_ch/story_day 过滤称谓并包装时间差信封', async () => {
        const bookRoot = await createTempBookDir();
        const system = new NodeSystemAdapter();
        const recall = new IndexRecall(system);

        // 补充第 2、3 章用于测试称谓时间窗与时间差信封
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            [
                '<!-- story_day: 3 -->',
                '# 第二章：风波再起',
                '',
                '走廊尽头传来了急促的脚步声。',
                '学生会新任代理会长站在公告栏前。',
                '所有人都屏住了呼吸。'
            ].join('\n'),
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            [
                '<!-- story_day: 10 -->',
                '# 第三章：黄昏琴声',
                '',
                '六点的钟声刚刚敲响。',
                '雪乃停在四楼音乐室门口。',
                '空气里飘着淡淡的灰尘味。'
            ].join('\n'),
            'utf8'
        );

        const profile = createSampleProfile({
            metadata: {
                entity_id: 'char_002',
                canonical_name: '神代雪乃',
                unique_aliases: ['雪乃', '冰之审判官'],
                contextual_titles: ['风纪委员长', '代理会长'],
                historical_anchors: [],
                last_seen_ch: 3
            }
        });

        // 目标时刻为第 5 章 day:15；'风纪委员长' 仅在第 1 章生效，'代理会长' 仅在第 10 章以后生效（当前应被过滤）
        const slices = await recall.recallEntitySlices(bookRoot, {
            profile,
            targetChapter: 5,
            targetDay: 15,
            chapterDays: { 1: 1, 2: 3, 3: 10 },
            appearanceChapters: [1, 3],
            contextualTitleRules: [
                { title: '风纪委员长', minChapter: 1, maxChapter: 1, minStoryDay: 1, maxStoryDay: 2 },
                { title: '代理会长', minChapter: 10, maxChapter: 20, minStoryDay: 20, maxStoryDay: 40 }
            ]
        });

        expect(slices.length).toBeGreaterThanOrEqual(3);

        // 第 1 章应命中 '神代雪乃' / '风纪委员长' / '冰之审判官' / '雪乃'
        const ch1Slices = slices.filter((s) => s.chapterNumber === 1);
        expect(ch1Slices.length).toBeGreaterThan(0);
        expect(ch1Slices[0]?.chapterId).toBe('ch_0001');
        expect(ch1Slices[0]?.chapterDay).toBe(1);
        expect(ch1Slices[0]?.deltaDays).toBe(14);
        expect(ch1Slices[0]?.deltaChapters).toBe(4);
        expect(ch1Slices[0]?.snippet).toContain('出自第 01 章 (day:1) | 距当前第 05 章 (day:15) 已过 4 章 / 14 天');
        expect(ch1Slices[0]?.contextBefore.length).toBeLessThanOrEqual(2);
        expect(ch1Slices[0]?.contextAfter.length).toBeLessThanOrEqual(2);

        // '代理会长' 因不在 active_ch/story_day 有效窗内被过滤，因此第 2 章不应被误命中
        const ch2Slices = slices.filter((s) => s.chapterNumber === 2);
        expect(ch2Slices).toHaveLength(0);

        // 第 3 章通过 unique_aliases '雪乃' 命中，时间差为 15 - 10 = 5 天
        const ch3Slices = slices.filter((s) => s.chapterNumber === 3);
        expect(ch3Slices).toHaveLength(1);
        expect(ch3Slices[0]?.deltaDays).toBe(5);
        expect(ch3Slices[0]?.line).toBe(5);
        expect(ch3Slices[0]?.snippet).toContain('雪乃停在四楼音乐室门口');
    });

    it('成对回表校验：双端对齐标记为 paired，档案缺原稿标记 missing_manuscript_anchor，原稿缺档案标记 missing_entity_record', async () => {
        const bookRoot = await createTempBookDir();
        const system = new NodeSystemAdapter();
        const recall = new IndexRecall(system);

        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '<!-- story_day: 2 -->\n# 第二章：空无一物\n\n今天只是一次普通的数学小测。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            '<!-- story_day: 5 -->\n# 第三章：遗落之物\n\n桌缝里赫然卡着那瓶半满的波子汽水。\n',
            'utf8'
        );

        // 1. 完全成对：档案声明 ch_0001，原稿 ch_0001 存在 "波子汽水"
        const pairedItem = createSampleProfile({
            metadata: {
                entity_id: 'item_001',
                canonical_name: '波子汽水',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: ['ch_0001:玻璃弹珠'],
                last_seen_ch: 1
            },
            acquiredState: [
                { chapter: 1, storyDay: 1, text: '放在活动室桌角', continuationLines: [] }
            ]
        });

        const resPaired = await recall.verifyPairedRecall(bookRoot, {
            profile: pairedItem,
            targetChapter: 1,
            targetDay: 1,
            chapterFiles: ['manuscripts/ch_0001.md'],
            chapterDays: { 1: 1 }
        });
        expect(resPaired.paired).toBe(true);
        expect(resPaired.overallStatus).toBe('paired');
        expect(resPaired.unpairedIssues).toHaveLength(0);
        expect(resPaired.chapterVerifications[0]?.status).toBe('paired');

        // 2. 混合异常：档案声明 ch_0001 & ch_0002，原稿实际命中 ch_0001 & ch_0003
        const brokenItem = createSampleProfile({
            metadata: {
                entity_id: 'item_001',
                canonical_name: '波子汽水',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 2
            },
            acquiredState: [
                { chapter: 1, storyDay: 1, text: '放在活动室桌角', continuationLines: [] },
                { chapter: 2, storyDay: 2, text: '被带到数学考场', continuationLines: [] }
            ]
        });

        const resUnpaired = await recall.verifyPairedRecall(bookRoot, {
            profile: brokenItem,
            targetChapter: 3,
            targetDay: 5,
            chapterDays: { 1: 1, 2: 2, 3: 5 }
        });

        expect(resUnpaired.paired).toBe(false);
        expect(resUnpaired.overallStatus).toBe('unpaired');

        const byCh = new Map(resUnpaired.chapterVerifications.map((c) => [c.chapterNumber, c]));
        expect(byCh.get(1)?.status).toBe('paired');
        expect(byCh.get(2)?.status).toBe('missing_manuscript_anchor');
        expect(byCh.get(3)?.status).toBe('missing_entity_record');
        expect(resUnpaired.unpairedIssues.map((i) => i.chapterNumber)).toEqual([2, 3]);
    });

    it('回归：活跃卷章卡正文提及旧卷 ch_0001 时不篡改卷归属且不污染旧卷静态区，且剥离 lore frontmatter', async () => {
        const bookRoot = await createTempBookDir();
        const system = new NodeSystemAdapter();
        const recall = new IndexRecall(system);

        await mkdir(join(bookRoot, 'lore_library'), { recursive: true });
        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });

        await writeFile(
            join(bookRoot, 'lore_library/lore_music_room.md'),
            '---\ntags: [location, secret]\n---\n# 四楼音乐室设定\n- 傍晚六点会传出无人弹奏的琴声\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            '## ch_0001 (day:1)\n- 主干：神代雪乃下达废部通知。\n',
            'utf8'
        );
        // 活跃卷章卡正文（非 ## 标题）引用 ch_0001
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_02_cards.md'),
            '## ch_0002 (day:4)\n- 主干：回收 ch_0001 埋下的四楼琴声伏笔。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '<!-- story_day: 4 -->\n# 第二章：回溯\n\n他们重新走进旧校舍。\n',
            'utf8'
        );

        const catalog = await recall.buildLibrarianCatalog(bookRoot, { currentVolume: 2 });

        // ch_0001 必须仍归属第 1 卷，不得被 vol_02_cards 正文提及覆盖成第 2 卷
        const ch1 = catalog.chapters.find((c) => c.chapterNumber === 1);
        const ch2 = catalog.chapters.find((c) => c.chapterNumber === 2);
        expect(ch1?.volumeNumber).toBe(1);
        expect(ch2?.volumeNumber).toBe(2);

        // 活跃卷动态尾只列活跃卷章节，不应把 ch_0001 混入 Active Volume Chapters
        expect(catalog.dynamicTail).not.toContain('- ch_0001 (');
        expect(catalog.dynamicTail).toContain('- ch_0002 (');

        // 旧卷静态区不包含活跃卷章卡，且 lore 摘要剥离了 frontmatter 直接展示标题
        expect(catalog.staticPrefix).not.toContain('回收 ch_0001 埋下的四楼琴声伏笔');
        expect(catalog.staticPrefix).toContain('- lore_music_room.md: 四楼音乐室设定 |');
        expect(catalog.staticPrefix).not.toContain('tags: [location, secret]');
    });

    it('回归：成对回表校验识别条目行内 [锚点 ch_XXXX] 声明', async () => {
        const bookRoot = await createTempBookDir();
        const system = new NodeSystemAdapter();
        const recall = new IndexRecall(system);

        const profileWithInlineAnchor = createSampleProfile({
            metadata: {
                entity_id: 'item_002',
                canonical_name: '波子汽水',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 1
            },
            innateLocks: [
                { text: '桌角半瓶波子汽水内的玻璃弹珠 [锚点 ch_0001]', continuationLines: [] }
            ]
        });

        const res = await recall.verifyPairedRecall(bookRoot, {
            profile: profileWithInlineAnchor,
            targetChapter: 1,
            targetDay: 1,
            chapterFiles: ['manuscripts/ch_0001.md'],
            chapterDays: { 1: 1 }
        });

        expect(res.paired).toBe(true);
        expect(res.overallStatus).toBe('paired');
        expect(res.chapterVerifications[0]?.status).toBe('paired');
        expect(res.chapterVerifications[0]?.entityEntries).toHaveLength(1);
    });

    it('实例级章节缓存：复用未变更缓存、(mtimeMs, size, chapterHash) 联合防等长碰撞、clearCache 按书隔离与暂存覆盖层优先', async () => {
        const bookRootA = await createTempBookDir();
        const bookRootB = await createTempBookDir();
        const recall = new IndexRecall(new NodeSystemAdapter());

        const ch1PathA = join(bookRootA, 'manuscripts/ch_0001.md');
        const ch1PathB = join(bookRootB, 'manuscripts/ch_0001.md');
        const baseContentA = '<!-- story_day: 2 -->\n# 第一章\n\n神代雪乃在旧校舍门前AAA。\n';
        const sameLenContentA = '<!-- story_day: 7 -->\n# 第一章\n\n神代雪乃在旧校舍门前BBB。\n';
        expect(Buffer.byteLength(baseContentA, 'utf8')).toBe(Buffer.byteLength(sameLenContentA, 'utf8'));

        await writeFile(ch1PathA, baseContentA, 'utf8');
        await writeFile(ch1PathB, '<!-- story_day: 4 -->\n# 第一章B\n\n神代雪乃在图书馆CCC。\n', 'utf8');
        const stBeforeQuantize = await stat(ch1PathA);
        await utimes(ch1PathA, stBeforeQuantize.atime, stBeforeQuantize.mtime);
        const stInitial = await stat(ch1PathA);

        const profile = createSampleProfile({
            metadata: {
                entity_id: 'char_002',
                canonical_name: '神代雪乃',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 1
            }
        });

        // 1. 首次读取命中并缓存 (hash_v1)
        const slices1 = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            chapterHashes: { ch_0001: 'hash_v1' }
        });
        expect(slices1[0]?.text).toContain('AAA');
        expect(slices1[0]?.chapterDay).toBe(2);

        // 2. 同 mtimeMs + 同 size 覆写：传入相同 hash_v1 时命中缓存（不读盘），传入新 hash_v2 时立刻穿透刷新
        await writeFile(ch1PathA, sameLenContentA, 'utf8');
        await utimes(ch1PathA, stInitial.atime, stInitial.mtime);

        const cachedHitSlices = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            chapterHashes: { ch_0001: 'hash_v1' }
        });
        expect(cachedHitSlices[0]?.text).toContain('AAA');

        const refreshedSlices = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            chapterHashes: { ch_0001: 'hash_v2' }
        });
        expect(refreshedSlices[0]?.text).toContain('BBB');
        expect(refreshedSlices[0]?.chapterDay).toBe(7);

        // 3. 暂存覆盖层（stagingOverlay / stagingRead）优先于磁盘缓存，且不污染磁盘缓存，支持 null 标记删除
        const stagingOverlay = new Map<string, string | null>([
            ['manuscripts/ch_0001.md', '<!-- story_day: 9 -->\n# 第一章暂存\n\n神代雪乃在屋顶DDD。\n']
        ]);
        const stagedSlices = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            stagingOverlay
        });
        expect(stagedSlices[0]?.text).toContain('DDD');
        expect(stagedSlices[0]?.chapterDay).toBe(9);

        const deletedOverlay = new Map<string, string | null>([['manuscripts/ch_0001.md', null]]);
        const deletedSlices = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            stagingOverlay: deletedOverlay
        });
        expect(deletedSlices).toEqual([]);

        const stagingReadSlices = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            stagingRead: (rel) =>
                rel === 'manuscripts/ch_0001.md'
                    ? '<!-- story_day: 8 -->\n# 第一章读回调\n\n神代雪乃在琴房EEE。\n'
                    : undefined
        });
        expect(stagingReadSlices[0]?.text).toContain('EEE');

        // 移去暂存后磁盘缓存仍为 BBB
        const dayMapA = await recall.resolveChapterDayMap(bookRootA, ['manuscripts/ch_0001.md']);
        expect(dayMapA.get(1)).toBe(7);

        // 4. bookRoot 隔离缓存与 clearCache(bookRootA) 不影响 bookRootB
        const slicesB = await recall.recallEntitySlices(bookRootB, {
            profile,
            targetChapter: 2,
            targetDay: 10
        });
        expect(slicesB[0]?.text).toContain('CCC');

        await writeFile(ch1PathA, baseContentA, 'utf8');
        await utimes(ch1PathA, stInitial.atime, stInitial.mtime);
        recall.clearCache(bookRootA);

        const afterClearA = await recall.recallEntitySlices(bookRootA, {
            profile,
            targetChapter: 2,
            targetDay: 10,
            chapterHashes: { ch_0001: 'hash_v2' }
        });
        expect(afterClearA[0]?.text).toContain('AAA');
        expect((await recall.resolveChapterDayMap(bookRootB, ['manuscripts/ch_0001.md'])).get(1)).toBe(4);
    });

    it('段级多词共现打分、focusChapters 第一优先级与 maxSlicesPerEntity / sliceMaxChars 截断', async () => {
        const bookRoot = await createTempBookDir();
        const recall = new IndexRecall(new NodeSystemAdapter());

        await writeFile(
            join(bookRoot, 'manuscripts/ch_0001.md'),
            [
                '<!-- story_day: 1 -->',
                '# 第一章',
                '',
                '前文铺垫一段很长的背景描述，用于验证上下文保留与总字符预算截断时不会挤掉命中核心段落。',
                '',
                '神代雪乃只是路过走廊。',
                '',
                '冰之审判官神代雪乃站在旧校舍 音乐室门前，手里拿着钥匙。',
                '',
                '神代雪乃推开旧校舍里的音乐室。',
                '',
                '后文还有一段补充描写。'
            ].join('\n'),
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            [
                '<!-- story_day: 2 -->',
                '# 第二章',
                '',
                '神代雪乃在旧校舍门前停步。'
            ].join('\n'),
            'utf8'
        );

        const profile = createSampleProfile({
            metadata: {
                entity_id: 'char_002',
                canonical_name: '神代雪乃',
                unique_aliases: ['冰之审判官'],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 2
            }
        });

        // 未指定 focusChapters 时：ch_0001 精确短语+双身份键段排在首位，其次是拆词共现段，再其次是 ch_0002
        const scoredSlices = await recall.recallEntitySlices(bookRoot, {
            profile,
            targetChapter: 3,
            targetDay: 10,
            extraKeywords: ['旧校舍 音乐室'],
            sliceContextParagraphs: 1,
            sliceMaxChars: 130,
            maxSlicesPerEntity: 3
        });

        expect(scoredSlices).toHaveLength(3);
        expect(scoredSlices[0]?.text).toContain('冰之审判官神代雪乃站在旧校舍 音乐室门前');
        expect(scoredSlices[1]?.text).toContain('神代雪乃推开旧校舍里的音乐室');
        expect(scoredSlices[0]?.contextBefore.length).toBeLessThanOrEqual(1);
        expect(scoredSlices[0]?.contextAfter.length).toBeLessThanOrEqual(1);
        for (const s of scoredSlices) {
            expect(s.snippet.length).toBeLessThanOrEqual(130);
        }

        // 指定 focusChapters: [2] 且 maxSlicesPerEntity: 1 时，ch_0002 获得 +1000 优先并直接截断返回 1 条
        const focusedOnly = await recall.recallEntitySlices(bookRoot, {
            profile,
            targetChapter: 3,
            targetDay: 10,
            extraKeywords: ['旧校舍 音乐室'],
            focusChapters: [2],
            maxSlicesPerEntity: 1,
            sliceContextParagraphs: 0
        });
        expect(focusedOnly).toHaveLength(1);
        expect(focusedOnly[0]?.chapterNumber).toBe(2);
        expect(focusedOnly[0]?.contextBefore).toEqual([]);
        expect(focusedOnly[0]?.contextAfter).toEqual([]);

        // 指定 focusChapters: [2] 但 maxSlicesPerEntity: 2 时，ch_0002 排第 1，其余章按相关性补足 1 条
        const focusedPlusFallback = await recall.recallEntitySlices(bookRoot, {
            profile,
            targetChapter: 3,
            targetDay: 10,
            extraKeywords: ['旧校舍 音乐室'],
            focusChapters: [2],
            maxSlicesPerEntity: 2,
            sliceContextParagraphs: 1
        });
        expect(focusedPlusFallback).toHaveLength(2);
        expect(focusedPlusFallback[0]?.chapterNumber).toBe(2);
        expect(focusedPlusFallback[1]?.chapterNumber).toBe(1);
        expect(focusedPlusFallback[1]?.text).toContain('冰之审判官神代雪乃站在旧校舍 音乐室门前');
    });

    it('buildLibrarianCatalog 定长块冻结折叠与半角/全角冒号 L2 卡解析兼容性', async () => {
        const bookRoot = await createTempBookDir();
        const recall = new IndexRecall(new NodeSystemAdapter());

        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(join(bookRoot, 'manuscripts/ch_0002.md'), '风纪委员长在走廊出现。', 'utf8');
        await writeFile(join(bookRoot, 'manuscripts/ch_0003.md'), '风纪委员长在天台出现。', 'utf8');

        // 1. 验证 L2 卡半角冒号与全角冒号同时兼容 (- 出场实体[:：] / - 异象锚点[:：])
        const mixedColonCard = [
            '# 第 1 卷双轨章卡',
            '',
            '## ch_0001 (day:1)',
            '- 主干剧情: 神代雪乃下达废部通知。后续细节略。',
            '- 异象锚点: 玻璃弹珠, 四楼《月光》',
            '- 出场实体: char_001',
            '',
            '## ch_0002 (day:2)',
            '- 主干剧情: 夜巡旧校舍发现新划痕。',
            '- 异象锚点: 黄铜钥匙，门锁划痕',
            '- 出场实体: char_002',
            '',
            '## ch_0003 (day:3)',
            '- 主干剧情：天台交锋。',
            '- 异象锚点：铁门锁链',
            '- 出场实体：char_003'
        ].join('\n');

        const parsedCard = parseL2CardSections(mixedColonCard);
        expect(parsedCard.sections).toHaveLength(3);
        expect(parsedCard.sections[0]?.appearedEntityIds).toEqual(['char_001']);
        expect(parsedCard.sections[0]?.anomalyAnchors).toEqual(['玻璃弹珠', '四楼《月光》']);
        expect(parsedCard.sections[1]?.appearedEntityIds).toEqual(['char_002']);
        expect(parsedCard.sections[1]?.anomalyAnchors).toEqual(['黄铜钥匙', '门锁划痕']);
        expect(parsedCard.sections[2]?.appearedEntityIds).toEqual(['char_003']);
        expect(parsedCard.sections[2]?.anomalyAnchors).toEqual(['铁门锁链']);

        await writeFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), mixedColonCard, 'utf8');
        const roleSlices = await recall.recallEntitySlices(bookRoot, {
            profile: createSampleProfile({
                metadata: {
                    entity_id: 'char_002',
                    canonical_name: '不可能匹配的名字',
                    unique_aliases: [],
                    contextual_titles: ['风纪委员长'],
                    historical_anchors: [],
                    last_seen_ch: 2
                }
            }),
            targetChapter: 4,
            targetDay: 10
        });
        expect(roleSlices.map((s) => s.chapterNumber)).toEqual([2]);

        // 2. 验证超过 l2FullUnfrozenThreshold 后按 l2FreezeBlockChapters 整块冻结进 staticPrefix 且前缀稳定
        const buildCardText = (count: number) =>
            [
                '# 第 1 卷双轨章卡',
                '',
                ...Array.from({ length: count }, (_, idx) => {
                    const ch = idx + 1;
                    const chId = `ch_${String(ch).padStart(4, '0')}`;
                    const colon = ch % 2 === 0 ? '：' : ':';
                    return [
                        `## ${chId} (day:${ch})`,
                        `- 主干剧情${colon} 第 ${ch} 章主干首句。第 ${ch} 章次句补充。`,
                        `- 异象锚点${colon} 线索_${ch}`,
                        `- 出场实体${colon} char_001, char_002`
                    ].join('\n');
                })
            ].join('\n\n');

        await writeFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), buildCardText(4), 'utf8');
        const cat4 = await recall.buildLibrarianCatalog(bookRoot, {
            currentVolume: 1,
            l2FullUnfrozenThreshold: 4,
            l2FreezeBlockChapters: 2
        });
        expect(cat4.staticPrefix).not.toContain('Frozen Active Volume Index');
        expect(cat4.dynamicTail).toContain('第 1 章次句补充');

        await writeFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), buildCardText(5), 'utf8');
        const cat5 = await recall.buildLibrarianCatalog(bookRoot, {
            currentVolume: 1,
            l2FullUnfrozenThreshold: 4,
            l2FreezeBlockChapters: 2
        });
        expect(cat5.staticPrefix).toContain('Frozen Active Volume Index: vol_01_cards.md (ch_0001-ch_0002)');
        expect(cat5.staticPrefix).toContain('Frozen Active Volume Index: vol_01_cards.md (ch_0003-ch_0004)');
        expect(cat5.staticPrefix).toContain('- ch_0001 (day:1) | 第 1 章主干首句。 | 出场实体: char_001, char_002');
        expect(cat5.staticPrefix).not.toContain('第 1 章次句补充');
        expect(cat5.dynamicTail).toContain('## ch_0005 (day:5)');
        expect(cat5.dynamicTail).toContain('第 5 章次句补充');
        expect(cat5.dynamicTail).not.toContain('## ch_0004');

        // 新增第 6 章（未满新整块），staticPrefix 保持字节级完全不变
        await writeFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), buildCardText(6), 'utf8');
        const cat6 = await recall.buildLibrarianCatalog(bookRoot, {
            currentVolume: 1,
            l2FullUnfrozenThreshold: 4,
            l2FreezeBlockChapters: 2
        });
        expect(cat6.staticPrefix).toBe(cat5.staticPrefix);
        expect(cat6.dynamicTail).toContain('## ch_0005 (day:5)');
        expect(cat6.dynamicTail).toContain('## ch_0006 (day:6)');
    });

    it('verifyPairedRecall：空证据返回 unpaired、不篡改 focusChapters、过滤 WARPED 且支持双侧缺席与不截断审计', async () => {
        const bookRoot = await createTempBookDir();
        const recall = new IndexRecall(new NodeSystemAdapter());

        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '<!-- story_day: 2 -->\n# 第二章\n\n今天毫无异常。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            '<!-- story_day: 3 -->\n# 第三章\n\n桌上放着那瓶波子汽水。\n',
            'utf8'
        );

        // 1. 声明章与命中章均为空且未传 focusChapters -> paired: false, overallStatus: 'unpaired'
        const emptyProfile = createSampleProfile({
            metadata: {
                entity_id: 'item_999',
                canonical_name: '完全不存在的物件',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 0
            }
        });
        const emptyRes = await recall.verifyPairedRecall(bookRoot, {
            profile: emptyProfile,
            targetChapter: 3,
            targetDay: 3
        });
        expect(emptyRes.paired).toBe(false);
        expect(emptyRes.overallStatus).toBe('unpaired');
        expect(emptyRes.chapterVerifications).toEqual([]);

        // 2. focusChapters 不可变 + 过滤大小写不敏感 WARPED 条目 + 双侧均无记录标记 missing_both
        const warpedAndMixedProfile = createSampleProfile({
            metadata: {
                entity_id: 'item_001',
                canonical_name: '波子汽水',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 3
            },
            acquiredState: [
                { chapter: 1, storyDay: 1, status: 'ACTIVE', text: '出现在活动室桌角', continuationLines: [] },
                { chapter: 2, storyDay: 2, status: 'warped' as unknown as EntryStatus, text: '被扭曲时间线作废的记录', continuationLines: [] },
                { chapter: 3, storyDay: 3, status: 'ACTIVE', text: '再次出现在桌上', continuationLines: [] }
            ]
        });

        const inputFocus = [3, 1, 2];
        const auditRes = await recall.verifyPairedRecall(bookRoot, {
            profile: warpedAndMixedProfile,
            targetChapter: 3,
            targetDay: 3,
            focusChapters: inputFocus,
            maxSlicesPerEntity: 1 // verifyPairedRecall 内部绝不截断
        });

        expect(inputFocus).toEqual([3, 1, 2]);
        expect(auditRes.paired).toBe(false);
        expect(auditRes.overallStatus).toBe('unpaired');

        const statusByCh = new Map(auditRes.chapterVerifications.map((v) => [v.chapterNumber, v.status]));
        expect(statusByCh.get(1)).toBe('paired');
        expect(statusByCh.get(2)).toBe('missing_both');
        expect(statusByCh.get(3)).toBe('paired');
        expect(auditRes.unpairedIssues.map((i) => i.chapterNumber)).toEqual([2]);
    });
});
