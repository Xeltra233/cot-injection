import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    substituteParamsExtended,
    chat,
    updateMessageBlock,
    saveChatConditional,
} from '../../../../script.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';

export { MODULE_NAME };

const MODULE_NAME = 'cot-injection';
const SETTINGS_KEY = 'cot_injection';

const defaultSettings = {
    enabled: false,
    single_shot: false,
    api_format: 'auto', // 'auto' | 'openai' | 'gemini' | 'anthropic'
    thought_chain: '',
    next_prompt: '继续',
};

/**
 * 记录本次生成中实际注入的思维链信息，供完成时静默补充到当前轮使用
 */
let activeInjectionForCurrentGeneration = null;

/**
 * 使用酒馆宏引擎处理文本
 * @param {string} text 原始文本
 * @param {string} fallback 默认回退文本
 * @returns {string} 宏替换后的文本
 */
function processTextWithMacros(text, fallback = '') {
    const raw = (text !== undefined && text !== null && String(text).trim().length > 0) ? String(text) : fallback;
    if (!raw) return '';
    try {
        return substituteParamsExtended(raw);
    } catch (err) {
        console.warn('CoT Injection: Error in substituteParamsExtended, returning raw:', err);
        return raw;
    }
}

/**
 * 加载并迁移设置
 */
function loadSettings() {
    extension_settings[SETTINGS_KEY] = Object.assign({}, defaultSettings, extension_settings[SETTINGS_KEY] || {});

    const settings = extension_settings[SETTINGS_KEY];
    $('#cot_injection_enabled').prop('checked', !!settings.enabled);
    $('#cot_injection_single_shot').prop('checked', !!settings.single_shot);
    $('#cot_injection_api_format').val(settings.api_format || 'auto');
    $('#cot_injection_thought').val(settings.thought_chain || '');
    $('#cot_injection_next_prompt').val(settings.next_prompt || '');

    updateStatusBadge(settings.enabled);
    updateLivePreview();
}

/**
 * 更新状态徽章
 * @param {boolean} enabled 
 */
function updateStatusBadge(enabled) {
    const badge = $('#cot_injection_status_badge');
    if (enabled) {
        badge.removeClass('cot-badge-disabled').addClass('cot-badge-enabled').text('已启用');
    } else {
        badge.removeClass('cot-badge-enabled').addClass('cot-badge-disabled').text('已停用');
    }
}

/**
 * 更新选定协议格式下的实时请求预览
 */
function updateLivePreview() {
    const format = $('#cot_injection_api_format').val() || 'auto';
    const thought = $('#cot_injection_thought').val() || '';
    const nextPrompt = $('#cot_injection_next_prompt').val() || '';

    const processedThought = processTextWithMacros(thought, '（空思维链）');
    const processedNextPrompt = processTextWithMacros(nextPrompt, '继续');

    let previewData;

    if (format === 'gemini') {
        previewData = {
            protocol: 'Google Gemini (Native / REST)',
            contents: [
                { role: 'user', parts: [{ text: '<当前轮用户提问 / 历史上下文...>' }] },
                { role: 'model', parts: [{ text: processedThought }] },
                { role: 'user', parts: [{ text: processedNextPrompt }] }
            ],
            note: '模型将在 model 思维链末尾无缝续接，无须官方签名，彻底规避 400 报错'
        };
    } else if (format === 'anthropic') {
        previewData = {
            protocol: 'Anthropic Claude (Messages API)',
            messages: [
                { role: 'user', content: '<当前轮用户提问 / 历史上下文...>' },
                { role: 'assistant', content: processedThought },
                { role: 'user', content: processedNextPrompt }
            ],
            note: '标准 user-assistant-user 轮次交替接力'
        };
    } else {
        // openai 或 auto
        previewData = {
            protocol: format === 'auto' ? '自动识别适配 (Auto-adaptive: OpenAI / Gemini Compatible / Claude)' : 'OpenAI Compatible (Chat Completions)',
            messages: [
                { role: 'user', content: '<当前轮用户提问 / 历史上下文...>' },
                { role: 'assistant', content: processedThought },
                { role: 'user', content: processedNextPrompt }
            ],
            target_continuation: '⏩ [大模型紧接着上述思维链断点开始生成，结果静默补充到当前轮次]'
        };
    }

    $('#cot_injection_preview_content').text(JSON.stringify(previewData, null, 2));
}

/**
 * 保存当前表单文本设置
 * @param {boolean} [showToast=true] 
 */
function saveCurrentFormSettings(showToast = true) {
    extension_settings[SETTINGS_KEY] = extension_settings[SETTINGS_KEY] || {};
    const settings = extension_settings[SETTINGS_KEY];

    // 保存协议格式与文本配置
    settings.api_format = $('#cot_injection_api_format').val() || 'auto';
    settings.thought_chain = $('#cot_injection_thought').val();
    settings.next_prompt = $('#cot_injection_next_prompt').val();

    saveSettingsDebounced();
    updateLivePreview();

    if (showToast && window.toastr) {
        toastr.success('思维链与协议格式配置已保存', 'CoT Injection');
    }
}

/**
 * 核心请求拦截：在请求发送前静默构造思维链与下一轮触发词（根据协议自适应）
 * @param {{ chat: Array<{role: string, content?: any, parts?: any}>, dryRun: boolean }} eventData 
 */
async function onChatCompletionPromptReady(eventData) {
    const settings = extension_settings[SETTINGS_KEY];
    if (!settings || !settings.enabled) {
        return;
    }

    const rawThought = (settings.thought_chain || '').trim();
    if (!rawThought) {
        console.debug('CoT Injection: 插件已启用但思维链为空，跳过注入。');
        return;
    }

    const chatArray = eventData.chat;
    if (!Array.isArray(chatArray) || chatArray.length === 0) {
        return;
    }

    // 宏与预设处理
    const processedThought = processTextWithMacros(rawThought);
    const rawNextPrompt = settings.next_prompt || '';
    const processedNextPrompt = processTextWithMacros(rawNextPrompt, '继续');

    const format = settings.api_format || 'auto';

    // 记录本次注入状态
    activeInjectionForCurrentGeneration = {
        thought: processedThought,
        nextPrompt: processedNextPrompt,
        single_shot: !!settings.single_shot,
    };

    console.info(`CoT Injection [${format}]: 静默构造思维链与下一轮触发词`, {
        format,
        thoughtLength: processedThought.length,
        nextPrompt: processedNextPrompt,
        dryRun: eventData.dryRun,
    });

    const lastMessage = chatArray[chatArray.length - 1];

    // 判断目标协议与数据结构
    const hasParts = Array.isArray(lastMessage?.parts) || (format === 'gemini' && lastMessage?.parts);
    const isGeminiRole = format === 'gemini' || (format === 'auto' && chatArray.some(m => m.role === 'model'));
    const assistantRole = isGeminiRole ? 'model' : 'assistant';
    const userRole = 'user';

    // 1. Gemini 原生 parts 结构
    if (hasParts) {
        if (lastMessage && (lastMessage.role === 'model' || lastMessage.role === 'assistant')) {
            if (Array.isArray(lastMessage.parts)) {
                lastMessage.parts.push({ text: processedThought });
            } else {
                lastMessage.parts = [{ text: processedThought }];
            }
            chatArray.push({
                role: userRole,
                parts: [{ text: processedNextPrompt }],
            });
        } else {
            chatArray.push({
                role: assistantRole,
                parts: [{ text: processedThought }],
            });
            chatArray.push({
                role: userRole,
                parts: [{ text: processedNextPrompt }],
            });
        }
    }
    // 2. Claude/Anthropic 或标准 Content 结构
    else {
        if (lastMessage && (lastMessage.role === 'assistant' || lastMessage.role === 'model')) {
            // 已有尾部 assistant/model 消息时追加
            if (typeof lastMessage.content === 'string') {
                lastMessage.content = (lastMessage.content ? lastMessage.content + '\n\n' : '') + processedThought;
            } else if (Array.isArray(lastMessage.content)) {
                lastMessage.content.push({ type: 'text', text: processedThought });
            } else {
                lastMessage.content = processedThought;
            }
            chatArray.push({
                role: userRole,
                content: processedNextPrompt,
            });
        } else {
            // 标准轮次交替注入：追加 assistant/model 思维链 -> 追加 user 续接词
            chatArray.push({
                role: assistantRole,
                content: processedThought,
            });
            chatArray.push({
                role: userRole,
                content: processedNextPrompt,
            });
        }
    }
}

/**
 * 响应完成时：将思维链标准补充到当前轮次的 extra.reasoning 中（静默处理，不生成多余对话卡片）
 * @param {number} messageId 
 * @param {string} type 
 */
async function onMessageReceived(messageId, type) {
    if (!activeInjectionForCurrentGeneration) return;

    const injection = activeInjectionForCurrentGeneration;
    const messageIndex = typeof messageId === 'number' ? messageId : chat.length - 1;
    const targetMessage = chat[messageIndex];

    if (targetMessage && !targetMessage.is_user && !targetMessage.is_system) {
        if (!targetMessage.extra) targetMessage.extra = {};
        targetMessage.extra.reasoning = injection.thought;
        targetMessage.extra.reasoning_type = 'parsed';
        await saveChatConditional();
        updateMessageBlock(messageIndex, targetMessage);
    }

    if (injection.single_shot) {
        extension_settings[SETTINGS_KEY].enabled = false;
        $('#cot_injection_enabled').prop('checked', false);
        updateStatusBadge(false);
        saveSettingsDebounced();
        if (window.toastr) {
            toastr.info('思维链注入已完成单次执行并自动关闭', 'CoT Injection');
        }
    }

    activeInjectionForCurrentGeneration = null;
}

/**
 * 绑定所有 UI 交互事件
 */
function setupListeners() {
    // 主开关（点击立即实时生效，无需点击保存）
    $('#cot_injection_enabled').off('change').on('change', function () {
        const enabled = $(this).prop('checked');
        extension_settings[SETTINGS_KEY].enabled = enabled;
        updateStatusBadge(enabled);
        saveSettingsDebounced();
        if (window.toastr) {
            if (enabled) {
                toastr.success('思维链注入已启用 (实时生效)', 'CoT Injection');
            } else {
                toastr.info('思维链注入已停用 (实时生效)', 'CoT Injection');
            }
        }
    });

    // 单次模式（点击立即实时生效，无需点击保存）
    $('#cot_injection_single_shot').off('change').on('change', function () {
        const singleShot = $(this).prop('checked');
        extension_settings[SETTINGS_KEY].single_shot = singleShot;
        saveSettingsDebounced();
        if (window.toastr) {
            toastr.info(`单次生效模式已${singleShot ? '开启' : '关闭'} (实时生效)`, 'CoT Injection');
        }
    });

    // API 协议格式选择切换
    $('#cot_injection_api_format').off('change').on('change', function () {
        extension_settings[SETTINGS_KEY].api_format = $(this).val();
        saveSettingsDebounced();
        updateLivePreview();
    });

    // 思维链输入框（自动同步数据与预览）
    $('#cot_injection_thought').off('input').on('input', function () {
        extension_settings[SETTINGS_KEY].thought_chain = $(this).val();
        saveSettingsDebounced();
        updateLivePreview();
    });

    // 下一轮提示词输入框（自动同步数据与预览）
    $('#cot_injection_next_prompt').off('input').on('input', function () {
        extension_settings[SETTINGS_KEY].next_prompt = $(this).val();
        saveSettingsDebounced();
        updateLivePreview();
    });

    // 保存按钮（显式持久化当前文本配置）
    $('#cot_save_settings_btn').off('click').on('click', function () {
        saveCurrentFormSettings(true);
    });

    // 清空思维链按钮
    $('#cot_clear_thought_btn').off('click').on('click', function () {
        $('#cot_injection_thought').val('');
        extension_settings[SETTINGS_KEY].thought_chain = '';
        saveSettingsDebounced();
        updateLivePreview();
        if (window.toastr) {
            toastr.info('思维链已清空', 'CoT Injection');
        }
    });

    // 刷新预览按钮
    $('#cot_refresh_preview_btn').off('click').on('click', function () {
        updateLivePreview();
        if (window.toastr) {
            toastr.info('已刷新宏替换预览', 'CoT Injection');
        }
    });
}

/**
 * 注册 Slash 命令
 */
function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cot-inject',
        callback: (args, value) => {
            const settings = extension_settings[SETTINGS_KEY];
            const action = (args.action || value || '').toLowerCase().trim();

            if (action === 'on' || action === 'enable' || action === 'true') {
                settings.enabled = true;
                $('#cot_injection_enabled').prop('checked', true);
                updateStatusBadge(true);
                saveSettingsDebounced();
                return 'CoT Injection 已启用';
            }

            if (action === 'off' || action === 'disable' || action === 'false') {
                settings.enabled = false;
                $('#cot_injection_enabled').prop('checked', false);
                updateStatusBadge(false);
                saveSettingsDebounced();
                return 'CoT Injection 已停用';
            }

            if (action === 'toggle') {
                settings.enabled = !settings.enabled;
                $('#cot_injection_enabled').prop('checked', settings.enabled);
                updateStatusBadge(settings.enabled);
                saveSettingsDebounced();
                return `CoT Injection 当前状态: ${settings.enabled ? '已启用' : '已停用'}`;
            }

            if (action === 'status') {
                return `CoT Injection 状态: ${settings.enabled ? '已启用' : '已停用'} | 协议格式: ${settings.api_format || 'auto'} | 单次模式: ${settings.single_shot ? '开' : '关'}`;
            }

            return '用法: /cot-inject action=(on|off|toggle|status)';
        },
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'action',
                '执行的操作 (on, off, toggle, status)',
                [ARGUMENT_TYPE.STRING],
                false,
                false,
                'toggle',
                ['on', 'off', 'toggle', 'status']
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('action', [ARGUMENT_TYPE.STRING], false, false, 'toggle'),
        ],
        helpString: '控制思维链注入与逻辑断点续接插件的开启、关闭与状态查询。',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

/**
 * 扩展激活初始化入口
 */
export async function init() {
    console.info('CoT Injection: 正在初始化思维链注入扩展...');

    try {
        const isThirdParty = import.meta.url.includes('third-party');
        const extName = isThirdParty ? `third-party/${MODULE_NAME}` : MODULE_NAME;
        let settingsHtml;
        try {
            settingsHtml = await renderExtensionTemplateAsync(extName, 'settings');
        } catch (templateErr) {
            console.warn('CoT Injection: 尝试加载 ' + extName + ' 模板失败，回退尝试:', templateErr);
            settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
        }
        if (!settingsHtml && isThirdParty) {
            settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
        }

        // 查找或创建容器
        let container = $('#cot_injection_container');
        if (container.length === 0) {
            container = $('<div id="cot_injection_container" class="extension_container"></div>');
            if ($('#extensions_settings2').length > 0) {
                $('#extensions_settings2').append(container);
            } else if ($('#extensions_settings').length > 0) {
                $('#extensions_settings').append(container);
            } else {
                $('body').append(container);
            }
        }

        container.empty().append(settingsHtml);
        setupListeners();
        loadSettings();
    } catch (err) {
        console.error('CoT Injection: 渲染设置面板失败:', err);
    }

    // 监听酒馆核心事件
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.SETTINGS_LOADED, loadSettings);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateLivePreview();
    });

    // 注册斜杠命令
    registerSlashCommands();

    console.info('CoT Injection: 思维链注入扩展初始化完成。');
}
