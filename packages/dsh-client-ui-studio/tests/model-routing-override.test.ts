// @vitest-environment jsdom
/**
 * 分角色两层模型覆盖 (Subagent 2-Layer Override) 前端测试：
 * 1. api.saveModelRouting -> PUT /api/narrate/model-routing 请求与异常契约
 * 2. RightOpsInspector 分角色模型覆盖卡片渲染、Layer 1 档位选择、Layer 2 模型与 datalist、
 *    reasoning_effort 下拉、生效模型展示、busy/提交中禁用、成功与失败提示。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NarrateApiError, saveModelRouting } from '../src/client/api.js';
import {
    RightOpsInspector,
    type RightOpsInspectorProps
} from '../src/client/RightOpsInspector.js';
import type {
    AvailableModelItem,
    RoleDefinitionItem,
    SaveModelRoutingRequest
} from '../src/client/types.js';

const CANONICAL_ROLES = [
    'librarian',
    'planner',
    'writer',
    'patch',
    'fact-checker',
    'extractor',
    'dreamer',
    'boot-compiler'
] as const;

const globalState = globalThis as Record<string, unknown>;
let hadReactActEnv = false;
let prevReactActEnv: unknown;

beforeAll(() => {
    hadReactActEnv = Object.hasOwn(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    prevReactActEnv = globalState['IS_REACT_ACT_ENVIRONMENT'];
    globalState['IS_REACT_ACT_ENVIRONMENT'] = true;
});

afterAll(() => {
    if (hadReactActEnv) {
        globalState['IS_REACT_ACT_ENVIRONMENT'] = prevReactActEnv;
    } else {
        delete globalState['IS_REACT_ACT_ENVIRONMENT'];
    }
});

const mountedRoots: Root[] = [];

afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function baseProps(overrides?: Partial<RightOpsInspectorProps>): RightOpsInspectorProps {
    return {
        walLock: {
            walPhase: 'STATE_COMMITTED',
            timelineMode: 'MAINLINE',
            txLockStatus: 'free',
            lastCommittedChapter: 3
        },
        modelPool: {
            fastModel: 'deepseek:deepseek-chat',
            strongModel: 'anthropic:claude-sonnet-4-5',
            auditModel: 'openai:gpt-4.1',
            inputTokens: 100,
            cacheReadTokens: 300
        },
        stageArtifact: {
            selectedStageIndex: 0,
            stageName: '规划',
            stageStatus: '就绪',
            stageSummary: '阶段摘要'
        },
        proseGate: {
            mattr500: null,
            kontoyiannisEntropy: null,
            sentenceLengthCv: null,
            clicheDensityPer1k: null,
            recentViolations: []
        },
        factChecker: { totalChecked: 0, verifiedPassCount: 0, filteredOutCount: 0 },
        dreaming: {
            dirtyEntityCount: null,
            dirtyThreshold: null,
            coldArchiveCount: 0,
            spotlightQueue: null
        },
        volumeProgress: null,
        ...overrides
    };
}

function mountInspector(props: RightOpsInspectorProps): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(createElement(RightOpsInspector, props));
    });
    return container;
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
    act(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('jsdom 缺少 input value setter');
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

describe('saveModelRouting API 客户端', () => {
    it('向 PUT /api/narrate/model-routing 发送 JSON 载荷并解析 200 响应', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () =>
                JSON.stringify({
                    status: 'ok',
                    modelRouting: { strong_creative: 'anthropic:claude-sonnet-4-5' },
                    roleRouting: { writer: { tier: 'strong', model: 'openai:gpt-4.1', reasoning_effort: 'medium' } },
                    roleDefinitions: []
                })
        }));
        vi.stubGlobal('fetch', fetchMock);

        const req: SaveModelRoutingRequest = {
            role_routing: {
                writer: { tier: 'strong', model: 'openai:gpt-4.1', reasoning_effort: 'medium' }
            }
        };
        const res = await saveModelRouting(req);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('/api/narrate/model-routing');
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(String(init?.body))).toEqual(req);
        expect(res.status).toBe('ok');
        expect(res.roleRouting?.['writer']?.model).toBe('openai:gpt-4.1');
    });

    it('后端返回 409/400 时抛出携带状态码的 NarrateApiError', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 409,
            statusText: 'Conflict',
            text: async () => JSON.stringify({ error: '作品当前处于忙碌状态，无法修改模型配置' })
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(saveModelRouting({ role_routing: {} })).rejects.toMatchObject({
            name: 'NarrateApiError',
            status: 409,
            message: '作品当前处于忙碌状态，无法修改模型配置'
        } satisfies Partial<NarrateApiError>);
    });
});

describe('RightOpsInspector 分角色两层模型覆盖面板', () => {
    it('未传入 roleDefinitions 时仍展示全部 8 个标准工种，传入时优先展示后端 roleDefinitions 与生效模型', () => {
        const defaultContainer = mountInspector(baseProps());
        const cardText = defaultContainer.textContent ?? '';
        expect(cardText).toContain('分角色模型覆盖 (Subagent 2-Layer Override)');
        for (const roleId of CANONICAL_ROLES) {
            expect(defaultContainer.querySelector(`[data-role-id="${roleId}"]`)).not.toBeNull();
        }

        const roleDefinitions: RoleDefinitionItem[] = CANONICAL_ROLES.map((id) => ({
            id,
            defaultPool: id === 'fact-checker' ? 'audit' : id === 'librarian' || id === 'extractor' ? 'fast_retrieval' : 'strong_creative',
            defaultReasoningEffort: id === 'patch' ? 'low' : 'medium',
            effectiveTier: id === 'librarian' ? 'strong' : null,
            effectivePool: id === 'librarian' ? 'strong_creative' : 'fast_retrieval',
            effectiveProvider: id === 'writer' ? 'openai' : 'anthropic',
            effectiveModel: id === 'writer' ? 'gpt-4.1' : 'claude-sonnet-4-5',
            effectiveReasoningEffort: id === 'writer' ? 'high' : 'medium'
        }));
        const availableModels: AvailableModelItem[] = [
            { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
            { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' }
        ];

        const customContainer = mountInspector(
            baseProps({
                roleDefinitions,
                availableModels,
                roleRouting: {
                    librarian: { tier: 'strong' },
                    writer: { model: 'openai:gpt-4.1', reasoning_effort: 'high' }
                }
            })
        );

        const writerRow = customContainer.querySelector<HTMLElement>('[data-role-id="writer"]');
        expect(writerRow?.textContent).toContain('openai:gpt-4.1');
        const writerModelInput = customContainer.querySelector<HTMLInputElement>(
            'input[aria-label="writer 指定模型"]'
        );
        expect(writerModelInput?.value).toBe('openai:gpt-4.1');
        const listId = writerModelInput?.getAttribute('list');
        expect(listId).toBeTruthy();
        const options = Array.from(
            customContainer.querySelectorAll<HTMLOptionElement>(`#${listId} option`)
        ).map((opt) => opt.value);
        expect(options).toEqual(['anthropic:claude-sonnet-4-5', 'openai:gpt-4.1']);
    });

    it('支持选择 Layer 1 强/弱档位、填写 Layer 2 具体模型与 reasoning_effort 并提交保存', async () => {
        const onSave = vi.fn(async (_payload: SaveModelRoutingRequest) => undefined);
        const container = mountInspector(
            baseProps({
                availableModels: [
                    { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek R1' }
                ],
                onSaveModelRouting: onSave
            })
        );

        const librarianTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="librarian 档位覆盖"]'
        )!;
        const writerModel = container.querySelector<HTMLInputElement>(
            'input[aria-label="writer 指定模型"]'
        )!;
        const writerEffort = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 推理强度"]'
        )!;
        const patchTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="patch 档位覆盖"]'
        )!;

        setSelectValue(librarianTier, 'strong');
        setInputValue(writerModel, 'deepseek:deepseek-reasoner');
        setSelectValue(writerEffort, 'low');
        setSelectValue(patchTier, 'weak');

        const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('保存工种模型配置')
        );
        expect(saveBtn).toBeDefined();
        expect(saveBtn?.disabled).toBe(false);

        await act(async () => {
            saveBtn!.click();
        });

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith({
            role_routing: {
                librarian: { tier: 'strong' },
                writer: { model: 'deepseek:deepseek-reasoner', reasoning_effort: 'low' },
                patch: { tier: 'weak' }
            }
        });
        expect(container.textContent).toContain('工种模型配置已保存');
    });

    it('Layer 2 留空时继承 Layer 1 并在保存载荷中剥离空字段', async () => {
        const onSave = vi.fn(async (_payload: SaveModelRoutingRequest) => undefined);
        const container = mountInspector(
            baseProps({
                roleRouting: {
                    writer: { tier: 'weak', model: 'openai:gpt-4.1', reasoning_effort: 'high' }
                },
                onSaveModelRouting: onSave
            })
        );

        const writerModel = container.querySelector<HTMLInputElement>(
            'input[aria-label="writer 指定模型"]'
        )!;
        const writerEffort = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 推理强度"]'
        )!;
        setInputValue(writerModel, '   ');
        setSelectValue(writerEffort, '');

        const writerRow = container.querySelector<HTMLElement>('[data-role-id="writer"]');
        // Layer 2 留空后继承 Layer 1 (weak -> fast_retrieval)
        expect(writerRow?.textContent).toContain('deepseek:deepseek-chat');

        const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('保存工种模型配置')
        )!;
        await act(async () => {
            saveBtn.click();
        });

        expect(onSave).toHaveBeenCalledWith({
            role_routing: {
                writer: { tier: 'weak' }
            }
        });
    });

    it('busy 为 true 或保存请求在途时禁用保存按钮，保存失败展示错误提示', async () => {
        const busyContainer = mountInspector(
            baseProps({
                busy: true,
                onSaveModelRouting: vi.fn()
            })
        );
        const busySaveBtn = Array.from(busyContainer.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('保存工种模型配置')
        )!;
        expect(busySaveBtn.disabled).toBe(true);

        const deferred = Promise.withResolvers<void>();
        const onSave = vi.fn(() => deferred.promise);
        const container = mountInspector(
            baseProps({
                busy: false,
                onSaveModelRouting: onSave
            })
        );
        const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('保存工种模型配置')
        )!;
        await act(async () => {
            saveBtn.click();
        });

        expect(saveBtn.disabled).toBe(true);
        expect(saveBtn.textContent).toContain('正在保存');

        await act(async () => {
            deferred.reject(new Error('HTTP 409 事务锁占用'));
            await deferred.promise.catch(() => undefined);
        });

        expect(saveBtn.disabled).toBe(false);
        expect(container.textContent).toContain('保存失败: HTTP 409 事务锁占用');
    });
});
