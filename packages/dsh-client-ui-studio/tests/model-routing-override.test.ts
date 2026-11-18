// @vitest-environment jsdom
/**
 * 分角色两层模型覆盖 (Subagent 2-Layer Override) 前端测试：
 * 1. api.saveModelRouting -> PUT /api/narrate/model-routing 请求与异常契约
 * 2. api.harvestVoice -> POST /api/narrate/voice-harvest 请求契约
 * 3. RoleRoutingEditor 分角色模型覆盖卡片渲染、Layer 1 档位选择、Layer 2 模型与 datalist、
 *    reasoning_effort 下拉、生效模型展示、busy/提交中禁用、成功与失败提示。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    NarrateApiError,
    harvestVoice,
    saveModelRouting
} from '../src/client/api.js';
import {
    RoleRoutingEditor,
    normalizeRoleRoutingMap,
    type RoleRoutingEditorProps
} from '../src/client/RoleRoutingEditor.js';
import type {
    AvailableModelItem,
    RoleDefinitionItem,
    RoleModelOverride,
    RoleReasoningEffort,
    SaveModelRoutingRequest
} from '../src/client/types.js';

const SAMPLE_ROLE_DEFINITIONS: RoleDefinitionItem[] = [
    {
        id: 'librarian',
        defaultPool: 'fast_retrieval',
        defaultReasoningEffort: 'low',
        effectivePool: 'fast_retrieval',
        effectiveProvider: 'deepseek',
        effectiveModel: 'deepseek-chat',
        effectiveReasoningEffort: 'low'
    },
    {
        id: 'writer',
        defaultPool: 'strong_creative',
        defaultReasoningEffort: 'medium',
        effectivePool: 'strong_creative',
        effectiveProvider: 'anthropic',
        effectiveModel: 'claude-sonnet-4-5',
        effectiveReasoningEffort: 'medium'
    },
    {
        id: 'patch',
        defaultPool: 'strong_creative',
        defaultReasoningEffort: 'low',
        effectivePool: 'strong_creative',
        effectiveProvider: 'anthropic',
        effectiveModel: 'claude-sonnet-4-5',
        effectiveReasoningEffort: 'low'
    },
    {
        id: 'fact-checker',
        defaultPool: 'strong_creative',
        defaultReasoningEffort: 'medium',
        effectivePool: 'strong_creative',
        effectiveProvider: 'anthropic',
        effectiveModel: 'claude-sonnet-4-5',
        effectiveReasoningEffort: 'medium'
    }
];

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

function baseProps(overrides?: Partial<RoleRoutingEditorProps>): RoleRoutingEditorProps {
    return {
        resetKey: '/books/alpha',
        defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
        poolRoutes: {
            strong_creative: 'anthropic:claude-sonnet-4-5',
            fast_retrieval: 'deepseek:deepseek-chat'
        },
        roleDefinitions: SAMPLE_ROLE_DEFINITIONS,
        ...overrides
    };
}

function mountEditor(props: RoleRoutingEditorProps): {
    container: HTMLElement;
    rerender: (nextProps: RoleRoutingEditorProps) => void;
} {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(createElement(RoleRoutingEditor, props));
    });
    return {
        container,
        rerender: (nextProps: RoleRoutingEditorProps) => {
            act(() => {
                root.render(createElement(RoleRoutingEditor, nextProps));
            });
        }
    };
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
    act(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
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

describe('harvestVoice API 客户端', () => {
    it('向 POST /api/narrate/voice-harvest 发送可选 chapterNumber 并解析响应', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () =>
                JSON.stringify({
                    harvestedCount: 2,
                    skipped: false,
                    samples: [
                        { id: 'v1', tag: '冷峻克制', text: '把门关上。' },
                        { id: 'v2', tag: '低声试探', text: '你刚才在看什么？' }
                    ]
                })
        }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await harvestVoice(3);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('/api/narrate/voice-harvest');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ chapterNumber: 3 });
        expect(res.harvestedCount).toBe(2);
        expect(res.skipped).toBe(false);
        expect(res.samples).toHaveLength(2);
    });
});

describe('RoleRoutingEditor 分角色两层模型覆盖面板', () => {
    it('roleDefinitions 为空且无既有 roleRouting 时显示占位提示；有既有键时仅基于既有键生成最小行', () => {
        const { container: emptyContainer } = mountEditor(
            baseProps({ roleDefinitions: null, roleRouting: null })
        );
        expect(emptyContainer.textContent).toContain('全局强弱基础模型底座');
        expect(emptyContainer.textContent).toContain('按 Agent 单独指定');
        expect(emptyContainer.textContent).toContain('等待服务端下发工种配置 (roleDefinitions)...');
        expect(emptyContainer.querySelectorAll('[data-role-id]')).toHaveLength(0);

        const emptySaveBtn = Array.from(emptyContainer.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('保存工种模型配置')
        )!;
        expect(emptySaveBtn.disabled).toBe(true);

        const { container: fallbackContainer } = mountEditor(
            baseProps({
                roleDefinitions: [],
                roleRouting: { writer: { tier: 'weak' } }
            })
        );
        const rows = Array.from(fallbackContainer.querySelectorAll<HTMLElement>('[data-role-id]'));
        expect(rows.map((el) => el.getAttribute('data-role-id'))).toEqual(['writer']);
        expect(rows[0]?.textContent).toContain('--');
        expect(rows[0]?.textContent).toContain('deepseek:deepseek-chat');
    });

    it('完全由后端 roleDefinitions 驱动渲染，并正确展示“继承默认”文案与候选模型', () => {
        const roleDefinitions: RoleDefinitionItem[] = [
            {
                id: 'librarian',
                defaultPool: 'fast_retrieval',
                defaultReasoningEffort: 'low',
                effectiveTier: 'strong',
                effectivePool: 'strong_creative',
                effectiveProvider: 'anthropic',
                effectiveModel: 'claude-sonnet-4-5',
                effectiveReasoningEffort: 'low'
            },
            {
                id: 'writer',
                defaultPool: 'strong_creative',
                defaultReasoningEffort: 'medium',
                effectiveTier: null,
                effectivePool: 'strong_creative',
                effectiveProvider: 'openai',
                effectiveModel: 'gpt-4.1',
                effectiveReasoningEffort: 'high'
            }
        ];
        const availableModels: AvailableModelItem[] = [
            { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
            { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' }
        ];

        const { container: customContainer } = mountEditor(
            baseProps({
                roleDefinitions,
                availableModels,
                roleRouting: {
                    librarian: { tier: 'strong' },
                    writer: { model: 'openai:gpt-4.1', reasoning_effort: 'high' }
                }
            })
        );

        expect(
            Array.from(customContainer.querySelectorAll('[data-role-id]')).map((el) =>
                el.getAttribute('data-role-id')
            )
        ).toEqual(['librarian', 'writer']);

        const writerRow = customContainer.querySelector<HTMLElement>('[data-role-id="writer"]');
        expect(writerRow?.textContent).toContain('openai:gpt-4.1 (high)');

        const tierDefaultOpt = customContainer.querySelector<HTMLOptionElement>(
            'select[aria-label="writer 档位覆盖"] option[value=""]'
        );
        const effortDefaultOpt = customContainer.querySelector<HTMLOptionElement>(
            'select[aria-label="writer 推理强度"] option[value=""]'
        );
        expect(tierDefaultOpt?.textContent).toBe('继承默认');
        expect(effortDefaultOpt?.textContent).toBe('继承默认');

        const writerModelSelect = customContainer.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 指定模型"]'
        );
        expect(writerModelSelect).not.toBeNull();
        expect(writerModelSelect?.value).toBe('openai:gpt-4.1');
        const options = Array.from(writerModelSelect?.options ?? []).map((opt) => ({
            value: opt.value,
            text: opt.textContent
        }));
        expect(options).toEqual([
            { value: '', text: '继承第一层底座' },
            { value: 'anthropic:claude-sonnet-4-5', text: 'Claude Sonnet 4.5 (anthropic:claude-sonnet-4-5)' },
            { value: 'openai:gpt-4.1', text: 'GPT-4.1 (openai:gpt-4.1)' }
        ]);
    });

    it('支持选择 Layer 1 强/弱档位、Layer 2 指定模型下拉与 reasoning_effort 并提交保存', async () => {
        const onSave = vi.fn(async (_payload: SaveModelRoutingRequest) => undefined);
        const { container } = mountEditor(
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
        const writerModel = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 指定模型"]'
        )!;
        const writerEffort = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 推理强度"]'
        )!;
        const patchTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="patch 档位覆盖"]'
        )!;

        setSelectValue(librarianTier, 'strong');
        setSelectValue(writerModel, 'deepseek:deepseek-reasoner');
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

    it('Layer 2 选回继承第一层底座时继承 Layer 1；重置 reasoning_effort 回退到 defaultReasoningEffort 且不残留旧 effectiveReasoningEffort', async () => {
        const onSave = vi.fn(async (_payload: SaveModelRoutingRequest) => undefined);
        const { container } = mountEditor(
            baseProps({
                roleDefinitions: [
                    {
                        id: 'writer',
                        defaultPool: 'strong_creative',
                        defaultReasoningEffort: 'medium',
                        effectiveTier: 'weak',
                        effectivePool: 'fast_retrieval',
                        effectiveProvider: 'openai',
                        effectiveModel: 'gpt-4.1',
                        effectiveReasoningEffort: 'high'
                    }
                ],
                roleRouting: {
                    writer: { tier: 'weak', model: 'openai:gpt-4.1', reasoning_effort: 'high' }
                },
                onSaveModelRouting: onSave
            })
        );

        const writerRow = container.querySelector<HTMLElement>('[data-role-id="writer"]');
        expect(writerRow?.textContent).toContain('openai:gpt-4.1 (high)');

        const writerModel = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 指定模型"]'
        )!;
        // 当前值不在 availableModels 时仍保留为选项
        expect(writerModel.value).toBe('openai:gpt-4.1');
        const writerEffort = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 推理强度"]'
        )!;
        setSelectValue(writerModel, '');
        setSelectValue(writerEffort, '');

        // Layer 2 选回继承后继承 Layer 1 (weak -> fast_retrieval)，reasoning_effort 回退到 defaultReasoningEffort (medium)
        expect(writerRow?.textContent).toContain('deepseek:deepseek-chat (medium)');
        expect(writerRow?.textContent).not.toContain('(high)');

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

    it('poolRoutes 仅含裸模型名时，跨 tier 切换依据对应池已知 effectiveProvider 推导而非借用本工种 provider', () => {
        const { container } = mountEditor(
            baseProps({
                poolRoutes: {
                    strong_creative: 'claude-sonnet-4-5',
                    fast_retrieval: 'deepseek-chat'
                },
                availableModels: [{ provider: '', model: 'claude-opus-4' }],
                roleDefinitions: SAMPLE_ROLE_DEFINITIONS
            })
        );

        const librarianTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="librarian 档位覆盖"]'
        )!;
        const librarianModel = container.querySelector<HTMLSelectElement>(
            'select[aria-label="librarian 指定模型"]'
        )!;

        setSelectValue(librarianTier, 'strong');
        const librarianRow = container.querySelector<HTMLElement>('[data-role-id="librarian"]');
        expect(librarianRow?.textContent).toContain('anthropic:claude-sonnet-4-5');
        expect(librarianRow?.textContent).not.toContain('deepseek:claude-sonnet-4-5');

        setSelectValue(librarianModel, 'claude-opus-4');
        expect(librarianRow?.textContent).toContain('anthropic:claude-opus-4');
        expect(librarianRow?.textContent).not.toContain('deepseek:claude-opus-4');
    });

    it('切换 resetKey 时即使两书同为 roleRouting: {} 也重置未保存草稿与提示状态', async () => {
        const onSave = vi.fn(async (_payload: SaveModelRoutingRequest) => undefined);
        const propsA = baseProps({
            resetKey: '/books/a',
            roleRouting: {},
            onSaveModelRouting: onSave
        });
        const { container, rerender } = mountEditor(propsA);

        const writerTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 档位覆盖"]'
        )!;
        setSelectValue(writerTier, 'weak');
        expect(writerTier.value).toBe('weak');

        rerender(
            baseProps({
                resetKey: '/books/b',
                roleRouting: {},
                onSaveModelRouting: onSave
            })
        );

        const nextWriterTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 档位覆盖"]'
        )!;
        expect(nextWriterTier.value).toBe('');
    });

    it('normalizeRoleRoutingMap 校验并剔除非法 reasoning_effort', () => {
        const raw = {
            writer: {
                tier: 'strong',
                model: '  openai:gpt-4.1  ',
                reasoning_effort: 'turbo' as unknown as RoleReasoningEffort
            },
            librarian: {
                reasoning_effort: 'invalid_level' as unknown as RoleReasoningEffort
            },
            patch: {
                reasoning_effort: 'high'
            }
        } satisfies Record<string, RoleModelOverride>;

        expect(normalizeRoleRoutingMap(raw, true)).toEqual({
            writer: { tier: 'strong', model: 'openai:gpt-4.1' },
            patch: { reasoning_effort: 'high' }
        });
    });

    it('busy 为 true 或保存请求在途时禁用保存按钮，保存失败展示错误提示', async () => {
        const { container: busyContainer } = mountEditor(
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
        const { container } = mountEditor(
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

    it('第一层仅保留强/快双池原生 <select> 下拉框（首项跟随 DSH 本体默认），实时联动生效模型并提交保存', async () => {
        const onSave = vi.fn(async (_payload: SaveModelRoutingRequest) => undefined);
        const { container } = mountEditor(
            baseProps({
                defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
                poolOverrides: {},
                poolRoutes: {
                    strong_creative: 'deepseek-official:deepseek-flash',
                    fast_retrieval: 'deepseek-official:deepseek-flash'
                },
                availableModels: [
                    { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek R1' },
                    { provider: 'openai', model: 'gpt-5.4-high', label: 'GPT-5.4' }
                ],
                onSaveModelRouting: onSave
            })
        );

        const strongSelect = container.querySelector<HTMLSelectElement>('select[aria-label="强模型池"]');
        const fastSelect = container.querySelector<HTMLSelectElement>('select[aria-label="快模型池"]');
        const auditSelect = container.querySelector('[aria-label="独立挑错池"]');
        expect(strongSelect).not.toBeNull();
        expect(fastSelect).not.toBeNull();
        expect(auditSelect).toBeNull();
        expect(container.textContent).not.toContain('独立挑错池');

        expect(strongSelect?.options[0]?.value).toBe('');
        expect(strongSelect?.options[0]?.textContent).toBe('跟随 DSH 本体默认（deepseek-official:deepseek-flash）');
        expect(strongSelect?.value).toBe('');

        const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('保存工种模型配置')
        )!;
        // 唯一实心主按钮规则：!isDirty 时使用描边次级态，不使用主色实心填充
        expect(saveBtn.className).not.toContain('ns-btn-primary');
        expect(saveBtn.className).toContain('ns-btn-ghost');

        setSelectValue(strongSelect!, 'deepseek:deepseek-reasoner');
        setSelectValue(fastSelect!, 'openai:gpt-5.4-high');

        // 修改后点亮主色实心按钮
        expect(saveBtn.className).toContain('ns-btn-primary');

        // 实时联动 Layer 2 展示生效模型（fact-checker 归属强模型池）
        const writerRow = container.querySelector<HTMLElement>('[data-role-id="writer"]');
        expect(writerRow?.textContent).toContain('deepseek:deepseek-reasoner');
        const checkerRow = container.querySelector<HTMLElement>('[data-role-id="fact-checker"]');
        expect(checkerRow?.textContent).toContain('Checker');
        expect(checkerRow?.textContent).not.toContain('Fact Checker');
        expect(checkerRow?.textContent).toContain('deepseek:deepseek-reasoner');
        const librarianRow = container.querySelector<HTMLElement>('[data-role-id="librarian"]');
        expect(librarianRow?.textContent).toContain('openai:gpt-5.4-high');

        await act(async () => {
            saveBtn.click();
        });

        expect(onSave).toHaveBeenCalledExactlyOnceWith({
            model_routing: {
                strong_creative: 'deepseek:deepseek-reasoner',
                fast_retrieval: 'openai:gpt-5.4-high'
            },
            role_routing: {}
        });
    });

    it('第二层手风琴支持 fact_checker -> Checker 映射（归属强模型池）、覆盖项主色高亮与展开收起', async () => {
        const { container } = mountEditor(
            baseProps({
                roleDefinitions: [
                    {
                        id: 'fact_checker',
                        defaultPool: 'strong_creative',
                        defaultReasoningEffort: 'medium',
                        effectivePool: 'strong_creative',
                        effectiveProvider: 'openai',
                        effectiveModel: 'gpt-4.1',
                        effectiveReasoningEffort: 'high'
                    },
                    {
                        id: 'writer',
                        defaultPool: 'strong_creative',
                        defaultReasoningEffort: 'medium',
                        effectivePool: 'strong_creative',
                        effectiveProvider: 'anthropic',
                        effectiveModel: 'claude-sonnet-4-5',
                        effectiveReasoningEffort: 'medium'
                    }
                ],
                roleRouting: {
                    fact_checker: { model: 'anthropic:claude-opus-4-6', reasoning_effort: 'high' }
                }
            })
        );

        const checkerRow = container.querySelector<HTMLElement>('[data-role-id="fact_checker"]');
        expect(checkerRow).not.toBeNull();
        expect(checkerRow?.textContent).toContain('Checker');
        expect(checkerRow?.textContent).not.toContain('fact_checker');
        expect(checkerRow?.getAttribute('data-role-overridden')).toBe('true');

        const writerRow = container.querySelector<HTMLElement>('[data-role-id="writer"]');
        expect(writerRow?.getAttribute('data-role-overridden')).not.toBe('true');

        const checkerSummary = checkerRow?.querySelector<HTMLButtonElement>('button[aria-expanded]');
        expect(checkerSummary).not.toBeNull();
        expect(checkerSummary?.getAttribute('aria-expanded')).toBe('false');
        act(() => {
            checkerSummary!.click();
        });
        expect(checkerSummary?.getAttribute('aria-expanded')).toBe('true');
    });
});
