/**
 * 朗读引擎注册表 + 自动降级
 *
 * 主人定的规则：插件不该绑定某一种 TTS。别人电脑上不一定装了本地克隆服务，
 * 所以按「本机有什么」往下退：本地 → 免费云（edge）→ 系统语音。
 *
 * 每个 provider 只需要实现：
 *   id / label / listVoices() / available(opts) / synth(text, opts) -> { file, mime, audioSec? }
 */
import * as sapi from './sapi.js'
import * as edge from './edge.js'
import * as openai from './openai.js'
import * as local from './local.js'

export const PROVIDERS = { sapi, edge, openai, local }

export const ORDER = ['local', 'edge', 'openai', 'sapi']

export function providerInfo(id) {
  const p = PROVIDERS[id]
  return p ? { id: p.id, label: p.label } : null
}

export function allProviders() {
  return ORDER.map((id) => ({ id, label: PROVIDERS[id].label }))
}

export function listVoices(id) {
  const p = PROVIDERS[id]
  return p && typeof p.listVoices === 'function' ? p.listVoices() : []
}

function optsFor(id, cfg) {
  const perEngine = (cfg.ttsVoices && cfg.ttsVoices[id]) || ''
  const fallbackVoice = id === 'openai' ? (cfg.openaiVoice || '') : ''
  return {
    ttsUrl: cfg.ttsUrl,
    apiKey: cfg.openaiApiKey,
    baseUrl: cfg.openaiBaseUrl,
    model: cfg.openaiModel,
    voice: perEngine || fallbackVoice || cfg.ttsVoice || undefined,
    openaiVoice: cfg.openaiVoice,
    speed: cfg.ttsSpeed,
  }
}

/** 指定引擎合成一次（面板试听用），不做降级 */
export async function synthOne(id, text, cfg) {
  const p = PROVIDERS[id]
  if (!p) throw new Error('没有这个引擎：' + id)
  const opts = optsFor(id, cfg)
  const started = Date.now()
  const out = await p.synth(text, opts)
  return {
    file: out.file,
    mime: out.mime,
    provider: id,
    voice: opts.voice || '',
    audioSec: out.audioSec || 0,
    ms: Date.now() - started,
  }
}

export async function health(id, cfg) {
  const p = PROVIDERS[id]
  if (!p) return { ok: false, reason: '没有这个引擎：' + id }
  try {
    return await p.available(optsFor(id, cfg))
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

export async function healthAll(cfg) {
  const out = {}
  for (const id of ORDER) out[id] = await health(id, cfg)
  return out
}

/** 真正要用的引擎：指定了就只用它；auto 就按 chain 顺序找第一个能用的 */
export async function resolveChain(cfg) {
  if (cfg.ttsProvider && cfg.ttsProvider !== 'auto') return [cfg.ttsProvider]
  const chain = String(cfg.ttsChain || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PROVIDERS[s])
  const list = chain.length ? chain : ORDER
  const usable = []
  for (const id of list) {
    const h = await health(id, cfg)
    if (h.ok) usable.push(id)
    else usable.push(id + '!') // 标记一下，最后兜底还会试一遍
  }
  return usable
}

/**
 * 合成并返回可播放文件；失败自动往下退一档。
 * 返回 { file, provider, voice, ms, tried: [{id, ok, error?}] }
 */
export async function synthWithFallback(text, cfg) {
  const chain = await resolveChain(cfg)
  const tried = []
  for (const raw of chain) {
    const id = raw.replace(/!$/, '')
    const p = PROVIDERS[id]
    if (!p) continue
    const started = Date.now()
    try {
      const out = await p.synth(text, optsFor(id, cfg))
      tried.push({ id, ok: true })
      return {
        file: out.file,
        mime: out.mime,
        provider: id,
        voice: optsFor(id, cfg).voice || '',
        audioSec: out.audioSec || 0,
        ms: Date.now() - started,
        tried,
      }
    } catch (e) {
      tried.push({ id, ok: false, error: String((e && e.message) || e) })
    }
  }
  const detail = tried.map((t) => t.id + (t.ok ? '' : '：' + t.error)).join('；')
  throw new Error('所有朗读引擎都失败了（' + detail + '）')
}
