import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('沙盒仅初始化缺失配置，保留环境优先级与完整模型路由', async t => {
    const scratch = join(root, '.scratch');
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, 'sandbox test '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const launcher = join(dir, 'scripts/dev-sandbox.mjs');
    await mkdir(dirname(launcher));
    await cp(join(root, 'scripts/dev-sandbox.mjs'), launcher);
    const seed = async (name, data = '', mode = 0o644) => {
        const path = join(dir, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data, { mode });
    };
    const home = join(dir, 'relative dir/home');
    const model = 'foreign:id:"quoted"\\name';
    await seed('.env', 'NARRATEOS_SANDBOX_DIR="relative dir"\nNARRATEOS_SANDBOX_AGENT_MODEL=wrong:wrong\n');
    await seed('node_modules/.bin/dsh', '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$PWD"\n', 0o755);
    await seed('node_modules/@deepseek-ai/dsh/lib/bin.js');
    for (const name of ['dsh-book-store', 'dsh-book-tools', 'dsh-pipeline', 'dsh-client-ui-studio']) {
        await seed(`packages/${name}/dist/index.js`);
    }
    await seed('presets/dsh-preset-narrateos/cordis.patch.yml');
    const run = (...args) => spawnSync(process.execPath, [launcher, ...args], {
        cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, NARRATEOS_SANDBOX_AGENT_MODEL: model }
    });
    const missing = run('--init-only');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /dist\/client\.js/);
    await seed('packages/dsh-client-ui-studio/dist/client.js');
    const init = run('--init-only');
    assert.equal(init.status, 0, init.stderr);
    const profile = join(home, 'profiles/narrateos');
    const patch = join(profile, 'cordis.patch.yml');
    const rows = JSON.parse(await readFile(patch, 'utf8'));
    assert.deepEqual(rows.find(r => r.id === 'agent-default-model').config, {
        provider: 'foreign', model: 'id:"quoted"\\name', reasoningEffort: 'high'
    });
    assert.ok(!rows.some(r => r.id === 'llm-deepseek'));
    await writeFile(patch, '[] # saved by GUI');
    const manifest = join(profile, 'package.json');
    await writeFile(manifest, '{"private":true}');
    const launch = run();
    assert.equal(launch.status, 0, launch.stderr);
    assert.ok(launch.stdout.includes(`${home}\n${join(dir, 'relative dir/ws')}`));
    assert.equal(await readFile(patch, 'utf8'), '[] # saved by GUI');
    assert.equal(await readFile(manifest, 'utf8'), '{"private":true}');
    await assert.rejects(stat(join(dir, 'relative dir/dsh.log')), { code: 'ENOENT' });
});
