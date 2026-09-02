# SillyTavern 思维链注入与逻辑断点续接插件 (CoT Injection Extension)

[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-blue.svg)](https://github.com/SillyTavern/SillyTavern)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一款专为 **SillyTavern（酒馆）** 设计的思维链注入与逻辑断点续接扩展插件。

旨在解决闭源大模型（以 **Google Gemini** 为代表）不支持原生 Assistant Prefill（结尾放置 Assistant 报错 `400: Requests ending with a model turn are not supported`）的问题。通过在请求层静默构造标准化消息序列，在无需官方签名、免底层私有鉴权的前提下，实现全模型通用的思维干预、长任务分段接力以及逻辑断点无缝续接。

---

## ✨ 核心特性

1. **协议零报错 (Gemini 400 完美解决)**
   - 严格遵循 `User(当前问题) → Assistant/Model(预设思维链草稿) → User(下一轮提示词)` 的标准化轮次交替序列。
   - 彻底规避 OpenAI / Google Gemini 协议中关于末尾不能为 assistant 消息的限制。

2. **跨 API 协议格式无缝支持**
   - 提供协议格式选择器，支持：
     - **自动识别 (Auto Detect)**：智能自适应当前酒馆连接的数据包结构；
     - **OpenAI 兼容协议**：标准 Chat Completions (`role: assistant/user`, `content`)；
     - **Google Gemini 协议**：支持原生 REST 与中转 (`role: model/user`, `parts/content`)；
     - **Anthropic 协议**：Claude Messages API (`role: assistant/user`)。

3. **完整支持酒馆预设与动态宏处理**
   - 下一轮用户提示词（如“继续”等）与思维链草稿均通过酒馆宏引擎处理，原生支持 `{{user}}`、`{{char}}`、`{{model}}` 等动态宏变量替换。

4. **后端静默请求拦截与当前轮结果补充**
   - 新一轮的对话交替在发送至大模型时由后端静默构造，**不会在前端聊天记录中生成多余的虚拟对话卡片**。
   - 模型生成的续接结果直接合并并展示在当前轮次中，思维链作为当前消息的折叠思考过程展示。

5. **单次生效模式 (Single-shot) 与实时开关**
   - 开关点击立即实时生效，无需手动保存；
   - 支持生成一次后自动关闭插件开关，避免持续干预后续正常对话。

6. **显式保存配置按钮与协议实时预览**
   - 界面提供专属「保存配置」按钮，切换不同协议时实时渲染对应的 Payload 请求结构预览。

7. **支持斜杠命令 (Slash Command)**
   - 快捷命令 `/cot-inject action=(on|off|toggle|status)`，方便一键启停或在快捷指令中使用。

---

## 📦 安装方法

### 方式一：在 SillyTavern 界面内直接安装（推荐）
1. 打开 SillyTavern，点击右上角 **扩展插件 (Extensions)** 按钮（方块图标）。
2. 点击 **安装扩展 (Install extension)**。
3. 在 Git 仓库 URL 输入框中粘贴：
   ```text
   https://github.com/Xeltra233/cot-injection
   ```
4. 点击保存/安装，安装完成后刷新页面即可。

### 方式二：手动克隆安装
在 SillyTavern 根目录下执行：
```bash
git clone https://github.com/Xeltra233/cot-injection.git public/scripts/extensions/third-party/cot-injection
```
刷新或重启 SillyTavern 即可。
---

## 🛠️ 配置与使用说明

进入右侧菜单的 **扩展设置 (Extensions)** -> 打开 **思维链注入与逻辑断点续接 (CoT Injection)** 折叠面板：

| 配置项 | 说明 |
| :--- | :--- |
| **启用思维链注入** | 主开关。点击立即实时生效。 |
| **单次生效模式 (Single-shot)** | 点击立即实时生效。触发一次大模型生成后自动关闭开关。 |
| **API 端点协议格式** | 切换 OpenAI / Gemini / Anthropic / Auto 协议，自适应 payload 数据结构。 |
| **思维链草稿 (Assistant CoT)** | 预设推导过程。末尾建议使用未完结的前向断点句式。支持 `{{user}}` / `{{char}}` 宏。 |
| **下一轮用户提示词** | 灰字 placeholder 提示如“例如：继续”。留空时默认使用 `继续`。支持宏替换。 |
| **保存配置按钮** | 显式保存当前协议与文本配置。 |

---

## 📄 协议与免责声明

本项目基于 [MIT License](LICENSE) 开源。
