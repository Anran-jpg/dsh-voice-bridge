/**
 * 本地克隆音色（GPT-SoVITS 之类自建服务）
 *
 * 约定：用户自己起一个 HTTP 服务，POST /speak { text, play, pet } 返回 { ok, file, audio_sec }。
 * 本插件只管把文本递过去、把返回的音频文件拿来播。
 */
export const id = 'local'
export const label = '本地TTS克隆音色'
export const produces = 'wav'

export function listVoices() {
  return [] // 音色由用户自己的服务决定
}

export async function available(opts = {}) {
  const base = (opts.ttsUrl || '').replace(/\/+$/, '')
  if (!base) return { ok: false, reason: '还没填本地服务地址' }
  try {
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false, reason: '健康检查返回 ' + res.status }
    const data = await res.json().catch(() => ({}))
    return { ok: true, model: data.model_loaded ? '已加载' : '未加载', ref: data.ref || '' }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

export async function synth(text, opts = {}) {
  const base = (opts.ttsUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('本地 TTS 地址没配')
  const res = await fetch(base + '/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text, play: false, pet: false, speed: Number(opts.speed) || 1 }),
    signal: AbortSignal.timeout(300000),
  })
  if (!res.ok) throw new Error('本地 TTS 返回 ' + res.status)
  const data = await res.json()
  if (!data || !data.file) throw new Error('本地 TTS 没有返回音频文件')
  return { file: data.file, mime: 'audio/wav', audioSec: data.audio_sec }
}
