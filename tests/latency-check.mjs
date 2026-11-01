// 量一下 /state 长轮询的「投递延迟」：宿主写完 state 到客户端拿到，中间隔多久。
// 跑法：node tests/latency-check.mjs
const BASE = process.env.VB_BASE || 'http://127.0.0.1:53290'
const PET = process.env.VB_PET || 'main'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const st = await (await fetch(BASE + '/dsh-pet-7340/state')).json()
  const since = st.counter
  console.log('起始 counter =', since)

  const t0 = Date.now()
  let resolvedAt = 0
  const poll = fetch(BASE + '/dsh-pet-7340/state?since=' + since + '&timeout=8000')
    .then((r) => r.json())
    .then((s) => {
      resolvedAt = Date.now()
      return s
    })

  await sleep(800)
  const postAt = Date.now()
  const post = await fetch(BASE + '/dsh-pet-7340/broadcast?pet=' + PET + '&surface=any', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text: '延迟测量用的气泡', duration: 3000, anim: false }),
  })
  const postDone = Date.now()
  await post.json()

  const s = await poll
  console.log('POST 发出 +' + (postAt - t0) + 'ms，POST 返回 +' + (postDone - t0) + 'ms')
  console.log('长轮询拿到新 state +' + (resolvedAt - t0) + 'ms  counter=' + s.counter)
  console.log('→ 投递延迟 ≈ ' + (resolvedAt - postAt) + 'ms（不含 React 渲染）')
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
