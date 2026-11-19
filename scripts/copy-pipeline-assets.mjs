import { cp, rm } from 'node:fs/promises';

// 无头安装只有三个后端包。打包角色、开书 skill 和内建插件，无需在发布目录寻找仓库源码。
const root = new URL('../', import.meta.url);
const out = new URL('packages/dsh-pipeline/dist/assets/', root);
await rm(out, { recursive: true, force: true });
for (const [source, dest] of [
    ['presets/dsh-preset-narrateos/roles', 'roles'],
    ['presets/dsh-preset-narrateos/skills', 'skills'],
    ['plugins/craft', 'plugins/craft']
]) {
    await cp(new URL(source, root), new URL(dest, out), { recursive: true });
}
