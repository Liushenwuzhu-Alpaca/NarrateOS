import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dotenv = join(root, '.env');
// Node 的 dotenv 解析器只补齐未导出的变量，不执行文件中的 shell 代码。
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;
const sandbox = resolve(env.NARRATEOS_SANDBOX_DIR || join(tmpdir(), 'narrateos-sandbox'));
const home = join(sandbox, 'home');
const profile = join(home, 'profiles', 'narrateos');
const modules = join(profile, 'node_modules');
const workspace = join(sandbox, 'ws');
const dsh = join(root, 'node_modules/.bin/dsh');
const backends = ['dsh-book-store', 'dsh-book-tools', 'dsh-pipeline'];
const studio = 'dsh-client-ui-studio';
const preset = 'dsh-preset-narrateos';

// GUI 管理已存在的 profile。初始化只创建缺失项，不替换依赖、bundle 或用户补丁。
async function createIfMissing(operation) {
    try {
        await operation();
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}
await mkdir(join(modules, '@narrateos'), { recursive: true });
await mkdir(join(workspace, 'books'), { recursive: true });
await createIfMissing(() => symlink(join(root, 'node_modules/@deepseek-ai'), join(modules, '@deepseek-ai'), 'dir'));
for (const name of [...backends, studio, preset]) {
    const target = join(root, name === preset ? 'presets' : 'packages', name);
    await createIfMissing(() => symlink(target, join(modules, '@narrateos', name), 'dir'));
}

// 包声明存在不等于入口就绪。检查 profile 实际指向的文件，而非猜测 checkout 的构建状态。
await access(dsh, constants.X_OK);
for (const path of [
    join(modules, '@deepseek-ai/dsh/lib/bin.js'),
    ...[...backends, studio].map(name => join(modules, '@narrateos', name, 'dist/index.js')),
    join(modules, '@narrateos', studio, 'dist/client.js'),
    join(modules, '@narrateos', preset, 'cordis.patch.yml')
]) {
    if (!(await stat(path).catch(() => null))?.isFile()) {
        throw new Error(`缺少宿主或插件入口 ${path}；请先执行 pnpm install 和 pnpm run build。`);
    }
}
const manifest = {
    name: 'dsh-profile-narrateos', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', `@narrateos/${preset}`] } }
};
const patches = [{ id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } }];
const raw = env.NARRATEOS_SANDBOX_AGENT_MODEL || env.NARRATEOS_MODEL_STRONG;
if (raw) {
    const split = raw.indexOf(':');
    const provider = split < 0 ? env.NARRATEOS_SANDBOX_PROVIDER || env.NARRATEOS_PROVIDER_STRONG || 'deepseek-official' : raw.slice(0, split);
    const model = split < 0 ? raw : raw.slice(split + 1);
    if (!provider || !model) throw new Error('默认模型需要完整的 provider:model。');
    // 模型能力（模态、窗口大小等）由实际 provider 注册，不伪造提供方模型目录。
    patches.push({ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model',
        config: { provider, model, reasoningEffort: env.NARRATEOS_SANDBOX_EFFORT || 'high' } });
}
for (const [name, data] of [['package.json', manifest], ['cordis.patch.yml', patches]]) {
    // JSON 是合法 YAML；引号、反斜线和换行均按数据转义。
    await createIfMissing(() => writeFile(join(profile, name), JSON.stringify(data, null, 4) + '\n', { flag: 'wx', mode: 0o600 }));
}
console.log(`NarrateOS sandbox 已就绪：${sandbox}`);
if (!process.argv.includes('--init-only')) {
    // 不读取或复制其他 profile 的托管凭据，不将启动输出（可能含临时访问令牌）落盘。
    if (env.DEEPSEEK_API_KEY && existsSync(join(home, '.credentials.yaml'))) {
        console.warn('沙盒已有托管凭据，DSH 将优先使用它；要测试环境凭据，请使用新的 NARRATEOS_SANDBOX_DIR。');
    }
    const result = spawnSync(dsh, ['--profile', 'narrateos', '--no-open', '--host', env.HOST || '127.0.0.1', '--port', env.PORT || '0'],
        { cwd: workspace, env: { ...env, DSH_HOME: home }, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
