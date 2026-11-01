import test from 'node:test'
import assert from 'node:assert/strict'

import { shortForSpeech, validateConfig, DEFAULTS } from '../lib/index.js'

test('shortForSpeech 按句切，不超长', () => {
  const text = '哦鲸鲸。这波不亏。你又在折腾什么呀。算了，我帮你看看，顺便把日志翻一遍。'
  const out = shortForSpeech(text, 12)
  assert.ok(out.length <= 12, '必须不超过上限：' + out)
  assert.ok(out.startsWith('哦鲸鲸'), '从头开始念：' + out)
})

test('shortForSpeech 抹掉代码块', () => {
  const out = shortForSpeech('看这里：\n```js\nconsole.log(1)\n```\n就这样。', 60)
  assert.ok(!out.includes('console.log'), '代码不该被念出来：' + out)
  assert.ok(out.includes('看这里'), '正常文字要保留：' + out)
})

test('validateConfig 收数字字符串', () => {
  const out = validateConfig({ timeoutMs: '90000', speakMaxChars: '80' })
  assert.equal(out.timeoutMs, 90000)
  assert.equal(out.speakMaxChars, 80)
})

test('validateConfig 范围外要响亮失败', () => {
  assert.throws(() => validateConfig({ timeoutMs: 1000 }), /timeoutMs/)
  assert.throws(() => validateConfig({ speakMaxChars: 5 }), /speakMaxChars/)
})

test('TTS 地址去掉尾部斜杠', () => {
  assert.equal(validateConfig({ ttsUrl: 'http://127.0.0.1:8777///' }).ttsUrl, 'http://127.0.0.1:8777')
})

test('默认值自带 cwd 和超时', () => {
  assert.ok(DEFAULTS.timeoutMs > 0)
  assert.equal(typeof DEFAULTS.ttsUrl, 'string')
})

test('默认会话模式是跟着最新会话走', () => {
  assert.equal(DEFAULTS.sessionMode, 'latest')
})

test('sessionMode 只认 latest/fixed/new', () => {
  assert.equal(validateConfig({ sessionMode: 'FIXED' }).sessionMode, 'fixed')
  assert.equal(validateConfig({ sessionMode: ' new ' }).sessionMode, 'new')
  assert.equal(validateConfig({ sessionMode: '' }).sessionMode, undefined, '空串不覆盖')
  assert.throws(() => validateConfig({ sessionMode: 'newest' }), /sessionMode/)
})

test('默认会跟桌宠同步，但可以关', () => {
  assert.equal(DEFAULTS.petSync, true, '默认是要弹气泡的')
  assert.equal(validateConfig({ petSync: false }).petSync, false)
})

test('petUrl 去掉尾部斜杠，petId 去空白', () => {
  assert.equal(validateConfig({ petUrl: 'http://127.0.0.1:53290//' }).petUrl, 'http://127.0.0.1:53290')
  assert.equal(validateConfig({ petId: '  main  ' }).petId, 'main')
  assert.equal(validateConfig({ petId: '' }).petId, '')
})

test('默认让桌宠念，不自己念（免得念两遍）', () => {
  assert.equal(DEFAULTS.letPetSpeak, true)
  assert.equal(validateConfig({ letPetSpeak: false }).letPetSpeak, false)
})

test('每个引擎各记各的音色', () => {
  assert.deepEqual(DEFAULTS.ttsVoices, {}, '默认是空表')
  const out = validateConfig({ ttsVoices: { edge: ' zh-CN-XiaoxiaoNeural ', sapi: 'Microsoft Huihui Desktop' } })
  assert.deepEqual(out.ttsVoices, { edge: 'zh-CN-XiaoxiaoNeural', sapi: 'Microsoft Huihui Desktop' })
  const clean = validateConfig({ ttsVoices: { edge: 'zh-CN-YunxiNeural', nope: 'x', local: 3 } })
  assert.deepEqual(clean.ttsVoices, { edge: 'zh-CN-YunxiNeural' }, '不认识的引擎和非字符串都丢掉')
})

test('录音默认留 15 天，0 = 不清理', () => {  assert.equal(DEFAULTS.recordKeepDays, 15)
  assert.equal(validateConfig({ recordKeepDays: 30 }).recordKeepDays, 30)
  assert.equal(validateConfig({ recordKeepDays: '0' }).recordKeepDays, 0, '字符串也能收，0 表示一个都不删')
  assert.equal(validateConfig({ recordKeepDays: 7.6 }).recordKeepDays, 8, '取整')
  assert.equal(validateConfig({ recordKeepDays: '' }).recordKeepDays, undefined, '空串不覆盖')
  assert.throws(() => validateConfig({ recordKeepDays: -1 }), /保留天数/)
  assert.throws(() => validateConfig({ recordKeepDays: 99999 }), /保留天数/)
  assert.equal(validateConfig({ recordDir: '  E:/DSH_Work/voice/in  ' }).recordDir, 'E:/DSH_Work/voice/in')
})

test('打字的回复默认不念，要念得自己开', () => {
  assert.equal(DEFAULTS.speakTypedReplies, false, '默认关，敲字时别突然开口')
  assert.equal(validateConfig({ speakTypedReplies: true }).speakTypedReplies, true)
  assert.equal(validateConfig({ speakTypedReplies: 0 }).speakTypedReplies, false)
  assert.equal(validateConfig({}).speakTypedReplies, undefined, '没传就不覆盖')
})

test('DSH 起来时默认会把本地 TTS 拉起来，也能关掉', () => {
  assert.equal(DEFAULTS.autoStartTts, true)
  assert.equal(validateConfig({ autoStartTts: false }).autoStartTts, false)
  assert.equal(validateConfig({ autoStartTts: 'yes' }).autoStartTts, true, '非空即真')
  assert.equal(validateConfig({ autoStartTts: null }).autoStartTts, undefined, 'null 不覆盖')
  assert.equal(validateConfig({ ttsPython: '  D:\\py\\pythonw.exe ' }).ttsPython, 'D:\\py\\pythonw.exe', '去空白')
  assert.equal(validateConfig({ ttsWatchdog: '' }).ttsWatchdog, '', '空串=用默认路径')
})

test('识别默认走官方 SenseVoice，也能切回本地 FunASR', () => {
  assert.equal(DEFAULTS.sttEngine, 'official', '默认官方：自带标点，不用等模型加载')
  assert.equal(validateConfig({ sttEngine: 'FUNASR' }).sttEngine, 'funasr', '大小写不敏感')
  assert.equal(validateConfig({ sttEngine: ' funasr ' }).sttEngine, 'funasr', '去空白')
  assert.equal(validateConfig({ sttEngine: '' }).sttEngine, undefined, '空串不覆盖')
  assert.equal(validateConfig({}).sttEngine, undefined, '没传就不覆盖')
  assert.throws(() => validateConfig({ sttEngine: 'sensevoice' }), /识别引擎只能是/, '别的不认')
  assert.equal(DEFAULTS.sttLanguage, 'auto')
  assert.equal(validateConfig({ sttLanguage: ' zh ' }).sttLanguage, 'zh', '语言去空白')
})

test('语音输入/输出各有一个总开关，默认都开', () => {
  assert.equal(DEFAULTS.inputEnabled, true)
  assert.equal(DEFAULTS.outputEnabled, true)
  assert.equal(validateConfig({ inputEnabled: false }).inputEnabled, false)
  assert.equal(validateConfig({ outputEnabled: false }).outputEnabled, false)
  assert.equal(validateConfig({ inputEnabled: 'no' }).inputEnabled, true, '非空即真')
  assert.equal(validateConfig({}).inputEnabled, undefined, '没传就不覆盖')
  assert.equal(validateConfig({ outputEnabled: null }).outputEnabled, undefined, 'null 不覆盖')
})