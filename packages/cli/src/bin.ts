#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCli } from './cli.js';

// 自动加载当前目录或上层工作区的 .env（不覆盖外部已注入的环境变量）
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(candidate);
        break;
    }
}

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
