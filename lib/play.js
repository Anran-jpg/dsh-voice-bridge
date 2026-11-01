/**
 * 播放音频文件（不阻塞调用方）
 *
 * 这条只是「本地 TTS 服务没起来 / 不支持 /play」时的兜底 —— 正常路径是
 * 由 TTS 服务在自己进程里播（见 index.js 的 playOnServer），不起子进程。
 *
 * 兜底一律走 Windows PowerShell（wav 用 SoundPlayer，mp3 等用 WPF MediaPlayer），
 * 关键两点（都是血泪）：
 *   1. **不能 detached**。实测 detached:true（DETACHED_PROCESS + 无控制台）的
 *      powershell 起不到 0.2s 就退出，一个字都不念 —— 之前「edge 试听没声音」
 *      就是这个原因；不加 detached、只靠 unref() 就能后台跑完。
 *   2. windowsHide: true（CREATE_NO_WINDOW）才不弹控制台窗口，且不要再走
 *      python.exe 的 winsound —— 那正是「试听弹 cmd 窗」的来源。
 * 出错写 logs/play.log。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 兜底播放器自己的日志。路径跟着工作区走（可用 DSH_WORKSPACE 覆盖），
// 不写死某个绝对路径 —— 别人装在别的地方也不会往我们盘上写。
const LOG = path.join(process.env.DSH_WORKSPACE || process.cwd(), 'voice', 'logs', 'play.log')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + msg + '\n', 'utf8')
    const st = fs.statSync(LOG)
    if (st.size > 64 * 1024) {
      const lines = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).slice(-200)
      fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
    }
  } catch (e) {}
}

/** PowerShell 里用 WPF MediaPlayer 放一段（mp3 / wav 都认），放完自己退出 */
function psMediaScript(q) {
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName PresentationCore',
    '$p = New-Object System.Windows.Media.MediaPlayer',
    "$p.Open([Uri]'" + q + "')",
    '$p.Play()',
    '$waited = 0',
    'while (-not $p.NaturalDuration.HasTimeSpan -and $waited -lt 10000) { Start-Sleep -Milliseconds 100; $waited += 100 }',
    '$ms = 3000',
    'if ($p.NaturalDuration.HasTimeSpan) { $ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds }',
    'Start-Sleep -Milliseconds ($ms + 400)',
    '$p.Stop()',
    '$p.Close()',
  ].join('; ')
}

export function playFile(file, opts = {}) {
  if (!file) return false
  const q = file.replace(/'/g, "''")
  const isWav = /\.wav$/i.test(file)
  const args = isWav
    ? ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `(New-Object System.Media.SoundPlayer '${q}').PlaySync()`]
    : ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psMediaScript(q)]
  const how = isWav ? 'SoundPlayer' : 'MediaPlayer'
  try {
    // 注意：不要 detached（见文件头注释），只 unref 让父进程能随时退出
    const child = spawn(PS, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', (e) => logLine('spawn 失败: ' + String((e && e.message) || e)))
    child.on('exit', (code) => {
      if (code !== 0) logLine('播放进程退出码 ' + code + ' ← ' + path.basename(file))
    })
    child.unref()
    logLine('播放 ' + path.basename(file) + ' (' + how + ')')
    return true
  } catch (e) {
    logLine('播放异常: ' + String((e && e.message) || e))
    return false
  }
}
