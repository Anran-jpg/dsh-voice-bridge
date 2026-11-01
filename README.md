# dsh-voice-bridge · 语音桥

把**一句话**投进 DSH 的一个工作区会话，等这一轮跑完，再把回复交给 TTS 念出来 —— 桌宠旁边还会同步弹出字幕气泡。

配好之后可以**完全不碰键盘**：喊一声「大肥鱼」，它应一句「在」，你接着说话，停顿一下自动收工，话就进了对话；回复一边念，气泡一边显示。

## 装

```powershell
dsh plugin --profile desktop add https://github.com/Anran-jpg/dsh-voice-bridge/tarball/main
```

装完**重启一次 DSH**（bundle 只在启动时解析），然后打开「设置 → 语音桥」。

> 本机没有 `dsh` 命令时，也可以在插件管理器里直接填上面这个 tarball 地址。

## 能做什么

### 语音输入（把话送进会话）

- **两种触发方式**，面板里二选一：
  - **热键**：按住说话 / 按一下开始再按一下结束，键可以自己改，改完 1.5 秒生效
  - **唤醒词**：常开麦听唤醒词（默认「大肥鱼」，支持多个、逗号隔开），喊中先应答一句「在」（不进对话、不花模型），桌宠同时摆一个姿势，然后开始收话，**停顿 N 秒自动收工**
- **唤醒词认得出近似发音**：模型把「大肥鱼」听成「大飞鱼」「得肥鱼」也能认出，不用逐字对上
- **识别引擎**可选：官方 SenseVoice（推荐，自带标点、不吃显卡）或本地 FunASR（能挂热词，但慢、占内存）
- **总开关**：语音输入整块的开关，关掉后不听热键也不听唤醒词

### 语音输出（把回复念出来）

- **引擎**：本地克隆音色（GPT-SoVITS 之类自建服务）/ edge-tts（微软云端，免费）/ OpenAI 兼容 TTS / Windows SAPI，支持**按顺序降级**
- **音色**：每个引擎各记各的，面板里下拉选
- **念什么**：可以只念语音投进来的回复，也可以把手动打字的回复一起念；可设最多念多少字
- **桌宠联动**（装了 `dsh-pet` 时）：
  - 回复字幕同步弹在桌宠气泡里，**先出字、紧接着开口、念完才收**
  - 「让桌宠来念」打开时，桥只把台词递过去，桌宠那边先合成、拿到真实时长再弹气泡，所以字一出来就是开口的时刻
  - 应答姿势这类动画也走桌宠
- **总开关**：语音输出整块的开关，关掉后一句都不念、气泡也不弹

### 维护

- **本地 TTS 自启**：DSH 起来时如果本地 TTS 没在跑，插件会把看门狗拉起来（面板上也有「帮我拉起来」按钮）
- **录音清理**：每句录音落在 `<工作区>\voice\in\`，默认保留 15 天，启动时自动清，也能手动「现在清一次」
- **会话**：跟着最新会话走 / 固定投给一个会话 / 每次新建

## 依赖

| 东西 | 必需？ | 说明 |
| --- | --- | --- |
| DSH ≥ 0.2 | 必需 | 插件本体 |
| Node ≥ 22 | 必需 | 插件是 ESM |
| `voice\` 下的 Python 服务 | 可选 | 语音输入、唤醒词、本地克隆音色要靠它；只用官方识别 + edge/openai/sapi 朗读可以不装 |
| `dsh-pet` | 可选 | 没有它就不弹气泡、不讲姿势，朗读照常 |
| 本地 TTS 服务（`/speak`、`/health`） | 可选 | 用本地克隆音色或让桌宠念时才需要 |

Python 那套（`tts-server.py` / `pet-voice.py` / `voice-in.py` / `sup.py` / `common\`）在仓库的 `service\` 目录里，自带说明。模型（GPT-SoVITS、FunASR）体积很大，**不随仓库分发**，按服务自己的说明下载。

## 配置

面板里改的都写进 `$DSH_HOME/voice-bridge/config.json`（Windows 一般是 `C:\Users\<你>\.dsh\voice-bridge\config.json`）；语音输入那套设置写在 `<工作区>\voice\config.json`。插件行里的 `config:` 优先级最高。

## 路由（只认 127.0.0.1）

```
POST /dsh-voice-bridge/say            { text, sessionId?, cwd? } -> { ok, sessionId, reply, spoke }
GET  /dsh-voice-bridge/status                                     状态 + TTS 健康 + 上次往返
GET  /dsh-voice-bridge/config         当前配置 + 文件路径
POST /dsh-voice-bridge/config         {...}    保存（校验类型与范围）
GET  /dsh-voice-bridge/log?lines=60   日志尾巴
POST /dsh-voice-bridge/speak-test     { text }       只测朗读
POST /dsh-voice-bridge/transcribe     { file | audio(base64), language? }   识别一段音频
GET  /dsh-voice-bridge/wake           触发方式 / 唤醒词 / 应答 / 应答姿势
POST /dsh-voice-bridge/wake           {...}    保存；换触发方式会重启 voice-in
GET  /dsh-voice-bridge/hotkey         当前热键
POST /dsh-voice-bridge/hotkey         { hotkey, mode }    改热键，1.5 秒生效
POST /dsh-voice-bridge/pet-test       { text }       往桌宠气泡发一句
POST /dsh-voice-bridge/pet-anim       { name }       让桌宠摆个姿势
POST /dsh-voice-bridge/start-tts                      本地 TTS 没在跑就拉起来
GET  /dsh-voice-bridge/records        录音统计
POST /dsh-voice-bridge/records        立即清理
```

## 设计取舍

- **同步等回复**：`/say` 一直挂到 `turn/end` 才返回，调用方可以「说一句 → 听一句」，不用轮询。
- **只认本机**：`req.socket.remoteAddress` 不是回环地址一律 403，避免同网段的人把你的会话当 API 用。
- **气泡跟声音对齐**：谁念谁负责弹气泡 —— 先拿到真实音频时长，再按这个长度弹，念完显式收掉。
- **失败要响**：建会话失败、超时、TTS 不通都会带原因返回并写日志，不静默吞掉。
- **能被关掉**：输入/输出各有总开关，关掉是「真不干活」，不只是界面藏起来。

## License

MIT
