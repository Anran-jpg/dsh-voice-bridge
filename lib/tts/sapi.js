/**
 * 系统语音（Windows SAPI / macOS say / Linux espeak）
 *
 * 定位：零安装兜底档。别人装了插件没配任何东西，至少能有声音。
 * 产出：wav（Windows/mac 端由系统直接写文件）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const id = 'sapi'
export const label = '系统语音（免安装）'
export const produces = 'wav'

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || cmd + ' 退出码 ' + code))))
    if (input != null) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

const PS_LIST =
  'Add-Type -AssemblyName System.Speech; ' +
  '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
  'ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture }'

export async function listVoices() {
  if (process.platform !== 'win32') return []
  const out = await run('powershell.exe', ['-NoProfile', '-Command', PS_LIST])
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, culture = ''] = line.split('|')
      return { id: name, label: name.replace(' Microsoft ', ' ').trim(), lang: culture }
    })
}

export async function available() {
  if (process.platform === 'win32') {
    try {
      const v = await listVoices()
      return v.length ? { ok: true, voices: v } : { ok: false, reason: '系统里没有可用的语音包' }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) }
    }
  }
  if (process.platform === 'darwin') return { ok: true }
  return { ok: false, reason: '非 Windows/macOS 环境，需要自己装 espeak' }
}

export async function synth(text, opts = {}) {
  const out = opts.outFile || path.join(os.tmpdir(), 'vb-sapi-' + Date.now() + '.wav')
  const rate = Math.max(-10, Math.min(10, Math.round((Number(opts.speed) || 1) * 2 - 2)))

  if (process.platform === 'win32') {
    const voice = opts.voice ? String(opts.voice).replace(/'/g, "''") : ''
    // 别走 stdin 递中文：powershell.exe 按系统 ANSI 代码页（这台是 GBK）解码，
    // UTF-8 的中文会变成一串乱码，念出来跟显示的字完全不是一回事。
    // 改成 base64 塞在命令行里，PS 那边按 UTF-8 还原，跨编码就稳了。
    const b64 = Buffer.from(String(text), 'utf8').toString('base64')
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      (voice ? "try { $s.SelectVoice('" + voice + "') } catch { }; " : '') +
      '$s.Rate = ' + rate + '; ' +
      "$s.SetOutputToWaveFile('" + out.replace(/'/g, "''") + "'); " +
      "$txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')); " +
      '$s.Speak($txt); $s.Dispose()'
    await run('powershell.exe', ['-NoProfile', '-Command', script])
    return { file: out, mime: 'audio/wav' }
  }

  if (process.platform === 'darwin') {
    await run('say', ['-r', String(Math.round(180 * (Number(opts.speed) || 1))), '-o', out, '--data-format=LEI16@22050', text])
    return { file: out, mime: 'audio/wav' }
  }

  const tmp = out.replace(/\.wav$/, '.aiff')
  await run('espeak', ['-v', 'zh', '-w', tmp, text])
  return { file: tmp, mime: 'audio/aiff' }
}

export function cleanup(file) {
  try {
    fs.unlinkSync(file)
  } catch (e) {}
}
