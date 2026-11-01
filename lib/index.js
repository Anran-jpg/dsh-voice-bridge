/**
 * dsh-voice-bridge · 主进程半边
 *
 * 做的事：把一句话投进指定的工作区会话，等这一轮跑完，把助手回的那段文本交回来；
 * 可选顺手把它交给本地 TTS 念出来。只认 127.0.0.1 —— 这是个"本机遥控器"。
 *
 * 路由：
 *   POST /dsh-voice-bridge/say          { text, sessionId?, cwd? } -> { ok, sessionId, sessionFrom, reply }
 *   GET  /dsh-voice-bridge/status       -> { ok, sessionMode, sessionId, sessionFrom, busy, cwd, lastAt, tts }
 *   GET  /dsh-voice-bridge/config       -> { ok, config, file }
 *   POST /dsh-voice-bridge/config       -> { ok, config }
 *   GET  /dsh-voice-bridge/log?lines=60 -> { ok, lines }
 *   POST /dsh-voice-bridge/speak-test   { text } -> { ok, audioSec }
 *   POST /dsh-voice-bridge/pet-test     { text } -> { ok, pet }   往桌宠气泡里发一句试试
 *   POST /dsh-voice-bridge/start-tts    -> { ok, started }        本地 TTS 没在跑就拉起来
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as tts from './tts/index.js'
import { playFile } from './play.js'

export const name = 'voice-bridge'
export const inject = ['webServer', 'sessionController']

/** 默认值即合同：面板里改的只是覆盖层，写进 $DSH_HOME/voice-bridge/config.json */
export const DEFAULTS = {
  // latest = 每次投给 cwd 下最近活跃的那个会话（默认，不用手动绑）
  // fixed  = 永远投给 sessionId 里写死的那个
  // new    = 每次插件加载后自己新建一个专属会话
  sessionMode: 'latest',
  sessionId: '',
  cwd: process.cwd(),
  // 等一轮跑完的上限。这里的一轮经常要跑好几分钟（模型思考 + 工具），
  // 5 分钟会把正常的长回复判成超时，语音那头就退回粘贴了 —— 默认给 15 分钟。
  timeoutMs: 900000,
  speakReply: false,
  // 手动打字的那些回复也念（不是经语音桥投递的）。默认关：
  // 你在这儿敲字的时候旁边突然开口会很烦，想要再开。
  speakTypedReplies: false,
  ttsUrl: 'http://127.0.0.1:8777',
  speakMaxChars: 100,
  // 语音输入那套脚本的配置（热键/唤醒词/识别引擎都写这里）。
  // 空 = 跟着工作区走：<cwd>/voice/config.json
  voiceConfig: '',
  logFile: '',
  // 朗读引擎：auto 按 ttsChain 顺序降级；也可手动指定 local / edge / openai / sapi
  ttsProvider: 'auto',
  ttsChain: 'local,edge,openai,sapi',
  ttsVoice: '',
  // 每个引擎各自记住上次选的音色：{ edge: 'zh-CN-XiaoxiaoNeural', sapi: 'Microsoft Huihui Desktop' }
  ttsVoices: {},
  ttsSpeed: 1,
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'tts-1',
  openaiVoice: 'alloy',
  // 朗读的同时把这句话也丢给桌宠（dsh-pet）弹气泡；关掉就只念不弹
  petSync: true,
  // 空 = 自动读 $DSH_HOME/dsh-pet/main-config.jsonc 里的第一只宠物
  petId: '',
  // 空 = 用本机 web 服务的 origin（和 dsh-pet 的路由同一个端口）
  petUrl: '',
  // 气泡发成功后就交给桌宠那边念（pet-voice.py），桥自己不再出声，免得念两遍
  letPetSpeak: true,
  // F8 录音（voice-in.py 存到 voice\in\in-<毫秒>.wav）留多少天；0 = 不清理
  recordKeepDays: 15,
  // 空 = 跟着 voiceConfig 同目录的 in\ 走（<工作区>/voice/in）
  recordDir: '',
  // DSH 一起来就把本地 TTS 看门狗拉起来：DSH 重启时子进程会被收走，
  // 而人不会记得再手动双击一次 —— 于是「每次重启都没声音」。
  autoStartTts: true,
  // 空 = 用看门狗脚本自带的解释器：<cwd>/tts/venv/Scripts/pythonw.exe
  ttsPython: '',
  // 空 = <cwd>/voice/sup.py（cwd 默认就是工作区根）
  ttsWatchdog: '',
  // 识别（F8 说的话变成文字）走谁：
  //   official = 宿主里官方语音输入插件的 speechToText 服务（SenseVoice int8 ONNX，自带标点、不吃 GPU）
  //   funasr   = voice-in.py 自己那份 paraformer-zh + ct-punc（能挂热词，但慢、占内存）
  sttEngine: 'official',
  // official 那条路送给识别器的语言；auto / zh / en / yue / ja / ko
  sttLanguage: 'auto',
  // 两块功能的总开关。关掉输入 = 不听热键/唤醒词、不往会话投话；
  // 关掉输出 = 一句都不念、也不弹气泡。面板上关掉后对应的设置直接收起来。
  inputEnabled: true,
  outputEnabled: true,
}

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function configFile() {
  return path.join(homeDir(), 'voice-bridge', 'config.json')
}

export function defaultLogFile() {
  return path.join(process.cwd(), 'voice', 'logs', 'bridge.log')
}

/** 合并：默认值 < 配置文件 < 插件行 config */
export function resolveConfig(rowConfig) {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  } catch (e) {
    file = {}
  }
  const merged = Object.assign({}, DEFAULTS, file, rowConfig || {})
  if (!merged.logFile) merged.logFile = defaultLogFile()
  return merged
}

export function validateConfig(next) {
  const out = {}
  if (typeof next.sessionId === 'string') out.sessionId = next.sessionId.trim()
  if (typeof next.sessionMode === 'string' && next.sessionMode.trim()) {
    const m = next.sessionMode.trim().toLowerCase()
    if (!['latest', 'fixed', 'new'].includes(m)) throw new Error('sessionMode 只能是 latest / fixed / new')
    out.sessionMode = m
  }
  if (typeof next.cwd === 'string' && next.cwd.trim()) out.cwd = next.cwd.trim()
  if (next.timeoutMs != null) {
    const n = Number(next.timeoutMs)
    if (!Number.isFinite(n) || n < 5000 || n > 3600000) throw new Error('timeoutMs 要在 5 秒到 1 小时之间')
    out.timeoutMs = Math.round(n)
  }
  if (next.speakReply != null) out.speakReply = Boolean(next.speakReply)
  if (next.speakTypedReplies != null) out.speakTypedReplies = Boolean(next.speakTypedReplies)
  if (typeof next.ttsUrl === 'string' && next.ttsUrl.trim()) out.ttsUrl = next.ttsUrl.trim().replace(/\/+$/, '')
  if (next.speakMaxChars != null) {
    const n = Number(next.speakMaxChars)
    if (!Number.isFinite(n) || n < 10 || n > 2000) throw new Error('speakMaxChars 要在 10 到 2000 之间')
    out.speakMaxChars = Math.round(n)
  }
  if (typeof next.logFile === 'string') out.logFile = next.logFile.trim()
  if (typeof next.voiceConfig === 'string' && next.voiceConfig.trim()) out.voiceConfig = next.voiceConfig.trim()
  if (typeof next.ttsProvider === 'string' && next.ttsProvider.trim()) {
    const p = next.ttsProvider.trim().toLowerCase()
    if (!['auto', 'local', 'edge', 'openai', 'sapi'].includes(p)) throw new Error('ttsProvider 只能是 auto/local/edge/openai/sapi')
    out.ttsProvider = p
  }
  if (typeof next.ttsChain === 'string' && next.ttsChain.trim()) {
    const list = next.ttsChain.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const bad = list.filter((x) => !['local', 'edge', 'openai', 'sapi'].includes(x))
    if (bad.length) throw new Error('ttsChain 里有不认识的引擎：' + bad.join(', '))
    out.ttsChain = list.join(',')
  }
  if (typeof next.ttsVoice === 'string') out.ttsVoice = next.ttsVoice.trim()
  if (next.ttsVoices && typeof next.ttsVoices === 'object' && !Array.isArray(next.ttsVoices)) {
    const map = {}
    for (const [id, v] of Object.entries(next.ttsVoices)) {
      if (!['local', 'edge', 'openai', 'sapi'].includes(id)) continue
      if (typeof v !== 'string') continue
      map[id] = v.trim()
    }
    out.ttsVoices = map
  }
  if (next.ttsSpeed != null) {
    const n = Number(next.ttsSpeed)
    if (!Number.isFinite(n) || n < 0.5 || n > 2) throw new Error('ttsSpeed 要在 0.5 到 2 之间')
    out.ttsSpeed = n
  }
  for (const k of ['openaiBaseUrl', 'openaiApiKey', 'openaiModel', 'openaiVoice']) {
    if (typeof next[k] === 'string') out[k] = next[k].trim()
  }
  if (next.petSync != null) out.petSync = Boolean(next.petSync)
  if (next.letPetSpeak != null) out.letPetSpeak = Boolean(next.letPetSpeak)
  if (typeof next.petId === 'string') out.petId = next.petId.trim()
  if (typeof next.petUrl === 'string') out.petUrl = next.petUrl.trim().replace(/\/+$/, '')
  if (next.recordKeepDays != null && next.recordKeepDays !== '') {
    const n = Number(next.recordKeepDays)
    if (!Number.isFinite(n) || n < 0 || n > 3650) throw new Error('录音保留天数要在 0 到 3650 之间（0 = 不清理）')
    out.recordKeepDays = Math.round(n)
  }
  if (typeof next.recordDir === 'string') out.recordDir = next.recordDir.trim()
  if (next.autoStartTts != null) out.autoStartTts = Boolean(next.autoStartTts)
  if (typeof next.ttsPython === 'string') out.ttsPython = next.ttsPython.trim()
  if (typeof next.ttsWatchdog === 'string') out.ttsWatchdog = next.ttsWatchdog.trim()
  if (next.sttEngine != null && next.sttEngine !== '') {
    const v = String(next.sttEngine).trim().toLowerCase()
    if (v !== 'official' && v !== 'funasr') throw new Error('识别引擎只能是 official（官方 SenseVoice）/ funasr（本地 FunASR）')
    out.sttEngine = v
  }
  if (typeof next.sttLanguage === 'string') {
    const v = next.sttLanguage.trim()
    if (v) out.sttLanguage = v
  }
  if (next.inputEnabled != null) out.inputEnabled = Boolean(next.inputEnabled)
  if (next.outputEnabled != null) out.outputEnabled = Boolean(next.outputEnabled)
  return out
}

export function saveConfig(patch) {
  const clean = validateConfig(patch)
  const current = (() => {
    try {
      return JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    } catch (e) {
      return {}
    }
  })()
  const next = Object.assign({}, current, clean)
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function json(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > limit) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function isLocal(req) {
  const a = req.socket && req.socket.remoteAddress
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function textOfMessage(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 说话只念前面几句，别把长表格念成流水账 */
export function shortForSpeech(text, limit) {
  const body = String(text || '')
    .replace(/```[\s\S]*?```/g, '（代码块）')
    .replace(/[#*_`>]/g, ' ')
  const parts = body.split(/(?<=[。！？!?])/)
  let out = ''
  for (const p of parts) {
    if (out.length + p.length > limit) break
    out += p
  }
  return (out || body).slice(0, limit).trim()
}

export function apply(ctx, rowConfig) {
  const cfg = resolveConfig(rowConfig)
  const logFile = cfg.logFile
  let stickyId = null // fixed / new 模式下长期复用的那个会话
  let latestCache = { id: null, at: 0 } // latest 模式的短缓存，免得每句话都去翻一遍会话表
  const LATEST_TTL = 10000
  let lastSrc = '' // 上次这个 id 是怎么来的，给面板看的
  let busy = false
  const last = { at: 0, text: '', reply: '' }
  let petLast = null // 上次往桌宠发气泡的结果，给面板看
  let recordLast = null // 上次清理录音的结果，给面板看
  // 「客户端是不是真的把这条气泡画出来了」的探针：拿它当气泡配图，
  // 客户端真渲染才会来取这张 1x1 的透明图，取到的时刻就是「字已经上屏」的时刻。
  let beaconLast = null

  // 手动打字那些轮次桥没参与，只能自己盯 session/event 捡回复。
  const typedSeen = new Map() // sessionId -> 这一轮里最后一条助手文本
  const bridgePending = new Set() // 桥自己正在等的会话：等回来由 /say 那边念，这里别重复念
  let typedChain = Promise.resolve() // 一句一句念，别叠在一起

  // 日志统一规则：单份上限 2MB，超了裁到最后 500KB（跟 voice\logs 里其它日志一致）
  const LOG_MAX = 2 * 1024 * 1024
  const LOG_KEEP_BYTES = 500 * 1024

  function logLine(msg) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n')
      if (fs.statSync(logFile).size > LOG_MAX) {
        const buf = fs.readFileSync(logFile)
        let tail = buf.subarray(Math.max(0, buf.length - LOG_KEEP_BYTES))
        const nl = tail.indexOf(0x0a)
        if (nl >= 0 && nl < tail.length - 1) tail = tail.subarray(nl + 1)
        fs.writeFileSync(logFile, tail)
      }
    } catch (e) {}
    try {
      ctx.logger.info('[voice-bridge] ' + msg)
    } catch (e) {}
  }

  function sidOf(session) {
    if (typeof session === 'string') return session
    if (session && typeof session.id === 'string') return session.id
    return null
  }

  function modeOf() {
    const m = String(cfg.sessionMode || '').trim().toLowerCase()
    return ['latest', 'fixed', 'new'].includes(m) ? m : 'latest'
  }

  function normPath(p) {
    try {
      return path.resolve(String(p || '')).toLowerCase()
    } catch (e) {
      return String(p || '').toLowerCase()
    }
  }

  /**
   * 找 cwd 下最近活跃的那个会话。
   * list() 本身按活跃度排好序，但这里还是显式比一遍 updatedAt，不依赖顺序。
   * 跳过：子会话 / 空白会话 / 别的目录的会话。
   */
  async function findLatestSession() {
    const sc = ctx.get('sessionController')
    if (!sc || typeof sc.list !== 'function') return null
    const out = await sc.list({}, AbortSignal.timeout(10000))
    const items = (out && out.items) || []
    const want = normPath(cfg.cwd)
    let best = null
    for (const s of items) {
      if (!s || !s.sessionId) continue
      if (s.parentSessionId || s.origin === 'subagent') continue
      if (s.blank) continue
      if (s.cwd && normPath(s.cwd) !== want) continue
      if (!best || (s.updatedAt || 0) > (best.updatedAt || 0)) best = s
    }
    return best ? String(best.sessionId) : null
  }

  async function createSession() {
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: cfg.cwd })
    const id = (created && created.sessionId) || null
    if (!id) throw new Error('建会话没有返回 sessionId')
    return String(id)
  }

  /** 真正要投给谁。want 来自请求体，优先级最高。 */
  async function resolveSession(want) {
    if (want) return String(want)
    const mode = modeOf()

    if (mode === 'fixed') {
      if (cfg.sessionId) {
        lastSrc = 'fixed'
        return cfg.sessionId
      }
      // 写死的 id 是空的，那就退化成新建，别把话丢了
    }

    if (mode === 'latest') {
      if (latestCache.id && Date.now() - latestCache.at < LATEST_TTL) {
        lastSrc = 'latest'
        return latestCache.id
      }
      let id = null
      try {
        id = await findLatestSession()
      } catch (e) {
        logLine('列会话失败（退回新建）：' + String((e && e.message) || e))
      }
      if (id) {
        latestCache = { id, at: Date.now() }
        lastSrc = 'latest'
        return id
      }
      // 一个历史会话都没有，才新建
    }

    if (stickyId) {
      lastSrc = mode === 'new' ? 'new' : 'fallback'
      return stickyId
    }
    stickyId = await createSession()
    lastSrc = mode === 'new' ? 'new' : 'fallback'
    logLine('没有可用会话，新建了一个：' + stickyId)
    return stickyId
  }

  /** 只读地看一眼现在会投给谁，不建会话（给面板用） */
  async function peekSession() {
    const mode = modeOf()
    if (mode === 'fixed') return { id: cfg.sessionId || null, from: 'fixed' }
    if (mode === 'new') return { id: stickyId, from: 'new' }
    if (latestCache.id && Date.now() - latestCache.at < LATEST_TTL) return { id: latestCache.id, from: 'latest' }
    try {
      const id = await findLatestSession()
      if (id) latestCache = { id, at: Date.now() }
      return { id, from: 'latest' }
    } catch (e) {
      return { id: latestCache.id, from: 'latest' }
    }
  }

  function promptAndWait(text, wantSession, wantCwd) {
    return new Promise((resolve, reject) => {
      const sc = ctx.get('sessionController')
      let finished = false
      let off = () => {}
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        off()
        reject(new Error('等回复超时（' + Math.round(Number(cfg.timeoutMs || 900000) / 60000) + ' 分钟）：这一轮跑太久了，回复还是会在对话里出来'))
      }, cfg.timeoutMs)

      ;(async () => {
        const id = await resolveSession(wantSession)
        // 这一轮由桥自己接管：等回来 /say 那边已经调 speak 了，
        // 全局那个「手动打字也念」的监听要让开，不然一句话念两遍。
        bridgePending.add(id)
        const seen = []
        off = ctx.on('session/event', (session, event) => {
          try {
            if (finished || sidOf(session) !== id) return
            if (event.type === 'assistant/message') {
              const t = textOfMessage(event.data && event.data.message && event.data.message.content)
              if (t && t.trim()) seen.push(t)
            } else if (event.type === 'turn/end') {
              finished = true
              clearTimeout(timer)
              off()
              bridgePending.delete(id)
              resolve({ sessionId: id, reply: seen.length ? seen[seen.length - 1] : '' })
            }
          } catch (e) {}
        })
        await sc.prompt(
          {
            requestId: 'voice-bridge-' + Date.now() + '-' + Math.random().toString(16).slice(2),
            sessionId: id,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          AbortSignal.timeout(cfg.timeoutMs),
        )
      })().catch((e) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        off()
        for (const id of bridgePending) bridgePending.delete(id)
        reject(e)
      })
    })
  }

  /**
   * 有些引擎（SAPI）不报 audio_sec，只给一个 wav 文件。气泡要按真实长度弹，
   * 就自己从 RIFF 头里算：byteRate 和 data 块大小一比就是时长。
   */
  function audioSecOf(out) {
    if (out && Number(out.audioSec) > 0) return Number(out.audioSec)
    const file = out && out.file
    if (!file || !/\.wav$/i.test(file)) return 0
    try {
      const buf = fs.readFileSync(file)
      let pos = 12
      let byteRate = 0
      let dataSize = 0
      while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4)
        const size = buf.readUInt32LE(pos + 4)
        if (id === 'fmt ' && pos + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 16)
        else if (id === 'data') {
          dataSize = size
          break
        }
        pos += 8 + size + (size % 2)
      }
      if (byteRate > 0 && dataSize > 0) return dataSize / byteRate
    } catch (e) {}
    return 0
  }
  async function speak(text, opts = {}) {
    if (!text) return null
    const body = shortForSpeech(text, cfg.speakMaxChars)
    if (!body) return null
    // 总开关：输出关着就一句都不念（气泡也不弹）。这是硬开关，
    // 不是「少念一点」—— 面板上关掉时「朗读」整块都会收起来。
    if (!cfg.outputEnabled) {
      logLine('语音输出关着（总开关），这句不念：' + body.slice(0, 24))
      return { text: body, skipped: 'output-off' }
    }
    // 交给桌宠念：只递台词、先不显示（duration 0）。pet-voice 那边会先合成，
    // 拿到真实音频长度再弹气泡 —— 这样字出来的时候正好开口，念完正好消失。
    // 只有「会被桌宠念成同一个声音」时才交给它：桌宠那边只会用本地模型，
    // 一旦指定了 edge / openai / sapi，就得桥自己念，不然选的声音等于白选。
    const petSoundsSame = !cfg.ttsProvider || cfg.ttsProvider === 'auto' || cfg.ttsProvider === 'local'
    if (cfg.letPetSpeak && petSoundsSame && !opts.forceSelf) {
      const handoff = await petSay(body, false, 0)
      if (handoff && handoff.ok) {
        logLine('台词递给桌宠，由它开口：' + body.slice(0, 24))
        return { text: body, pet: handoff, byPet: true }
      }
    }
    // 自己念：先合成拿到音频长度，按长度弹气泡，再播 —— 同样对齐，不抢跑。
    // anim:false 是给 pet-voice 的信号：这条已经有人念了，只显示、别再念一遍。
    // 气泡的 duration 只是保险，真正的收尾靠播完之后 petClear()：
    // 音频比算出来的长度长一点（设备启动、尾音）也不会被倒计时提前收走。
    const out = await tts.synthWithFallback(body, cfg)
    const sec = audioSecOf(out)
    const ms = sec > 0 ? Math.round(sec * 1000) + 1500 : undefined
    const pet = await petSay(body, false, ms, false)
    if (out && out.file) {
      // 等字先画到屏幕上再开口（宿主写 state → 客户端长轮询 → React 渲染 要几帧），
      // 不然就是「声音先到、气泡后到」。
      setTimeout(() => {
        playOnServer(out.file).then((played) => {
          if (played && played.ok) petClear()
        })
      }, 380)
    }
    return out ? Object.assign({}, out, { text: body, pet }) : { text: body, pet }
  }

  /**
   * 手动打字的那一轮：桥没参与，也就没人调 speak。这里盯着所有会话的事件，
   * 等一轮结束时把最后一条助手文本念出来 —— 只在面板里开了「手动打字的回复也念」时生效。
   * 跳过：桥自己正在等的那一轮（/say 那边会念）、子会话（子智能体 / fork）、别的目录的会话。
   */
  ctx.effect(
    () => {
      const off = ctx.on('session/event', (session, event) => {
        try {
          if (!cfg.speakTypedReplies || !event) return
          const id = sidOf(session)
          if (!id) return
          if (event.type === 'assistant/message') {
            const t = textOfMessage(event.data && event.data.message && event.data.message.content)
            if (t && t.trim()) {
              if (typedSeen.size > 100) typedSeen.clear() // 兜底：别为疑难事件攒内存
              typedSeen.set(id, t)
            }
            return
          }
          if (event.type !== 'turn/end') return
          const text = typedSeen.get(id)
          typedSeen.delete(id)
          if (!text || bridgePending.has(id)) return
          if (session && typeof session === 'object') {
            if (session.parentSessionId || session.origin === 'subagent') return
            if (session.cwd && normPath(session.cwd) !== normPath(cfg.cwd)) return
          }
          typedChain = typedChain
            .then(() => speak(text))
            .catch((e) => logLine('念手动回复失败：' + String((e && e.message) || e)))
        } catch (e) {}
      })
      return () => {
        try {
          if (typeof off === 'function') off()
        } catch (e) {}
      }
    },
    'voice-bridge: typed replies',
  )

  /**
   * 播一个 wav：优先让本地 TTS 服务在自己进程里播（POST /play）——
   * 这样不另起进程、不闪控制台窗口；服务不支持 /play 再退回本地 spawn。
   * 不用 await：调用方通常只想立刻返回；要确认放没放出来的话，await 它拿 {ok}。
   */
  function playOnServer(file) {
    const base = String(cfg.ttsUrl || '').replace(/\/+$/, '')
    if (!(base && file)) {
      playFile(file)
      return Promise.resolve({ ok: false, via: 'local-spawn' })
    }
    return fetch(base + '/play', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ file }),
      signal: AbortSignal.timeout(180000),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((out) => {
        if (out && out.ok) return { ok: true, via: 'tts-server' }
        playFile(file)
        return { ok: false, via: 'local-spawn', error: (out && out.error) || 'play 没成功' }
      })
      .catch((e) => {
        playFile(file)
        return { ok: false, via: 'local-spawn', error: String((e && e.message) || e) }
      })
  }

  /** 桌宠配置文件（dsh-pet 的宠物清单，JSONC 带注释） */
  function petConfigFile() {
    return path.join(homeDir(), 'dsh-pet', 'main-config.jsonc')
  }

  /** JSONC 去注释后解析；读不出来就空对象 */
  function readPetConfig() {
    try {
      const raw = fs.readFileSync(petConfigFile(), 'utf8')
      const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '')
      const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '')
      return JSON.parse(noLine)
    } catch (e) {
      return {}
    }
  }

  /** 要发到哪只宠物：面板写了就用面板的，否则取容器里第一只 */
  function petIdNow() {
    if (cfg.petId) return cfg.petId
    const conf = readPetConfig()
    const list = Array.isArray(conf.pets) ? conf.pets : []
    const first = list.find((p) => p && typeof p.id === 'string' && p.id)
    return first ? first.id : 'main'
  }

  /** dsh-pet 的路由挂在同一个本机 web 服务上 */
  function petOrigin() {
    if (cfg.petUrl) return cfg.petUrl
    try {
      return ctx.webServer.getOrigin()
    } catch (e) {
      return ''
    }
  }

  /** 一句话大概念多久（毫秒）：给气泡定时长，别让它先消失了 */
  function bubbleDuration(text) {
    const n = Array.from(String(text || '')).length
    return Math.min(Math.max(2500, 900 + n * 220), 20000)
  }

  /**
   * 把文本丢给桌宠气泡：POST /dsh-pet-7340/broadcast?pet=&surface=any
   * surface 用 any —— 宠物显示在网页、桌面还是两端都行，这里不挑。
   * durMs 传 0 表示「只递台词、先别显示」，让念的一方按真实音频长度再弹气泡。
   * anim 传 false 表示「这条已经有人念了，只显示、别再念」。
   * 失败只记日志，绝不影响朗读。
   */
  async function petSay(text, force, durMs, anim) {
    if (!cfg.petSync && !force) return null
    const body = String(text || '').trim()
    if (!body) return null
    const origin = petOrigin()
    if (!origin) {
      petLast = { at: Date.now(), ok: false, reason: '拿不到本机端口' }
      return petLast
    }
    const id = petIdNow()
    const url = origin + '/dsh-pet-7340/broadcast?pet=' + encodeURIComponent(id) + '&surface=any'
    const duration = typeof durMs === 'number' && durMs >= 0 ? durMs : bubbleDuration(body)
    const payload = { text: body, duration }
    if (anim === false) payload.anim = false
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),

        signal: AbortSignal.timeout(3000),
      })
      const out = await r.json().catch(() => ({}))
      if (out && out.ok) {
        petLast = { at: Date.now(), ok: true, petId: id, text: body.slice(0, 40) }
        return petLast
      }
      petLast = { at: Date.now(), ok: false, petId: id, reason: (out && (out.reason || out.message)) || ('HTTP ' + r.status) }
      logLine('桌宠没接住：' + petLast.reason)
      return petLast
    } catch (e) {
      petLast = { at: Date.now(), ok: false, petId: id, reason: String((e && e.message) || e) }
      logLine('桌宠没接住：' + petLast.reason)
      return petLast
    }
  }

  /**
   * 收掉桌宠的说话气泡：POST /dsh-pet-7340/bubble/clear?pet=&surface=any
   * 幂等（本来没气泡也回 ok），只收说话气泡，不动余额/工作状态那些。
   * 用它替代「靠 duration 倒计时收」—— 倒计时从客户端收到那一刻起算，
   * 和真正的播放进度对不齐，会「还没念完气泡就没了」。
   */
  async function petClear() {
    const origin = petOrigin()
    if (!origin) return false
    const id = petIdNow()
    const url = origin + '/dsh-pet-7340/bubble/clear?pet=' + encodeURIComponent(id) + '&surface=any'
    try {
      const r = await fetch(url, { method: 'POST', body: '', signal: AbortSignal.timeout(3000) })
      const out = await r.json().catch(() => ({}))
      return !!(out && out.ok)
    } catch (e) {
      return false
    }
  }

  async function ttsHealth() {
    return tts.healthAll(cfg)
  }

  const routes = []
  function route(p, handler) {
    routes.push(ctx.webServer.register({ kind: 'exact', path: p, handler }))
  }

  route('/dsh-voice-bridge/say', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是 JSON' })
    }
    const text = body && typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return json(res, 400, { ok: false, error: 'text 不能为空' })
    if (busy) return json(res, 429, { ok: false, error: '上一句还在处理，等它说完' })
    busy = true
    last.at = Date.now()
    last.text = text
    try {
      const out = await promptAndWait(text, body.sessionId, body.cwd)
      const reply = out.reply
      last.reply = reply
      let spoke = null
      if (cfg.speakReply) {
        try {
          spoke = await speak(reply)
        } catch (e) {
          logLine('朗读失败：' + String((e && e.message) || e))
        }
      }
      logLine('say ok len=' + text.length + ' -> ' + out.sessionId + ' reply=' + String(reply || '').slice(0, 60).replace(/\n/g, ' '))
      json(res, 200, { ok: true, sessionId: out.sessionId, sessionFrom: lastSrc, reply, spoke })
    } catch (e) {
      logLine('say 失败：' + String((e && e.stack) || e))
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    } finally {
      busy = false
    }
  })

  route('/dsh-voice-bridge/status', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    const cur = await peekSession()
    json(res, 200, {
      ok: true,
      sessionMode: modeOf(),
      sessionId: cur.id || null,
      sessionFrom: cur.from,
      fixedSessionId: cfg.sessionId || '',
      busy,
      cwd: cfg.cwd,
      speakReply: cfg.speakReply,
      speakTypedReplies: cfg.speakTypedReplies,
      petSync: cfg.petSync,
      petId: petIdNow(),
      petUrl: petOrigin(),
      letPetSpeak: cfg.letPetSpeak,
      petLast,
      recordKeepDays: Number(cfg.recordKeepDays) || 0,
      recordDir: recordDirNow(),
      recordStats: recordStats(),
      recordLast,
      ttsUrl: cfg.ttsUrl,
      autoStartTts: cfg.autoStartTts,
      ttsPaths: ttsPaths(),
      ttsProvider: cfg.ttsProvider,
      ttsVoice: cfg.ttsVoice,
      ttsChain: cfg.ttsChain,
      tts: await ttsHealth(),
      sttEngine: cfg.sttEngine,
      sttLanguage: cfg.sttLanguage,
      inputEnabled: cfg.inputEnabled !== false,
      outputEnabled: cfg.outputEnabled !== false,
      stt: sttInfo(),
      hotkey: readVoiceConfig().hotkey || '',
      voiceMode: readVoiceConfig().mode || 'hold',
      triggerMode: readVoiceConfig().trigger_mode === 'wakeword' ? 'wakeword' : 'hotkey',
      wakeWords: String(readVoiceConfig().wake_words || ''),
      wakeReply: String(readVoiceConfig().wake_reply || ''),
      wakePose: String(readVoiceConfig().wake_pose || ''),
      wakeSilenceSec: Number(readVoiceConfig().wake_silence_sec || 3),
      wakeMaxSec: Number(readVoiceConfig().wake_max_sec || 30),
      voiceConfig: voiceFile(),
      lastAt: last.at,
      lastText: last.text.slice(0, 200),
      lastReply: last.reply.slice(0, 200),
      logFile,
      configFile: configFile(),
      version: '0.1.0',
    })
  })

  route('/dsh-voice-bridge/config', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, config: cfg, file: configFile() })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET / POST' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是 JSON' })
    }
    try {
      const prevKeep = Number(cfg.recordKeepDays)
      const prevEngine = String(cfg.sttEngine || '')
      const saved = saveConfig(body || {})
      Object.assign(cfg, resolveConfig(rowConfig))
      stickyId = null // 配置变了，会话也重新解析
      latestCache = { id: null, at: 0 }
      logLine('config 更新：' + JSON.stringify(saved))
      syncInputFlag()
      // 从本地 FunASR 切回官方：重启 voice-in 把已经装进进程的模型放掉
      let restarted = false
      if (prevEngine === 'funasr' && String(cfg.sttEngine || '') === 'official') {
        restarted = restartVoiceIn('切回官方识别')
      }
      // 触发方式/唤醒词住在 voice config 里，但面板只有底部一个「保存」——
      // 所以这里也接一手，别让人以为保存了却没写进去。
      let wake = null
      try {
        const w = applyWakePatch(body)
        if (w.touched) wake = w.view
        if (w.restarted) restarted = true
      } catch (e) {
        return json(res, 400, { ok: false, error: String((e && e.message) || e) })
      }
      // 天数被改小了，就立刻按新天数清一次（改大/不改不动手）
      if (Number.isFinite(prevKeep) && Number(cfg.recordKeepDays) > 0 && Number(cfg.recordKeepDays) < prevKeep) {
        try {
          sweepRecordings('改小保留天数')
        } catch (e) {}
      }
      json(res, 200, { ok: true, config: cfg, restarted, wake })
    } catch (e) {
      json(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-voice-bridge/log', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const n = Math.min(Math.max(Number(url.searchParams.get('lines')) || 60, 1), 500)
    let lines = []
    try {
      lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-n)
    } catch (e) {
      lines = ['（还没有日志：' + logFile + '）']
    }
    json(res, 200, { ok: true, lines, file: logFile })
  })

  route('/dsh-voice-bridge/speak-test', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    let body = {}
    try {
      body = await readBody(req)
    } catch (e) {}
    try {
      // 试听必须自己念：要听到的是「你选的引擎 + 你选的音色」，

      // 不能因为开着「让桌宠来念」就被递过去、最后听到本地模型的声音。

      const out = await speak(body.text || '哦鲸鲸，语音桥通了。', { forceSelf: true })
      json(res, 200, { ok: true, tts: out })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-voice-bridge/pet-test', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    let body = {}
    try {
      body = await readBody(req)
    } catch (e) {}
    const text = String((body && body.text) || '').trim() || '哦鲸鲸，桌宠气泡通了。'
    const out = await petSay(text, true)
    json(res, 200, { ok: !!(out && out.ok), petId: petIdNow(), result: out })
  })

  // 点播一段桌宠动画（比如喊醒时摆个「立正」）。名字必须在桌宠自己的动画池里，
  // 所以这里不猜、原样透传，桌宠认不出来会回 unknown-animation，我们照实转发。
  route('/dsh-voice-bridge/pet-anim', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    let body = {}
    try {
      body = await readBody(req)
    } catch (e) {}
    const name = String((body && body.name) || '').trim()
    if (!name) return json(res, 400, { ok: false, error: '要给动画名（桌宠配置里的动作名）' })
    const origin = petOrigin()
    if (!origin) return json(res, 500, { ok: false, error: '拿不到 DSH 的地址，没法点播动画' })
    const id = petIdNow()
    try {
      const r = await fetch(
        origin + '/dsh-pet-7340/anim?pet=' + encodeURIComponent(id) + '&surface=any',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(3000),
        },
      )
      const data = await r.json().catch(() => ({}))
      if (!data || data.ok === false) logLine('桌宠姿势没播成（' + name + '）：' + ((data && data.reason) || r.status))
      json(res, 200, { ok: !!(data && data.ok), petId: id, name, result: data })
    } catch (e) {
      logLine('桌宠姿势没播成（' + name + '）：' + String((e && e.message) || e))
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-voice-bridge/tts/providers', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const provider = url.searchParams.get('provider') || ''
    json(res, 200, {
      ok: true,
      current: cfg.ttsProvider,
      chain: String(cfg.ttsChain || '').split(',').filter(Boolean),
      providers: await tts.healthAll(cfg),
      voices: provider ? tts.listVoices(provider) : {},
    })
  })

  route('/dsh-voice-bridge/tts/probe', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    let body = {}
    try {
      body = await readBody(req)
    } catch (e) {}
    try {
      const t0 = Date.now()
      const provider = body.provider || (cfg.ttsProvider === 'auto' ? 'local' : cfg.ttsProvider)
      const out = await tts.synthOne(provider, body.text || '哦鲸鲸，试个音。', Object.assign({}, cfg, {
        ttsVoice: body.voice || cfg.ttsVoice,
        ttsSpeed: body.speed || cfg.ttsSpeed,
      }))
      // 别用 playFile：那是 spawn 一个 python 进程（会闪一下控制台窗口），
    // 而且 mp3 交给 winsound 放不出来 —— edge 试听没声音就是这个原因。
    // 统一交给本地 TTS 服务在自己进程里播，它会把 mp3 转成 wav 再响。
    const play = out && out.file ? await playOnServer(out.file) : { ok: false, via: 'none' }
    json(res, 200, {
      ok: true,
      provider: out && out.provider,
      voice: out && out.voice,
      file: out && out.file,
      play,
      ms: Date.now() - t0,
    })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  function voiceFile() {
    // 空配置 = 跟着工作区走，不写死任何绝对路径
    return cfg.voiceConfig || path.join(cfg.cwd || process.cwd(), 'voice', 'config.json')
  }

  function readVoiceConfig() {
    try {
      return JSON.parse(fs.readFileSync(voiceFile(), 'utf8'))
    } catch (e) {
      return {}
    }
  }

  /**
   * 把「语音输入」总开关同步给 voice-in.py。
   *
   * voice-in 读的是 voice\config.json（和热键、唤醒词同一个文件，它每 1.5 秒比一次
   * mtime 自己热更新），所以总开关也写进那里，不额外开一条 IPC —— 开关关掉后它
   * 会自己解绑热键、停掉唤醒监听；打开会自己接回去。
   */
  function syncInputFlag() {
    try {
      const cur = readVoiceConfig()
      const want = cfg.inputEnabled !== false
      if (cur.input_enabled === want) return
      cur.input_enabled = want
      fs.mkdirSync(path.dirname(voiceFile()), { recursive: true })
      fs.writeFileSync(voiceFile(), JSON.stringify(cur, null, 2), 'utf8')
      logLine('语音输入总开关 -> ' + (want ? '开' : '关') + '（写进 ' + voiceFile() + '）')
    } catch (e) {
      logLine('同步语音输入总开关失败：' + String((e && e.message) || e))
    }
  }

  // ---- F8 录音清理 ----------------------------------------------------------
  // voice-in.py 每说一句就落一个 voice\in\in-<毫秒>.wav，只增不减会慢慢长胖。
  // 启动时（以及面板里改过天数后）按 recordKeepDays 删掉更早的，0 = 不清理。
  function recordDirNow() {
    const custom = (cfg.recordDir || '').trim()
    if (custom) return custom
    try {
      return path.join(path.dirname(path.resolve(voiceFile())), 'in')
    } catch (e) {
      return path.join(process.cwd(), 'voice', 'in')
    }
  }

  function recordStats() {
    const dir = recordDirNow()
    const out = { dir, keepDays: Number(cfg.recordKeepDays) || 0, count: 0, mb: 0, oldest: null }
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch (e) {
      return out
    }
    for (const name of names) {
      if (!/\.wav$/i.test(name)) continue
      const full = path.join(dir, name)
      try {
        const st = fs.statSync(full)
        if (!st.isFile()) continue
        out.count += 1
        out.mb += st.size
        if (!out.oldest || st.mtimeMs < out.oldest) out.oldest = st.mtimeMs
      } catch (e) {}
    }
    out.mb = Math.round((out.mb / 1048576) * 10) / 10
    return out
  }

  /** 删掉 keepDays 之前的录音；返回 {keepDays, dir, deleted, freedMb, ...} */
  function sweepRecordings(why) {
    const dir = recordDirNow()
    const keepDays = Number(cfg.recordKeepDays)
    const res = { at: Date.now(), why: why || '', dir, keepDays: keepDays || 0, deleted: 0, freedMb: 0, error: '' }
    if (!Number.isFinite(keepDays) || keepDays <= 0) {
      res.skipped = '保留天数为 0，不清理'
      recordLast = res
      return res
    }
    const cutoff = Date.now() - keepDays * 86400000
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch (e) {
      res.error = '录音目录打不开：' + String((e && e.message) || e)
      recordLast = res
      return res
    }
    let freed = 0
    for (const name of names) {
      if (!/\.wav$/i.test(name)) continue
      const full = path.join(dir, name)
      try {
        const st = fs.statSync(full)
        if (!st.isFile() || st.mtimeMs >= cutoff) continue
        fs.unlinkSync(full)
        res.deleted += 1
        freed += st.size
      } catch (e) {
        res.error = '删不掉 ' + name + '：' + String((e && e.message) || e)
      }
    }
    res.freedMb = Math.round((freed / 1048576) * 100) / 100
    recordLast = res
    if (res.deleted > 0) {
      logLine('清理录音（' + (why || '手动') + '）：删了 ' + res.deleted + ' 个、' + res.freedMb + ' MB（保留 ' + keepDays + ' 天）：' + dir)
    } else {
      logLine('清理录音（' + (why || '手动') + '）：没有超过 ' + keepDays + ' 天的，目录 ' + dir)
    }
    return res
  }

  route('/dsh-voice-bridge/hotkey', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method === 'GET') {
      const v = readVoiceConfig()
      return json(res, 200, { ok: true, hotkey: v.hotkey || '', mode: v.mode || '', file: voiceFile() })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET / POST' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是 JSON' })
    }
    const hotkey = String((body && body.hotkey) || '').trim().toLowerCase()
    if (!/^[a-z0-9+\-]{1,40}$/.test(hotkey)) {
      return json(res, 400, { ok: false, error: '热键只能由字母、数字、+ 和 - 组成，比如 f8 / ctrl+alt+v' })
    }
    const mode = body.mode === 'toggle' ? 'toggle' : body.mode === 'hold' ? 'hold' : undefined
    try {
      const cur = readVoiceConfig()
      cur.hotkey = hotkey
      if (mode) cur.mode = mode
      fs.mkdirSync(path.dirname(voiceFile()), { recursive: true })
      fs.writeFileSync(voiceFile(), JSON.stringify(cur, null, 2), 'utf8')
      logLine('热键写入 ' + voiceFile() + ' -> ' + hotkey + (mode ? ' (' + mode + ')' : ''))
      json(res, 200, {
        ok: true,
        hotkey,
        mode: cur.mode || 'hold',
        file: voiceFile(),
        note: '语音输入进程会在 2 秒内自己换键，不用重启',
      })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  // ---- 触发方式与唤醒词（存在 voice\config.json，voice-in.py 每 1.5s 比 mtime 自己更新）----
  // 触发方式与唤醒词都存在 voice\config.json 里（voice-in.py 每 1.5s 比 mtime 自己读）。
  // 面板上有两处保存（大保存 / 触发方式），都走这一个写入函数，免得各写一半对不上。
  function wakeView(v) {
    return {
      ok: true,
      triggerMode: v.trigger_mode === 'wakeword' ? 'wakeword' : 'hotkey',
      wakeWords: String(v.wake_words || ''),
      wakeReply: String(v.wake_reply || ''),
      wakePose: String(v.wake_pose || ''),
      wakeSilenceSec: Number(v.wake_silence_sec || 3),
      wakeMaxSec: Number(v.wake_max_sec || 30),
      hotkey: String(v.hotkey || ''),
      mode: String(v.mode || 'hold'),
      file: voiceFile(),
    }
  }

  function badInput(msg) {
    const e = new Error(msg)
    e.badInput = true
    return e
  }

  /** 把面板上的触发方式/唤醒词写进 voice config；没带这些字段就当没发生 */
  function applyWakePatch(body) {
    const cur = readVoiceConfig()
    const prev = cur.trigger_mode === 'wakeword' ? 'wakeword' : 'hotkey'
    const trigger = String((body && body.triggerMode) || '').trim().toLowerCase()
    if (trigger && trigger !== 'hotkey' && trigger !== 'wakeword') {
      throw badInput('触发方式只能是 hotkey（热键）或 wakeword（唤醒词）')
    }
    let touched = false
    if (trigger) {
      cur.trigger_mode = trigger
      touched = true
    }
    if (body && body.wakeWords != null) {
      cur.wake_words = String(body.wakeWords).trim()
      touched = true
    }
    if (body && body.wakeReply != null) {
      cur.wake_reply = String(body.wakeReply).trim()
      touched = true
    }
    // 应答时摆的姿势（桌宠动画名）；留空 = 不摆
    if (body && body.wakePose != null) {
      cur.wake_pose = String(body.wakePose).trim()
      touched = true
    }
    if (body && body.wakeSilenceSec != null) {
      const n = Number(body.wakeSilenceSec)
      if (!Number.isFinite(n) || n < 1 || n > 60) throw badInput('停顿秒数要在 1 ~ 60 之间')
      cur.wake_silence_sec = n
      touched = true
    }
    if (body && body.wakeMaxSec != null) {
      const n = Number(body.wakeMaxSec)
      if (!Number.isFinite(n) || n < 5 || n > 300) throw badInput('最长录音要在 5 ~ 300 秒之间')
      cur.wake_max_sec = n
      touched = true
    }
    if (!touched) return { touched: false, restarted: false, view: wakeView(cur) }
    fs.mkdirSync(path.dirname(voiceFile()), { recursive: true })
    fs.writeFileSync(voiceFile(), JSON.stringify(cur, null, 2), 'utf8')
    const nowTrigger = cur.trigger_mode === 'wakeword' ? 'wakeword' : 'hotkey'
    logLine(
      '语音输入设置写入 ' + voiceFile() + ' -> ' + nowTrigger +
        (nowTrigger === 'wakeword' ? '（唤醒词 ' + (cur.wake_words || '') + '，应答 ' + (cur.wake_reply || '无') + '，停顿 ' + cur.wake_silence_sec + 's）' : ''),
    )
    // 换「触发方式」是换监听方式（热键 ↔ 常开麦），只能重启进程；
    // 唤醒词/应答/停顿是每轮现读的，不用重启。
    let restarted = false
    if (prev !== nowTrigger) restarted = restartVoiceIn('切换触发方式为 ' + (nowTrigger === 'wakeword' ? '唤醒词' : '热键'))
    return { touched: true, restarted, view: wakeView(cur) }
  }

  route('/dsh-voice-bridge/wake', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method === 'GET') return json(res, 200, wakeView(readVoiceConfig()))
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET / POST' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是 JSON' })
    }
    try {
      const r = applyWakePatch(body)
      json(res, 200, Object.assign({}, r.view, { restarted: r.restarted }))
    } catch (e) {
      json(res, e && e.badInput ? 400 : 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-voice-bridge/records', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, stats: recordStats(), last: recordLast })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET / POST' })
    try {
      const r = sweepRecordings('面板手动')
      json(res, 200, { ok: true, result: r, stats: recordStats() })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  // ---- 本地 TTS 的「跟着 DSH 一起起来」------------------------------------
  // DSH 重启时，之前由插件/终端拉起的子进程不一定还在；但人不会记得再手动起一次，
  // 表现就是「每次重启都没声音」。所以插件自己带一个拉起动作，面板上也有按钮。
  function ttsPaths() {
    const base = cfg.cwd || process.cwd()
    const python =
      cfg.ttsPython ||
      path.join(base, 'tts', 'venv', 'Scripts', process.platform === 'win32' ? 'pythonw.exe' : 'python3')
    const watchdog = cfg.ttsWatchdog || path.join(base, 'voice', 'sup.py')
    return { python, watchdog, cwd: path.dirname(watchdog) }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /**
   * 让 voice-in.py 重启一次（不返回 Promise：杀完就走，看门狗会把它拉回来）。
   *
   * 为什么需要它：切到本地 FunASR 时 voice-in 会把模型热加载进自己进程，
   * 切回官方时 Python 没有「把模型还回去」的路径 —— 只能重启进程才释放那 800 多 MB。
   * 只认 python/pythonw 进程，且命令行里必须含 voice-in.py：直接按子串杀会误伤
   * 命令行里恰好带着这串字的终端/编辑器（README 里记过这个坑）。
   */
  function restartVoiceIn(why) {
    try {
      const script =
        "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*voice-in.py*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      })
      ps.on('error', (e) => logLine('重启 voice-in 失败：' + String((e && e.message) || e)))
      logLine('重启 voice-in（' + (why || '手动') + '）：它已经把本地识别模型装进去了，只能重启才还回来')
      return true
    } catch (e) {
      logLine('重启 voice-in 失败：' + String((e && e.message) || e))
      return false
    }
  }

  /** 本地 TTS 不在就拉起来（幂等：已经在跑就什么都不做） */
  async function startTts(why) {
    const h = await tts.health('local', cfg).catch(() => null)
    if (h && h.ok) return { started: false, already: true }
    const { python, watchdog, cwd } = ttsPaths()
    if (!fs.existsSync(python)) throw new Error('找不到解释器：' + python)
    if (!fs.existsSync(watchdog)) throw new Error('找不到看门狗脚本：' + watchdog)
    const child = spawn(python, [watchdog], { cwd, detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (e) => logLine('拉起本地 TTS 失败：' + String((e && e.message) || e)))
    child.unref()
    logLine('本地 TTS 没在跑（' + (why || '自动') + '），已经拉起来：' + watchdog)
    // 模型加载要 40~60 秒，别让它一直显示「没在跑」
    ;(async () => {
      for (let i = 0; i < 30; i++) {
        await sleep(3000)
        const r = await tts.health('local', cfg).catch(() => null)
        if (r && r.ok) {
          logLine('本地 TTS 起来了（等了 ' + (i + 1) * 3 + ' 秒）')
          return
        }
      }
      logLine('看门狗拉起来了，但 90 秒内还没等到 TTS 健康检查通过（看 voice\\logs\\sup.log）')
    })()
    return { started: true, python, watchdog }
  }

  route('/dsh-voice-bridge/start-tts', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    try {
      const r = await startTts('面板手动')
      json(res, 200, Object.assign({ ok: true }, r, { paths: ttsPaths() }))
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  // 识别：把一段 wav 交给官方的 speechToText 服务（SenseVoice int8 ONNX）。
  // 我们不自己装识别模型 —— 宿主里已经有一份了，还自带标点，也不吃 GPU。
  function sttService() {
    try {
      return ctx.get ? ctx.get('speechToText') : null
    } catch (e) {
      return null
    }
  }

  /** 面板要看的识别器状态：哪个 provider、模型到哪一步了（同步调用，出错也不抛） */
  function sttInfo() {
    const stt = sttService()
    if (!stt) return { ok: false, error: '宿主里没有 speechToText 服务（官方语音输入插件没加载）' }
    try {
      const snap = stt.snapshot() || {}
      const sel = snap.selection || {}
      const prov = (snap.providers || []).find((p) => p && p.id === sel.providerId) || snap.provider || null
      return {
        ok: true,
        providerId: sel.providerId || (prov && prov.id) || '',
        name: (prov && (prov.name || prov.label)) || '',
        language: sel.language || '',
        phase: snap.phase || '',
        languages: (prov && prov.languages) || [],
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  async function transcribeFile(file, language) {
    const stt = sttService()
    if (!stt) throw new Error('宿主里没有 speechToText 服务（官方语音输入插件没加载）')
    const wav = fs.readFileSync(file)
    const lang = String(language || cfg.sttLanguage || 'auto')
    const spec = stt.resolve({ audio: new Uint8Array(wav), language: lang })
    const out = await stt.transcribe(spec, AbortSignal.timeout(120000))
    // spec 不保证带 providerId，回包里补一手（谁真念的这条，日志里要能看出来）
    let providerId = (spec && spec.providerId) || ''
    if (!providerId) {
      try {
        const snap = stt.snapshot()
        providerId = (snap && snap.selection && snap.selection.providerId) || (snap && snap.provider && snap.provider.id) || ''
      } catch (e) {}
    }
    return {
      text: String((out && out.text) || '').trim(),
      audioSeconds: out && out.audioSeconds,
      inferenceSeconds: out && out.inferenceSeconds,
      providerId,
      language: lang,
    }
  }

  // POST /dsh-voice-bridge/transcribe { file } 或 { audio: <base64 wav> }，可选 { language }
  route('/dsh-voice-bridge/transcribe', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是 JSON' })
    }
    if (cfg.sttEngine !== 'official') {
      return json(res, 200, { ok: false, engine: cfg.sttEngine, error: '识别引擎设成了本地 FunASR，交给 voice-in.py 自己识别' })
    }
    let file = ''
    let tmp = ''
    try {
      if (body && body.file) file = String(body.file).trim()
      else if (body && body.audio) {
        tmp = path.join(os.tmpdir(), 'vb-stt-' + Date.now() + '.wav')
        fs.writeFileSync(tmp, Buffer.from(String(body.audio), 'base64'))
        file = tmp
      }
      if (!file || !fs.existsSync(file)) return json(res, 200, { ok: false, error: '没有可用的 wav：' + file })
      const t0 = Date.now()
      const r = await transcribeFile(file, body && body.language)
      // 唤醒模式每 0.5 秒会拿短窗来问一次，没听出字的那种别刷日志（不然日志全是「0 字」）
      if (r.text) {
        logLine(
          '识别（官方 ' + (r.providerId || '?') + '）：' + r.text.length + ' 字 / 音频 ' +
            (r.audioSeconds || 0) + 's / 推理 ' + (r.inferenceSeconds || 0) + 's / 共 ' + (Date.now() - t0) + 'ms',
        )
      }
      json(res, 200, Object.assign({ ok: true, engine: 'official', file }, r))
    } catch (e) {
      json(res, 200, { ok: false, error: String((e && e.message) || e) })
    } finally {
      if (tmp) {
        try {
          fs.unlinkSync(tmp)
        } catch (e) {}
      }
    }
  })

  // 官方语音输入（宿主里的 speechToText 服务）探针：
  // 我们自己不装识别模型，直接问宿主「这段话说了什么」。
  // GET /dsh-voice-bridge/stt-test?file=<wav 绝对路径>
  route('/dsh-voice-bridge/stt-test', async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: '只允许本机访问' })
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' })
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    let stt = null
    try {
      stt = ctx.get ? ctx.get('speechToText') : null
    } catch (e) {
      stt = null
    }
    if (!stt) return json(res, 200, { ok: false, error: '宿主里没有 speechToText 服务（官方语音输入插件没加载）' })

    let snap = null
    try {
      snap = stt.snapshot()
    } catch (e) {
      snap = { error: String((e && e.message) || e) }
    }

    let file = String(u.searchParams.get('file') || '').trim()
    if (!file) {
      const dir = path.join(cfg.cwd || process.cwd(), 'voice', 'in')
      try {
        const list = fs
          .readdirSync(dir)
          .filter((n) => n.toLowerCase().endsWith('.wav'))
          .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
        if (list.length) file = path.join(dir, list[0].n)
      } catch (e) {}
    }
    if (!file || !fs.existsSync(file)) return json(res, 200, { ok: false, error: '没有可用的 wav：' + file, snap })

    const wav = fs.readFileSync(file)
    const attempts = []
    const tryOne = async (label, audio) => {
      try {
        const spec = stt.resolve({ audio, language: 'zh' })
        const t0 = Date.now()
        const out = await stt.transcribe(spec, AbortSignal.timeout(120000))
        return { label, ok: true, ms: Date.now() - t0, text: out && out.text, audioSeconds: out && out.audioSeconds, inferenceSeconds: out && out.inferenceSeconds }
      } catch (e) {
        const r = { label, ok: false, error: String((e && e.message) || e) }
        attempts.push(r)
        return r
      }
    }

    // 1) 直接喂 wav 文件字节（最可能的约定）
    let hit = await tryOne('wav-bytes', new Uint8Array(wav))
    // 2) 跳掉 44 字节 RIFF 头，只给 PCM
    if (!hit.ok && wav.length > 44) hit = await tryOne('pcm-int16', new Uint8Array(wav.subarray(44)))
    // 3) 转成 float32 采样再给
    if (!hit.ok) {
      const n = Math.floor((wav.length - 44) / 2)
      const f = new Float32Array(n)
      for (let i = 0; i < n; i++) f[i] = wav.readInt16LE(44 + i * 2) / 32768
      hit = await tryOne('pcm-f32', new Uint8Array(f.buffer))
    }

    json(res, 200, {
      ok: hit.ok,
      file,
      bytes: wav.length,
      hit,
      attempts,
      snap,
    })
  })

  // 画面上屏的探针：把这条 1x1 透明图当气泡配图塞给桌宠，
  // 客户端只有真的把气泡画出来才会来取它 —— 取到的那一下就是「字出来了」。
  route('/dsh-voice-bridge/beacon', async (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const t = Number(u.searchParams.get('t')) || 0
    const now = Date.now()
    beaconLast = { at: now, tag: t, lagMs: t ? now - t : null }
    try {
      logLine('beacon 收到（标 ' + t + '，距发出 ' + (t ? now - t : '?') + 'ms）')
    } catch (e) {}
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    res.writeHead(200, {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'content-length': gif.length,
    })
    res.end(gif)
  })

  ctx.effect(
    () => () => {
      for (const dispose of routes) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (e) {}
      }
    },
    'voice-bridge: routes',
  )

  logLine(
    '已加载：会话模式=' + modeOf() +
      (modeOf() === 'fixed' ? '（' + (cfg.sessionId || '没填，会新建') + '）' : '') +
      ' cwd=' + cfg.cwd + ' 自动朗读=' + cfg.speakReply +
      ' 总开关(输入/输出)=' + (cfg.inputEnabled !== false ? '开' : '关') + '/' + (cfg.outputEnabled !== false ? '开' : '关'),
  )

  // 把总开关同步给 voice-in（它自己会热读 voice\config.json）
  syncInputFlag()

  // 每次起来顺手清一次旧录音（recordKeepDays 天之前的）；0 = 不动
  setTimeout(() => {
    try {
      sweepRecordings('启动')
    } catch (e) {}
  }, 3000).unref?.()

  // 起来先体检一次：本地 TTS 不在的话，朗读和试听都会是「点了没声」。
  // autoStartTts 开着（默认）就顺手拉起来 —— DSH 重启别再让人手动补一刀。
  setTimeout(() => {
    tts
      .health('local', cfg)
      .then((h) => {
        if (h && h.ok) return
        if (!cfg.autoStartTts) {
          logLine(
            '没检测到本地 TTS 服务（' + cfg.ttsUrl + '）：朗读/试听会没声音。' +
              '把它起来，或者把引擎设成 edge-tts（云端，不需要本地服务）。',
          )
          return
        }
        return startTts('DSH 启动').catch((e) => {
          logLine('自启本地 TTS 失败：' + String((e && e.message) || e))
        })
      })
      .catch(() => {})
  }, 2500).unref?.()
}
