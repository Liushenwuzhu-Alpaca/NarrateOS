import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillRegistry } from '@deepseek-ai/dsh-skill';
import { parse as parseYaml } from 'yaml';

interface ParsedSkillFrontmatter {
    name?: unknown;
    description?: unknown;
    whenToUse?: unknown;
}

function splitSkillMarkdown(raw: string): {
    frontmatter: ParsedSkillFrontmatter;
    body: string;
} {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
    if (!match?.[1] || match[2] === undefined) {
        return { frontmatter: {}, body: raw };
    }
    const parsed = parseYaml(match[1]) as ParsedSkillFrontmatter | null;
    return {
        frontmatter: parsed && typeof parsed === 'object' ? parsed : {},
        body: match[2].trim()
    };
}

/**
 * 动态向 @deepseek-ai/dsh-skill 注册预设包中的 narrate-boot Skill：
 * - 若注册表中已存在同名更高优先级 Skill，仅返回幂等清理函数（不覆盖）；
 * - 否则以 resourceBase 指向 <presetRoot>/skills/narrate-boot 注册，保留 references/ 可读能力。
 */
export async function registerPresetBootSkill(
    skills: Pick<SkillRegistry, 'get' | 'register'>,
    presetRoot: string
): Promise<() => void> {
    const skillDir = join(presetRoot, 'skills/narrate-boot');
    const skillMdPath = join(skillDir, 'SKILL.md');

    let raw: string;
    try {
        raw = await readFile(skillMdPath, 'utf8');
    } catch {
        return () => {};
    }

    const existing = await skills.get('narrate-boot');
    if (existing) {
        return () => {};
    }

    const { frontmatter, body } = splitSkillMarkdown(raw);
    const name =
        typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
            ? frontmatter.name.trim()
            : 'narrate-boot';
    const description =
        typeof frontmatter.description === 'string' && frontmatter.description.trim().length > 0
            ? frontmatter.description.trim()
            : 'NarrateOS 开书构思与重大改纲指南';
    const whenToUse =
        typeof frontmatter.whenToUse === 'string' && frontmatter.whenToUse.trim().length > 0
            ? frontmatter.whenToUse.trim()
            : undefined;

    return skills.register({
        path: skillMdPath,
        name,
        description,
        ...(whenToUse ? { whenToUse } : {}),
        content: body,
        source: 'bundled',
        provider: 'narrateos-pipeline',
        invocation: {
            modelInvocable: true,
            userInvocable: true
        },
        resourceBase: {
            kind: 'directory',
            path: skillDir
        }
    });
}
