import { expect, it } from 'vitest';
import { hasChineseCharacter } from './schemas.js';

it('工具接受存储层允许的基本汉字区末端，但不接受相邻的非汉字', () => {
    expect(hasChineseCharacter('\u9fa6')).toBe(true);
    expect(hasChineseCharacter('\u9fff')).toBe(true);
    expect(hasChineseCharacter('\ua000')).toBe(false);
    expect(hasChineseCharacter('Alex')).toBe(false);
});
