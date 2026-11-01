import crypto from 'node:crypto'
import tls from 'node:tls'
const TRUSTED='6A5AA1D4EAFF4E9FB37E23D68491D6F4', HOST='speech.platform.bing.com'
const PATH='/consumer/speech/synthesize/readaloud/edge/v1'
const sha=s=>crypto.createHash('sha256').update(s).digest('hex').toUpperCase()
function gec(){let t=Math.floor((Date.now()/1000+11644473600)*1e7);t-=t%3e9;return sha(String(t)+TRUSTED)}
function tryIt(name, extra, ver){
  return new Promise(res=>{
    const qs=`?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${ver||'1-130.0.2849.68'}&ConnectionId=${crypto.randomUUID()}`
    const sock=tls.connect({host:HOST,port:443,servername:HOST})
    let buf=Buffer.alloc(0); let done=false
    const fin=m=>{if(!done){done=true;try{sock.destroy()}catch(e){};res(name+': '+m)}}
    setTimeout(()=>fin('超时'),9000)
    sock.on('error',e=>fin('ERR '+e.message))
    sock.on('secureConnect',()=>{
      const h={
        Host:HOST,Upgrade:'websocket',Connection:'Upgrade',
        'Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version':'13',
        Origin:'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        Pragma:'no-cache','Cache-Control':'no-cache',
        'Accept-Encoding':'gzip, deflate, br','Accept-Language':'en-US,en;q=0.9',
        'Sec-WebSocket-Extensions':'permessage-deflate; client_max_window_bits',
        ...extra}
      sock.write('GET '+PATH+qs+' HTTP/1.1\r\n'+Object.entries(h).map(([k,v])=>k+': '+v+'\r\n').join('')+'\r\n')
    })
    sock.on('data',c=>{buf=Buffer.concat([buf,c]);const i=buf.indexOf('\r\n\r\n');if(i<0)return;fin(buf.subarray(0,i).toString('latin1').split('\r\n')[0])})
  })
}
console.log(await tryIt('全头',{}))
console.log(await tryIt('无 Extensions',{'Sec-WebSocket-Extensions':undefined}))
console.log(await tryIt('新版本号 1-134',{},'1-134.0.3124.51'))
console.log(await tryIt('无 Origin 无 Ext',{Origin:undefined,'Sec-WebSocket-Extensions':undefined}))