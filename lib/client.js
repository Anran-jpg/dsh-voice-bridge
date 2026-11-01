/**
 * dsh-voice-bridge · 浏览器半边：设置里的「语音桥」面板
 *
 * 数据流：面板 ⇄ 同源 fetch `/dsh-voice-bridge/*` ⇄ 主进程半边 ⇄ $DSH_HOME/voice-bridge/config.json
 * 只用宿主提供的 require("react")，不打包 React，避免版本打架。
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-voice-bridge'
    const NS = 'voice-bridge'

    const CSS = `
.vb-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 2px 40px;font-size:13px;line-height:1.6;max-width:880px}
.vb-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vb-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-bg-l2,#f4f5f7);font-size:12px;color:var(--dsw-alias-text-l2,#5c6370)}
.vb-chip strong{font-weight:600;color:var(--dsw-alias-text-l1,#2b2f36)}
.vb-card{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;padding:16px 18px;background:var(--dsw-alias-bg-l1,#fff);box-shadow:0 1px 2px rgba(0,0,0,.03)}
.vb-title{font-size:14px;font-weight:600;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);display:flex;align-items:center;gap:8px}
.vb-row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px 28px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,#eef0f3);flex-wrap:wrap}
.vb-row:last-child{border-bottom:none}
.vb-main{flex:1;min-width:220px}
.vb-label{font-size:13px;line-height:19px}
.vb-hint{color:var(--dsw-alias-text-l3,#8a8f98);margin-top:3px;font-size:11.5px;line-height:17px}
/* 控件一律靠右；一个设置里要放两个控件时，各占一行、都靠右 */
.vb-control{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:none;min-width:0}
.vb-control-line{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.vb-input{height:30px;min-width:180px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,#dcdcdc);border-radius:8px;font-size:13px;background:var(--dsw-alias-bg-l1,#fff);color:inherit;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}
.vb-input:focus{outline:none;border-color:#3b6ef6;box-shadow:0 0 0 3px rgba(59,110,246,.15)}
.w-xs{width:88px;flex:none}
.w-sm{width:150px;flex:none}
.w-md{width:230px;flex:none}
.w-lg{width:340px;max-width:100%;flex:none}
.vb-sub{color:var(--dsw-alias-text-l3,#8a8f98);font-size:12px}
.vb-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.vb-divider{height:1px;background:var(--dsw-alias-border-l1,#eef0f3);margin:14px 0 4px}
.vb-dirty{color:#e8a33d;font-size:12px}
.vb-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#dcdcdc);background:var(--dsw-alias-bg-l1,#fff);cursor:pointer;font-size:13px;color:inherit;transition:background .15s,border-color .15s}
.vb-btn:hover{background:var(--dsw-alias-bg-l3,#f0f0f0)}
.vb-btn[disabled]{opacity:.5;cursor:not-allowed}
.vb-btn.primary{background:#3b6ef6;border-color:#3b6ef6;color:#fff}
.vb-btn.primary:hover{background:#2f5fe0}
.vb-btn.tiny{height:26px;padding:0 10px;font-size:12px}
.vb-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.vb-ok{background:#2fb344}.vb-bad{background:#e5484d}.vb-idle{background:#bbb}
.vb-kv{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px 16px;align-items:baseline}
.vb-kv b{font-weight:500;color:var(--dsw-alias-text-l3,#8a8f98);font-size:12px}
.vb-kv span{color:var(--dsw-alias-text-l1,#2b2f36);word-break:break-word}
.vb-pre{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-l2,#fafafa);border-radius:8px;padding:10px}
.vb-err{color:#e5484d}
.vb-msg{color:#2fb344}
.vb-hint{color:var(--dsw-alias-text-l3,#8a8f98);font-size:12px;line-height:1.6}
.vb-warn{border:1px solid var(--dsw-alias-warning-l1,#f0c36d);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-l1,#fff);font-size:13px;line-height:1.7}
.vb-warn b{display:block;margin-bottom:4px}
.vb-warn code{font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-l2,#f5f5f5)}
.vb-engine{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#eee)}
.vb-engine:last-child{border-bottom:0}
.vb-engine .name{min-width:112px;font-weight:500}
.vb-engine .why{flex:1;color:var(--dsw-alias-text-l3,#8a8f98);font-size:12px}
.vb-tag{font-size:11px;padding:1px 7px;border-radius:6px;background:var(--dsw-alias-bg-l3,#f0f0f0);color:var(--dsw-alias-text-l2,#666);white-space:nowrap}
.vb-savebar{position:sticky;bottom:0;z-index:2;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-l1,#fff);box-shadow:0 -2px 12px rgba(0,0,0,.05)}
`

    function injectCss() {
      const tag = 'voice-bridge/settings.css'
      if (document.querySelector('style[data-plugin-css="' + tag + '"]') !== null) return
      const el = document.createElement('style')
      el.dataset.pluginCss = tag
      el.textContent = CSS
      document.head.appendChild(el)
    }

    async function api(method, path, body) {
      const res = await fetch(API + path, {
        method,
        headers: body ? { 'content-type': 'application/json; charset=utf-8' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    function fmtTime(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      return d.toLocaleTimeString('zh-CN', { hour12: false })
    }

    function Dot({ ok, idle }) {
      return h('span', { className: 'vb-dot ' + (idle ? 'vb-idle' : ok ? 'vb-ok' : 'vb-bad') })
    }

    function Field({ label, children }) {
      return h('div', { className: 'vb-row' }, h('div', { className: 'vb-label' }, label), children)
    }
    // 一行 = 一个设置：左边「标签 + 说明」上下两行（都左对齐），右边控件靠右；
    // 控件后面不放任何文字 —— 要说的话一律放到左边的说明行里。
    function Row({ label, hint, children }) {
      return h(
        'div',
        { className: 'vb-row' },
        h(
          'div',
          { className: 'vb-main' },
          h('div', { className: 'vb-label' }, label),
          hint ? h('div', { className: 'vb-hint' }, hint) : null,
        ),
        h('div', { className: 'vb-control' }, children),
      )
    }

    // 开关不用单选框：一律是「开 / 关」下拉，和别的控件同一种形状
    function Bool({ value, onChange, on = '开', off = '关' }) {
      return h(
        'select',
        { className: 'vb-input w-xs', value: value ? '1' : '0', onChange: (e) => onChange(e.target.value === '1') },
        h('option', { value: '1' }, on),
        h('option', { value: '0' }, off),
      )
    }

    // 状态和顶部条要展示「现在怎么触发」：唤醒词模式就得显示唤醒词，别显示那个没在用的热键
    function triggerText(mode, words, hotkey) {
      if (mode === 'wakeword') {
        const first = String(words || '大肥鱼').split(/[,，、;；\s]+/).filter(Boolean)[0] || '大肥鱼'
        return '喊「' + first + '」'
      }
      return String(hotkey || 'f8').toUpperCase()
    }

    const ENGINE_LABEL = {
      local: '本地TTS克隆音色',
      edge: 'edge-tts（免费·联网）',
      openai: 'OpenAI 兼容接口',
      sapi: 'Windows 系统语音',
    }

    const MODE_LABEL = {
      latest: '跟着最新会话走',
      fixed: '固定投给一个会话',
      new: '每次新建专属会话',
    }

    // 会话 id 太长，面板里只留头尾
    function shortSid(id) {
      if (!id) return ''
      const s = String(id)
      return s.length > 20 ? s.slice(0, 11) + '…' + s.slice(-6) : s
    }

    function VoiceBridgeSection() {
      const [status, setStatus] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [savedJson, setSavedJson] = useState('')
      const [log, setLog] = useState([])
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const [hk, setHk] = useState('')
      const [hkMode, setHkMode] = useState('hold')
      const [trigger, setTrigger] = useState('hotkey')
      const [wakeWords, setWakeWords] = useState('大肥鱼')
      const [wakeReply, setWakeReply] = useState('在')
      const [wakePose, setWakePose] = useState('打瞌睡被惊醒')
      const [wakeSilence, setWakeSilence] = useState(3)
      const [wakeMax, setWakeMax] = useState(30)
      // 有没有没保存的改动。只要动过，下面的 loadStatus 就只更新只读状态，
      // 不再拿服务端的值覆盖表单 —— 否则正在改的那一格会被悄悄改回去。
      const dirtyRef = useRef(false)
      const [providers, setProviders] = useState(null)

      const loadStatus = useCallback(async () => {
        try {
          const s = await api('GET', '/status')
          setStatus(s)
          if (dirtyRef.current) return // 表单里有没保存的改动，别覆盖
          if (s && typeof s.hotkey === 'string' && s.hotkey) setHk(s.hotkey)
          if (s && (s.voiceMode === 'hold' || s.voiceMode === 'toggle')) setHkMode(s.voiceMode)
          if (s && (s.triggerMode === 'hotkey' || s.triggerMode === 'wakeword')) setTrigger(s.triggerMode)
          if (s && typeof s.wakeWords === 'string') setWakeWords(s.wakeWords)
          if (s && typeof s.wakeReply === 'string') setWakeReply(s.wakeReply)
          if (s && typeof s.wakePose === 'string') setWakePose(s.wakePose)
          if (s && Number(s.wakeSilenceSec) > 0) setWakeSilence(Number(s.wakeSilenceSec))
          if (s && Number(s.wakeMaxSec) > 0) setWakeMax(Number(s.wakeMaxSec))
          if (s && s.tts) setProviders(s.tts)
        } catch (e) {
          setStatus({ ok: false, error: String(e.message || e) })
        }
      }, [])

      const loadCfg = useCallback(async () => {
        try {
          const r = await api('GET', '/config')
          setCfg(r.config)
          setSavedJson(JSON.stringify(r.config))
          setErr('')
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      const loadLog = useCallback(async () => {
        try {
          const r = await api('GET', '/log?lines=60')
          setLog(r.lines || [])
        } catch (e) {
          setLog(['读日志失败：' + String(e.message || e)])
        }
      }, [])

      useEffect(() => {
        injectCss()
        loadStatus()
        loadCfg()
        loadLog()
        // 故意不自动轮询：面板是拿来改的，不是拿来看的。
        // 想更新点右上角「刷新」——5 秒一刷会把人正在填的字按回原值。
      }, [loadStatus, loadCfg, loadLog])

      const dirty = useMemo(() => cfg && savedJson && JSON.stringify(cfg) !== savedJson, [cfg, savedJson])

      useEffect(() => {
        dirtyRef.current = !!dirty
      }, [dirty])

      const set = (k) => (e) => setCfg((c) => Object.assign({}, c, { [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

      async function save() {
        setBusy('save')
        setErr('')
        setMsg('')
        try {
          const body = {
            sessionMode: cfg.sessionMode || 'latest',
            sessionId: cfg.sessionId,
            cwd: cfg.cwd,
            timeoutMs: Number(cfg.timeoutMs),
            speakReply: !!cfg.speakReply,
            speakTypedReplies: !!cfg.speakTypedReplies,
            petSync: !!cfg.petSync,
            letPetSpeak: !!cfg.letPetSpeak,
            petId: cfg.petId || '',
            petUrl: cfg.petUrl || '',
            ttsUrl: cfg.ttsUrl,
            speakMaxChars: Number(cfg.speakMaxChars),
            ttsProvider: cfg.ttsProvider,
            ttsChain: cfg.ttsChain,
            ttsVoice: cfg.ttsVoice,
            ttsVoices: cfg.ttsVoices || {},
            ttsSpeed: Number(cfg.ttsSpeed || 1),
            recordKeepDays: Number(cfg.recordKeepDays),
            recordDir: cfg.recordDir || '',
            autoStartTts: !!cfg.autoStartTts,
            inputEnabled: cfg.inputEnabled !== false,
            outputEnabled: cfg.outputEnabled !== false,
            sttEngine: cfg.sttEngine || 'official',
            sttLanguage: cfg.sttLanguage || 'auto',
            ttsPython: cfg.ttsPython || '',
            ttsWatchdog: cfg.ttsWatchdog || '',
            openaiBaseUrl: cfg.openaiBaseUrl,
            openaiApiKey: cfg.openaiApiKey,
            openaiModel: cfg.openaiModel,
            openaiVoice: cfg.openaiVoice,
            // 触发方式/唤醒词存在 voice\config.json 里，但面板只有一个「保存」——
            // 一起带上，别让人以为保存了却没写进去。
            triggerMode: trigger,
            wakeWords: wakeWords,
            wakeReply: wakeReply,
            wakePose: wakePose,
            wakeSilenceSec: Number(wakeSilence || 3),
            wakeMaxSec: Number(wakeMax || 30),
          }
          const r = await api('POST', '/config', body)
          setCfg(r.config)
          setSavedJson(JSON.stringify(r.config))
          if (r.wake) {
            setTrigger(r.wake.triggerMode)
            setWakeWords(r.wake.wakeWords)
            setWakeReply(r.wake.wakeReply)
            setWakePose(r.wake.wakePose || '')
            setWakeSilence(r.wake.wakeSilenceSec)
            setWakeMax(r.wake.wakeMaxSec)
          }
          setMsg(
            r.restarted
              ? '✓ 已保存：要换监听方式，正在重启语音输入进程（看门狗约 1 分钟内拉回来）'
              : '✓ 已保存，下一句话就按新设置走',
          )
          await loadStatus()
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function probe(id) {
        setBusy('probe:' + id)
        setErr('')
        setMsg('')
        try {
          const r = await api('POST', '/tts/probe', { provider: id, text: '哦鲸鲸，这是' + (ENGINE_LABEL[id] || id) + '的声音。' })
          setMsg('✓ ' + (ENGINE_LABEL[id] || id) + ' 念完了（' + r.ms + ' ms）')
        } catch (e) {
          setErr((ENGINE_LABEL[id] || id) + ' 失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function speakTest() {
        setBusy('speak')
        setErr('')
        setMsg('')
        try {
          const r = await api('POST', '/speak-test', { text: '哦鲸鲸，语音桥通了。' })
          if (r.tts && r.tts.byPet) {
            setMsg('✓ 气泡发出去了，这句话交给桌宠念（桥这边不出声）')
          } else {
            const via = r.tts && r.tts.provider ? '（' + (ENGINE_LABEL[r.tts.provider] || r.tts.provider) + '）' : ''
            const voiceName = r.tts && r.tts.voice
          ? ((voiceList || []).find((v) => v.id === r.tts.voice) || {}).name || r.tts.voice
          : ''
        setMsg('✓ 按当前设置念好了' + via + (voiceName ? '，音色：' + voiceName : ''))
          }
        } catch (e) {
          setErr('试听失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function petTest() {
        setBusy('pet')
        setErr('')
        setMsg('')
        try {
          const r = await api('POST', '/pet-test', { text: '哦鲸鲸，气泡是我自己弹的。' })
          if (r.ok) setMsg('✓ 气泡发出去了（宠物 ' + (r.petId || '?') + '），桌宠那边一秒内会弹出来')
          else setErr('桌宠没接住：' + ((r.result && (r.result.reason || r.result.message)) || '未知原因'))
          await loadStatus()
        } catch (e) {
          setErr('发气泡失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function startTtsNow() {
        setBusy('tts')
        setErr('')
        setMsg('')
        try {
          const r = await api('POST', '/start-tts', {})
          if (r && r.started) setMsg('✓ 已经在拉了，本地 TTS 要 40 秒左右才出声音（看门狗会把三个进程都带起来）')
          else if (r && r.already) setMsg('本地 TTS 本来就在跑，不用拉')
          else setMsg('已经发出去拉起请求了，稍等一下再看状态')
          setTimeout(() => {
            loadStatus()
          }, 6000)
        } catch (e) {
          setErr('拉不起来：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function sweepNow() {
        setBusy('sweep')
        setErr('')
        setMsg('')
        try {
          const r = await api('POST', '/records', {})
          const res = (r && r.result) || {}
          if (res.skipped) setMsg('保留天数是 0，什么都没删')
          else if (res.error) setErr('清理没完全成功：' + res.error)
          else if (res.deleted) setMsg('✓ 删了 ' + res.deleted + ' 个旧录音，省回 ' + res.freedMb + ' MB')
          else setMsg('没有超过 ' + (res.keepDays || 0) + ' 天的录音，不用清')
          await loadStatus()
        } catch (e) {
          setErr('清理失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function saveHotkey() {
        setBusy('hotkey')
        setErr('')
        setMsg('')
        try {
          const r = await api('POST', '/hotkey', { hotkey: hk, mode: hkMode })
          setHk(r.hotkey)
          setMsg('✓ 快捷键已改成 ' + String(r.hotkey).toUpperCase() + '，语音输入进程两秒内自己换键')
          await loadStatus()
        } catch (e) {
          setErr('改热键失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      async function refresh() {
        await loadStatus()
        await loadCfg()
        await loadLog()
      }

      if (!cfg) {
        return h('div', { className: 'vb-wrap' }, err ? h('div', { className: 'vb-err' }, err) : h('div', { className: 'vb-hint' }, '读取配置中…'))
      }

      const ttsOk = status && status.tts && status.tts.ok
      const chainFirst = (status && status.ttsChain ? String(status.ttsChain).split(',')[0] : '').trim()
      const effective = cfg.ttsProvider === 'auto' ? chainFirst || 'local' : cfg.ttsProvider
      // 音色列表跟着「当前这个引擎」走，不是永远停在 local
      const engineSel = effective || 'local'

      const engineRows = providers
        ? Object.keys(ENGINE_LABEL).map((id) => {
            const h0 = providers[id] || {}
            return h(
              'div',
              { className: 'vb-engine', key: id },
              h(Dot, { ok: h0.ok }),
              h('span', { className: 'name' }, ENGINE_LABEL[id]),
              h('span', { className: 'why' }, h0.ok ? (h0.model || (h0.voices ? h0.voices.length + ' 个音色' : '可用')) : h0.reason || '不可用'),
              cfg.ttsProvider === 'auto' && id === effective ? h('span', { className: 'vb-tag' }, '当前会用这个') : null,
              cfg.ttsProvider === id ? h('span', { className: 'vb-tag' }, '已指定') : null,
              h(
                'button',
                { className: 'vb-btn tiny', disabled: !!busy || !h0.ok, onClick: () => probe(id) },
                busy === 'probe:' + id ? '念…' : '试听',
              ),
            )
          })
        : h('div', { className: 'vb-hint' }, '读取引擎状态中…')

      const voiceList = (providers && providers[engineSel] && providers[engineSel].voices) || []
      const voiceOptions = [{ id: '', label: '（引擎默认）' }].concat(
        voiceList.map((v) => (typeof v === 'string' ? { id: v, label: v } : { id: v.id, label: v.label || v.id })),
      )
      const setVoice = (e) => {
        const v = e.target.value
        const id = engineSel
        setCfg((c) => {
          const map = Object.assign({}, c.ttsVoices || {})
          map[id] = v
          return Object.assign({}, c, { ttsVoices: map })
        })
      }
      // 两块功能的总开关：关掉就把对应整块设置收起来（后端也真的不干活）
      const inputOn = cfg.inputEnabled !== false
      const outputOn = cfg.outputEnabled !== false
      // 本地 TTS 服务缺席时，朗读和试听都出不了声 —— 这里明说，别让人对着没声音的按钮瞎点。
      const localInfo = (status && status.tts && status.tts.local) || null
      const localDown = !!(localInfo && localInfo.ok === false)
      const localUrl = cfg.ttsUrl || 'http://127.0.0.1:8777'
      const openaiShown = cfg.ttsProvider === 'openai'
      // F8 录音占用情况：面板上直说「现在多少条/多大」，省得自己去翻目录
      const recStats = (status && status.recordStats) || null
      const recLast = status && status.recordLast
      const recHint = (() => {
        const parts = []
        if (recStats) parts.push('现在 ' + recStats.count + ' 条 / ' + recStats.mb + ' MB')
        if (recLast && recLast.deleted) parts.push('上次清理（' + (recLast.why || '') + '）删了 ' + recLast.deleted + ' 条')
        else if (recLast && recLast.at) parts.push('上次清理（' + (recLast.why || '') + '）没删东西')
        return parts.join(' · ')
      })()
      // 识别器现状：官方服务在不在、模型到哪一步了
      const sttInfo = (status && status.stt) || null
      const sttHint = (() => {
        if (!sttInfo) return ''
        if (sttInfo.ok === false) return '官方识别服务不可用：' + (sttInfo.error || '未知原因')
        const bits = []
        if (sttInfo.name) bits.push(sttInfo.name)
        if (sttInfo.providerId) bits.push(sttInfo.providerId)
        if (sttInfo.phase) bits.push(sttInfo.phase)
        if (sttInfo.language) bits.push('语言 ' + sttInfo.language)
        return bits.join(' · ')
      })()

      return h(
        'div',
        { className: 'vb-wrap' },

        // ── 顶部状态条
        h(
          'div',
          { className: 'vb-head' },
          h('span', { className: 'vb-chip' }, h(Dot, { ok: !!(status && status.ok), idle: !status }), status ? (status.ok ? '在线' : '离线') : '读取中'),
          status && status.sessionId ? h('span', { className: 'vb-chip' }, '投给 ', h('strong', null, shortSid(status.sessionId))) : null,
          h('span', { className: 'vb-chip' }, '朗读 ', h('strong', null, cfg.ttsProvider === 'auto' ? '自动' : ENGINE_LABEL[cfg.ttsProvider] || cfg.ttsProvider)),
          h('span', { className: 'vb-chip' }, '触发 ', h('strong', null, triggerText(trigger, wakeWords, hk))),
          h('button', { className: 'vb-btn', style: { marginLeft: 'auto' }, onClick: refresh }, '刷新'),
        ),

        localDown
          ? h(
              'div',
              { className: 'vb-warn' },
              h('b', null, '本地 TTS 没起来'),
              h('div', null, '朗读和试听都靠它（' + localUrl + '）。要么把它跑起来，要么把引擎换成 edge-tts。'),
              h(
                'div',
                { className: 'vb-inline', style: { marginTop: '10px' } },
                h('button', { className: 'vb-btn tiny primary', disabled: !!busy, onClick: startTtsNow }, busy === 'tts' ? '拉起来中…' : '帮我拉起来'),
                h('button', { className: 'vb-btn tiny', disabled: !!busy, onClick: () => loadStatus() }, '重新检测'),
              ),
            )
          : null,

        // ── 总开关：两块功能的硬开关，关掉后下面整块设置会收起来
        h(
          'div',
          { className: 'vb-card' },
          h('div', { className: 'vb-title' }, '功能开关'),
          h(
            Row,
            { label: '语音输入', hint: '关掉后不听热键/唤醒词，也不往会话投话' },
            h(Bool, {
              value: inputOn,
              onChange: (v) => setCfg((c) => Object.assign({}, c, { inputEnabled: !!v })),
            }),
          ),
          h(
            Row,
            { label: '语音输出', hint: '关掉后一句都不念、也不弹气泡' },
            h(Bool, {
              value: outputOn,
              onChange: (v) => setCfg((c) => Object.assign({}, c, { outputEnabled: !!v })),
            }),
          ),
        ),

        // ── 状态（只读）
        h(
          'div',
          { className: 'vb-card' },
          h('div', { className: 'vb-title' }, '状态'),
          status
            ? h(
                'div',
                { className: 'vb-kv' },
                h('b', null, '触发'),
                h(
                  'span',
                  null,
                  triggerText(status.triggerMode || trigger, status.wakeWords || wakeWords, status.hotkey || hk) +
                    (trigger === 'wakeword' ? (wakeReply ? ' · 应答「' + wakeReply + '」' : ' · 不应答') : status.voiceMode === 'toggle' ? ' · 按一下开关' : ' · 按住说'),
                ),
                h('b', null, '最近'),
                h('span', null, status.lastAt ? fmtTime(status.lastAt) + ' · ' + (status.lastText || '') : '—'),
                h('b', null, '朗读'),
                h('span', null, (status.speakReply ? '语音投递的念' : '不念') + (status.speakTypedReplies ? ' · 打字的也念' : '')),
                h('b', null, '桌宠'),
                h('span', null, status.petSync ? (status.petId || '?') + (status.letPetSpeak === false ? ' · 桥自己念' : ' · 桌宠念') : '关'),
                h('b', null, '目录'),
                h('span', null, status.cwd || '—'),
              )
            : h('div', { className: 'vb-hint' }, '读取中…'),
        ),

        // ── 语音输入
        inputOn
          ? (
          h(
            'div',
            { className: 'vb-card' },
            h('div', { className: 'vb-title' }, '语音输入'),
            h(
              Row,
              { label: '触发方式', hint: trigger === 'wakeword' ? '换方式会重启一次语音输入进程，约 1 分钟' : '改完两秒内生效，不用重启' },
              h(
                'select',
                { className: 'vb-input w-md', value: trigger, onChange: (e) => setTrigger(e.target.value) },
                h('option', { value: 'hotkey' }, '按热键说话'),
                h('option', { value: 'wakeword' }, '喊唤醒词'),
              ),
            ),
            trigger === 'wakeword'
              ? h(
                  Row,
                  { label: '唤醒词', hint: '多个用逗号隔开' },
                  h('input', { className: 'vb-input w-md', value: wakeWords, placeholder: '大肥鱼', onChange: (e) => setWakeWords(e.target.value) }),
                )
              : null,
            trigger === 'wakeword'
              ? h(
                  Row,
                  { label: '应答', hint: '喊中先说这一句，不进对话、不花模型' },
                  h('input', { className: 'vb-input w-sm', value: wakeReply, placeholder: '在', onChange: (e) => setWakeReply(e.target.value) }),
                )
              : null,
            trigger === 'wakeword'
              ? h(
                  Row,
                  { label: '应答姿势', hint: '说这句时桌宠摆的姿势（动作名要存在桌宠配置里）；选「不摆」就只出声' },
                  h(
                    'select',
                    { className: 'vb-input w-md', value: wakePose, onChange: (e) => setWakePose(e.target.value) },
                    h('option', { value: '' }, '不摆'),
                    h('option', { value: '打瞌睡被惊醒' }, '打瞌睡被惊醒'),
                    h('option', { value: '哈欠连天' }, '哈欠连天'),
                    h('option', { value: '被吓一跳' }, '被吓一跳'),
                    h('option', { value: '女仆屈膝礼仪' }, '立正行礼（女仆屈膝礼仪）'),
                    h('option', { value: '点击回应-元气挥手' }, '元气挥手'),
                  ),
                )
              : null,
            trigger === 'wakeword'
              ? h(
                  Row,
                  { label: '停顿收工', hint: '停这么久不说话就自动收工' },
                  h('div', { className: 'vb-control-line' },
                    h('input', { className: 'vb-input w-xs', type: 'number', min: 1, max: 60, value: wakeSilence, onChange: (e) => setWakeSilence(e.target.value) }),
                    h('span', { className: 'vb-sub' }, '秒'),
                  ),
                )
              : null,
            trigger === 'wakeword'
              ? h(
                  Row,
                  { label: '最长一句', hint: '说太久到这个长度强制收工' },
                  h('div', { className: 'vb-control-line' },
                    h('input', { className: 'vb-input w-xs', type: 'number', min: 5, max: 300, value: wakeMax, onChange: (e) => setWakeMax(e.target.value) }),
                    h('span', { className: 'vb-sub' }, '秒'),
                  ),
                )
              : null,
            trigger === 'hotkey'
              ? h(
                  Row,
                  { label: '快捷键', hint: '比如 f8、ctrl+alt+v' },
                  h('input', { className: 'vb-input w-sm', value: hk, placeholder: 'f8', onChange: (e) => setHk(e.target.value) }),
                )
              : null,
            trigger === 'hotkey'
              ? h(
                  Row,
                  { label: '按键方式', hint: '按住说话，或者按一下开始、再按一下结束' },
                  h(
                    'select',
                    { className: 'vb-input w-sm', value: hkMode, onChange: (e) => setHkMode(e.target.value) },
                    h('option', { value: 'hold' }, '按住说话'),
                    h('option', { value: 'toggle' }, '按一下开关'),
                  ),
                )
              : null,
            trigger === 'hotkey'
              ? h(
                  Row,
                  { label: '保存热键', hint: '改完立刻生效，语音输入进程自己换绑' },
                  h('button', { className: 'vb-btn', onClick: saveHotkey, disabled: !!busy }, busy === 'hotkey' ? '保存中…' : '保存热键'),
                )
              : null,
            h(
              Row,
              { label: '识别引擎', hint: '官方自带标点、不吃显卡；本地能配热词但慢、占内存' + (sttHint ? ' · ' + sttHint : '') },
              h(
                'select',
                { className: 'vb-input w-md', value: cfg.sttEngine || 'official', onChange: set('sttEngine') },
                h('option', { value: 'official' }, '官方 SenseVoice'),
                h('option', { value: 'funasr' }, '本地 FunASR'),
              ),
            ),
          )
            )
          : null,

        // ── 朗读
        outputOn
          ? (
          h(
            'div',
            { className: 'vb-card' },
            h('div', { className: 'vb-title' }, '朗读'),
            engineRows,
            h(
              Row,
              { label: '引擎', hint: '自动 = 按下面的顺序挑第一个能用的' },
              h(
                'select',
                { className: 'vb-input w-md', value: cfg.ttsProvider || 'auto', onChange: set('ttsProvider') },
                h('option', { value: 'auto' }, '自动'),
                Object.keys(ENGINE_LABEL).map((id) => h('option', { value: id, key: id }, ENGINE_LABEL[id])),
              ),
            ),
            h(
              Row,
              { label: '音色', hint: voiceList.length ? '这个引擎有 ' + voiceList.length + ' 个可选' : '这个引擎只有默认音色' },
              h(
                'select',
                { className: 'vb-input w-md', value: (cfg.ttsVoices && cfg.ttsVoices[engineSel]) || '', onChange: setVoice },
                voiceOptions.map((v) => h('option', { value: v.id || '', key: v.id || 'd' }, v.label || v.id)),
              ),
            ),
            h(
              Row,
              { label: '语速', hint: '0.5~2 倍' },
              h('input', {
                className: 'vb-input w-xs',
                type: 'number',
                step: '0.05',
                min: '0.5',
                max: '2',
                value: cfg.ttsSpeed || 1,
                onChange: (e) => setCfg((c) => Object.assign({}, c, { ttsSpeed: Number(e.target.value) })),
              }),
            ),
            h(
              Row,
              { label: '最多念多少字', hint: '长回复只念前面这些' },
              h('input', { className: 'vb-input w-xs', type: 'number', min: 10, value: cfg.speakMaxChars || 100, onChange: (e) => setCfg((c) => Object.assign({}, c, { speakMaxChars: Number(e.target.value) })) }),
            ),
            h(
              Row,
              { label: '降级顺序', hint: '从左到右试，念不出来自动换下一个' },
              h('input', { className: 'vb-input w-lg', value: cfg.ttsChain || '', onChange: set('ttsChain'), placeholder: 'local,edge,openai,sapi' }),
            ),
            h(
              Row,
              { label: '念语音投递的回复', hint: '按住热键或喊唤醒词说的那些' },
              h(Bool, { value: !!cfg.speakReply, onChange: (v) => setCfg((c) => Object.assign({}, c, { speakReply: v })) }),
            ),
            h(
              Row,
              { label: '念手动打字的回复', hint: '敲字时旁边突然开口会烦，默认关' },
              h(Bool, { value: !!cfg.speakTypedReplies, onChange: (v) => setCfg((c) => Object.assign({}, c, { speakTypedReplies: v })) }),
            ),
            h('div', { className: 'vb-divider' }),
            h(
              Row,
              { label: '桌宠气泡', hint: '念的时候把这几句弹到桌宠头顶' },
              h(Bool, { value: !!cfg.petSync, onChange: (v) => setCfg((c) => Object.assign({}, c, { petSync: v })) }),
            ),
            cfg.petSync
              ? h(
                  Row,
                  { label: '宠物', hint: '留空 = 用桌宠配置里的第一只' },
                  h('input', { className: 'vb-input w-sm', value: cfg.petId || '', placeholder: 'main', onChange: set('petId') }),
                  h('button', { className: 'vb-btn', onClick: petTest, disabled: !!busy }, busy === 'pet' ? '发送中…' : '发一句试试'),
                )
              : null,
            cfg.petSync
              ? h(
                  Row,
                  { label: '让桌宠念', hint: '字和声更齐；只对「自动 / 本地」有效' },
                  h(Bool, { value: !!cfg.letPetSpeak, onChange: (v) => setCfg((c) => Object.assign({}, c, { letPetSpeak: v })) }),
                )
              : null,
          )
            )
          : null,

        // ── OpenAI
        openaiShown
          ? h(
              'div',
              { className: 'vb-card' },
              h('div', { className: 'vb-title' }, 'OpenAI 兼容'),
              h(Row, { label: '接口地址', hint: null }, h('input', { className: 'vb-input w-lg', value: cfg.openaiBaseUrl || '', onChange: set('openaiBaseUrl'), placeholder: 'https://api.openai.com/v1' })),
              h(Row, { label: 'API Key', hint: '只存在本机配置里' }, h('input', { className: 'vb-input w-lg', type: 'password', value: cfg.openaiApiKey || '', onChange: set('openaiApiKey'), placeholder: 'sk-...' })),
              h(Row, { label: '模型', hint: null }, h('input', { className: 'vb-input w-md', value: cfg.openaiModel || '', onChange: set('openaiModel'), placeholder: 'tts-1' })),
              h(Row, { label: '音色', hint: null }, h('input', { className: 'vb-input w-md', value: cfg.openaiVoice || '', onChange: set('openaiVoice'), placeholder: 'alloy' })),
            )
          : null,

        // ── 会话
        h(
          'div',
          { className: 'vb-card' },
          h('div', { className: 'vb-title' }, '会话'),
          h(
            Row,
            { label: '投给哪个会话', hint: '跟着最新 = 每句话投给这个目录里最近说话的会话' },
            h(
              'select',
              { className: 'vb-input w-md', value: cfg.sessionMode || 'latest', onChange: set('sessionMode') },
              Object.keys(MODE_LABEL).map((m) => h('option', { value: m, key: m }, MODE_LABEL[m])),
            ),
            status && status.sessionId ? h('span', { className: 'vb-tag' }, shortSid(status.sessionId)) : null,
          ),
          (cfg.sessionMode || 'latest') === 'fixed'
            ? h(Row, { label: '会话 id', hint: null }, h('input', { className: 'vb-input w-lg', value: cfg.sessionId || '', placeholder: 'session-xxxxxxxx-...', onChange: set('sessionId') }))
            : null,
          h(Row, { label: '工作目录', hint: null }, h('input', { className: 'vb-input w-lg', value: cfg.cwd || '', onChange: set('cwd') })),
          h(
            Row,
            { label: '等回复超时', hint: '跑太久桥就不等了，回复照样会出现在对话里' },
            h('input', { className: 'vb-input w-xs', type: 'number', min: 5, value: Math.round((cfg.timeoutMs || 300000) / 1000), onChange: (e) => setCfg((c) => Object.assign({}, c, { timeoutMs: Number(e.target.value) * 1000 })) }),
          ),
        ),

        // ── 维护
        h(
          'div',
          { className: 'vb-card' },
          h('div', { className: 'vb-title' }, '本地服务与维护'),
          h(Row, { label: 'TTS 地址', hint: null }, h('input', { className: 'vb-input w-md', value: cfg.ttsUrl || '', onChange: set('ttsUrl') })),
          h(
            Row,
            { label: '自启 TTS', hint: 'DSH 一起来就把本地 TTS 拉起来（要等 40 秒加载）' },
            h(Bool, { value: !!cfg.autoStartTts, onChange: (v) => setCfg((c) => Object.assign({}, c, { autoStartTts: v })) }),
          ),
          h(
            Row,
            { label: '录音保留', hint: '每次启动清一次旧录音；0 = 不删' },
            h('div', { className: 'vb-control-line' },
              h('input', {
                className: 'vb-input w-xs',
                type: 'number',
                min: 0,
                value: cfg.recordKeepDays == null ? 15 : cfg.recordKeepDays,
                onChange: (e) => setCfg((c) => Object.assign({}, c, { recordKeepDays: e.target.value === '' ? '' : Number(e.target.value) })),
              }),
              h('span', { className: 'vb-sub' }, '天'),
            ),
          ),
          h(
            Row,
            { label: '清理录音', hint: recHint || '按上面的天数清一次旧录音' },
            h('button', { className: 'vb-btn', onClick: sweepNow, disabled: !!busy }, busy === 'sweep' ? '清理中…' : '现在清一次'),
          ),
        ),

        // ── 保存条
        h(
          'div',
          { className: 'vb-savebar' },
          h('button', { className: 'vb-btn primary', onClick: save, disabled: !!busy }, busy === 'save' ? '保存中…' : '保存'),
          outputOn
            ? h('button', { className: 'vb-btn', onClick: speakTest, disabled: !!busy }, busy === 'speak' ? '试听中…' : '试听')
            : null,
          dirty ? h('span', { className: 'vb-dirty' }, '● 有改动') : null,
          h('span', { className: 'vb-hint', style: { marginLeft: 'auto' } }, status && status.configFile ? status.configFile : ''),
        ),
        msg ? h('div', { className: 'vb-msg' }, msg) : null,
        err ? h('div', { className: 'vb-err' }, err) : null,

        // ── 日志
        h(
          'div',
          { className: 'vb-card' },
          h('div', { className: 'vb-title' }, '日志', h('button', { className: 'vb-btn', style: { marginLeft: 'auto' }, onClick: loadLog }, '刷新')),
          h('pre', { className: 'vb-pre' }, (log.length ? log : ['（暂无）']).join('\n')),
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject(
            'settings.section',
            () =>
              ctx.slots.register(
                { name: 'settings.section', id: NS, order: 7, label: () => '语音桥' },
                VoiceBridgeSection,
              ),
            'voice-bridge: settings section',
          ),
        'voice-bridge: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.VoiceBridgeSection = VoiceBridgeSection
    return module.exports
  },
})
