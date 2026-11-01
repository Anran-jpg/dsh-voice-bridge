/**
 * 云 TTS（OpenAI 兼容协议）
 *
 * 一份代码覆盖：OpenAI、Azure OpenAI、SiliconFlow、自建 one-api / new-api 之类的兼容网关。
 * 只要填 Base URL + Key + 模型名 + 音色名就能用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const id = 'openai'
export const label = '云 TTS（OpenAI 兼容）'
export const produces = 'wav'

const FALLBACK_VOICES = [
  { id: 'alloy', label: 'alloy · 中性' },
  { id: 'echo', label: 'echo · 男声' },
  { id: 'fable', label: 'fable · 讲述' },
  { id: 'onyx', label: 'onyx · 低沉男声' },
  { id: 'nova', label: 'nova · 明亮女声' },
  { id: 'shimmer', label: 'shimmer · 温柔女声' },
]

export function listVoices() {
  return FALLBACK_VOICES
}

export async function available(opts = {}) {
  if (!opts.apiKey) return { ok: false, reason: '还没填 API Key', voices: FALLBACK_VOICES }
  return { ok: true, voices: FALLBACK_VOICES }
}

export async function synth(text, opts = {}) {
  const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  if (!opts.apiKey) throw new Error('云 TTS 需要 API Key')
  const body = {
    model: opts.model || 'tts-1',
    input: text,
    voice: opts.voice || 'alloy',
    response_format: 'wav',
    speed: Math.max(0.25, Math.min(4, Number(opts.speed) || 1)),
  }
  const res = await fetch(baseUrl + '/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error('云 TTS 返回 ' + res.status + '：' + detail.slice(0, 200))
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const out = opts.outFile || path.join(os.tmpdir(), 'vb-openai-' + Date.now() + '.wav')
  fs.writeFileSync(out, buf)
  return { file: out, mime: 'audio/wav' }
}
