import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('静态门禁检查忽略样本的实际字节、发布插件与 Studio 构建输入', async t => {
    const scratch = join(root, '.scratch');
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, 'release gates '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const seed = async (path, data = '') => {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), data);
    };
    const studio = 'packages/dsh-client-ui-studio/';
    await seed('.gitignore', '.env\n/manuscript/\n');
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    await mkdir(join(dir, 'scripts'));
    await cp(join(root, 'scripts/lint-repo.mjs'), join(dir, 'scripts/lint-repo.mjs'));
    for (const path of ['src/index.ts', 'scripts/bundle-client.mjs', 'tsconfig.client.json', 'dist/index.js', 'dist/client.js']) {
        await seed(studio + path);
    }
    const run = () => spawnSync(process.execPath, ['scripts/lint-repo.mjs'], { cwd: dir, encoding: 'utf8' });
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    await seed('manuscript/vol-01/ch-01.md', '合成样本');
    await seed('plugins/craft/broken.yaml', 'x\u2011y');
    const future = new Date(Date.now() + 60_000);
    await utimes(join(dir, studio, 'tsconfig.client.json'), future, future);
    const bad = run();
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /readonly-fixture-clean/);
    assert.match(bad.stderr, /no-u2011.*plugins\/craft\/broken/);
    assert.match(bad.stderr, /studio-bundle-fresh/);

    await cp(join(root, studio, 'scripts/bundle-client.mjs'), join(dir, studio, 'scripts/bundle-client.mjs'));
    await seed(studio + 'dist/client-raw/partial.js', 'exports.x = 1;');
    const bundle = spawnSync(process.execPath, [studio + 'scripts/bundle-client.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(bundle.status, 0);
    assert.match(bundle.stderr, /入口.*index\.js/);
});
