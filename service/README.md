# 大肥鱼语音三件套 + 看门狗

## 有什么

| 组件 | 脚本 | 作用 | 端口 |
|---|---|---|---|
| TTS 服务 | `<工作区>\voice\tts-server.py` | GPT-SoVITS v2Pro 克隆音色，`POST /speak {text, play, pet}` | 8777 |
| F8 语音输入 | `<工作区>\voice\voice-in.py` | 按住 F8 说话 → FunASR 识别 → 粘进前台窗口 | — |
| 桌宠朗读 | `<工作区>\voice\pet-voice.py` | 轮询桌宠 `/state`，新气泡自动念出来 | 跟着 DSH GUI 端口走 |
| 看门狗 | `<工作区>\voice\sup.py` | 开机自启，监控上面三个，挂了自动拉起 | — |
| 公共件 | `<工作区>\voice\common\` | `settings.py`（路径+端口）/ `config.py` / `log.py` / `http.py` / `ports.py` / `audio.py`（wav/播放）/ `desktop.py`（提示音/前台窗口/剪贴板），四个脚本共用 | — |
| 文本规范化 | `<工作区>\voice\tts_text.py` | 数字转中文读法、去 markdown、英文谐音；纯函数，`tts\_test_sanitize.py` 直接测它 | — |
| 热键绑定 | `<工作区>\voice\hotkeys.py` | `HotkeyBinder`：绑 F8、hold/toggle 两种模式、配置改了自动换键 | — |

脚本都放在 `voice\`，**模型、参考音、合成产物仍留在 `tts\`**（`tts\GPT-SoVITS-main`、`tts\ref\ref-8s.wav`、`tts\out\server\`），
`tts-server.py` 里按 `HERE=voice\` → `ROOT=DSH_Work\` → `TTS_ROOT=tts\` 推算，也可以用
`DSH_TTS_ROOT` / `DSH_TTS_REPO` / `DSH_TTS_REF` / `DSH_TTS_OUT` 环境变量覆盖。

## 开机自启怎么实现的

- 快捷方式：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\大肥鱼语音看门狗.lnk`
- 目标：`<工作区>\tts\venv\Scripts\pythonw.exe "<工作区>\voice\sup.py"`
- 用 `pythonw.exe` 所以没有黑窗口；工作目录在 `<工作区>\voice`

## 看门狗做什么

1. 启动时**先清掉**三个脚本的所有旧实例（避免双份抢端口），再各起一个。
2. 每 5 秒体检一次：
   - TTS：`GET http://127.0.0.1:8777/health`；刚启动的 40 秒内算“加载中”，不当成挂了。
   - F8 / 桌宠朗读：看进程还活着没。
3. 挂了就杀掉残留 + 重启；同一服务 1 分钟内重启 5 次会歇 30 秒，防止疯狂重启刷屏。
4. DSH 桌面端重启后 GUI 端口会变 → 自动发现新端口并重启 `voice\pet-voice.py`（端口发现靠 `dsh-pet-7340/config` 探测）。
5. **空闲退避**：一切正常时检查间隔按 10s → 16s → 25s → 40s → 60s 逐步放慢；一旦发现谁挂了，立刻回到 5s 快检并修复。
6. 端口探测（要遍历进程表，比较重）只在“有问题”或每 20 轮时才做一次。

## 实测开销

| 进程 | 常驻内存 | CPU |
|---|---|---|
| 看门狗 `sup.py` | ~23 MB | **120 秒 0.016 秒 ≈ 单核 0.013%** |
| TTS 服务（模型常驻） | ~2500 MB | 空闲时不计 |
| F8 识别（ASR 常驻） | ~840 MB | 空闲时不计 |
| 桌宠朗读 | ~18 MB | 每 5 秒问一次 GUI 状态 |

看门狗本身的代价基本可以忽略；真正吃内存的是两个模型（跟监控频率无关）。

## 常用命令

```powershell
$py = '<工作区>\tts\venv\Scripts\python.exe'
& $py <工作区>\voice\sup.py --status    # 看状态：tts 健康、GUI 端口、各脚本 pid
& $py <工作区>\voice\sup.py --once      # 只体检一遍，缺啥补啥
```

## 日志

所有日志统一放在 **`<工作区>\voice\logs\`**，单份上限 **2 MB**，超了自动裁剪到**最后 500 KB**（看门狗每 4 轮扫一次；`voice-in.py` 写自己那份时也会顺手裁）。

| 文件 | 内容 | 上限 |
|---|---|---|
| `logs\sup.log` | 看门狗记录（启动/接管/重启/自愈/日志裁剪） | 2MB → 500KB |
| `logs\voice-in.log` | F8 每次录音、识别结果、粘贴到哪个窗口 | 2MB → 500KB |
| `logs\voice-in.out.log` | F8 进程的 stdout/stderr | 2MB → 500KB |
| `logs\tts-server.log` | TTS 模型加载与监听 | 2MB → 500KB |
| `logs\pet-voice.log` | 桌宠朗读 | 2MB → 500KB |
| `logs\bridge.log` | 语音桥（F8 → 会话 → 回复念出来） | 2MB → 500KB |

> 六份日志一个规则：超过 **2 MB** 就裁到**最后 500 KB**。`sup.py` 每 4 轮扫一遍 logs 目录；`voice-in.py` 和语音桥插件各自写的时候也会顺手裁。

## 想关掉/临时停

```powershell
# 停看门狗
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sup.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 禁止开机自启：删掉 Startup 里那个快捷方式
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\大肥鱼语音看门狗.lnk"
```

## 坑（改脚本前先看）

- `sup.py` 用 `kill_script()` 按命令行关键字杀进程：**别在 ps1 里用 `Where-Object cmdline -like '*tts-server.py*'` 再 kill**，会把执行这条命令的 pwsh 自己也算进去，直接把执行器干掉（表现为 “Windows Job runner exited with exit code 4294967295”）。要杀就加 `-Filter "Name='python.exe'"` 并排除 `$PID`。
- 手动另起一份 TTS（不同端口）会被看门狗当成残留清掉——要测新端口，先停看门狗。
- 改 `sup.py` 后必须重启看门狗进程才生效（它是常驻的）。
