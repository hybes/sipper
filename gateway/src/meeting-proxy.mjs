import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

const signalPaths=new Set(['/rtc','/rtc/v1'])
const validatePaths=new Set(['/rtc/validate','/rtc/v1/validate'])
const errorBody=JSON.stringify({message:'Meeting connection unavailable.'})

// Only signalling reaches this listener. The SFU's control/signalling port must
// remain private; publishing it would bypass Sipper's per-connection admission.
export function createMeetingProxy({mediaURL,admissionURL,admissionKey,edgeSecret=''}) {
  const media=new URL(mediaURL), admission=new URL(admissionURL)
  if(!['http:','https:'].includes(media.protocol) || !['http:','https:'].includes(admission.protocol)
    || [media,admission].some(url=>url.username || url.password || url.search || url.hash)
    || media.pathname!=='/' || admission.pathname!=='/api/meetings/admission' || admissionKey.length<32) throw Error('Invalid meeting proxy configuration')
  const transport=media.protocol==='https:' ? https : http, sockets=new Set()
  let pending=0
  function parse(req,upgrade) {
    const url=new URL(req.url,'http://signal.local')
    if(req.method!=='GET' || req.url.length>16_384 || !(upgrade ? signalPaths : validatePaths).has(url.pathname)) throw Error('Invalid signal path')
    const values=url.searchParams.getAll('access_token'), auth=req.headers.authorization
    if(values.length>1 || (values.length && auth)) throw Error('Ambiguous token')
    const token=values[0] ?? (typeof auth==='string' && auth.startsWith('Bearer ') ? auth.slice(7) : '')
    if(!token || token.length>8192)throw Error('Missing token')
    url.searchParams.set('access_token',token)
    return {token,path:url.pathname+url.search}
  }
  async function allowed(token) {
    const response=await fetch(admission,{method:'POST',headers:{authorization:`Bearer ${admissionKey}`,'content-type':'application/json',...(edgeSecret ? {'x-sipper-edge-secret':edgeSecret} : {})},body:JSON.stringify({token}),signal:AbortSignal.timeout(5000),redirect:'error'})
    if(!response.ok || (await response.json()).admitted!==true) throw Error('Admission denied')
  }
  function headers(req) {
    // Cookies, forwarding headers and unrelated credentials never reach the SFU.
    const result={}
    for(const key of ['user-agent','upgrade','connection','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions']) if(req.headers[key])result[key]=req.headers[key]
    return result
  }
  const server=http.createServer({maxHeaderSize:16_384,requestTimeout:5000,headersTimeout:5000},async(req,res)=>{
    res.setHeader('Cache-Control','no-store')
    if(req.method==='GET' && req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok"}');return}
    if(pending>=128){res.writeHead(503);res.end(errorBody);return}
    pending++
    try {
      const {token,path}=parse(req,false);await allowed(token)
      if(req.destroyed)return
      const upstream=transport.request(new URL(path,media),{method:'GET',headers:{},timeout:5000},response=>{
        response.resume()
        res.writeHead(response.statusCode===200 ? 200 : 403,{'content-type':'text/plain'})
        res.end(response.statusCode===200 ? 'success' : 'Meeting connection unavailable.')
      })
      upstream.on('timeout',()=>upstream.destroy())
      upstream.on('error',()=>{if(!res.headersSent){res.writeHead(503);res.end(errorBody)}else res.destroy()})
      req.once('close',()=>{if(!req.complete)upstream.destroy()})
      upstream.end()
    } catch {res.writeHead(403,{'content-type':'application/json'});res.end(errorBody)}
    finally {pending--}
  })
  server.maxConnections=512
  server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>socket.destroy());socket.once('close',()=>sockets.delete(socket))})
  server.on('clientError',(_,socket)=>socket.destroy())
  server.on('upgrade',async(req,socket,head)=>{
    const reject=()=>{if(!socket.destroyed)socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')}
    if(pending>=128 || head.length>65536){reject();return}
    pending++;socket.pause()
    try {
      const {token,path}=parse(req,true);await allowed(token)
      if(socket.destroyed)return
      await new Promise((resolve,rejectPromise)=>{
        const upstream=transport.request(new URL(path,media),{method:'GET',headers:headers(req),timeout:5000})
        upstream.on('timeout',()=>upstream.destroy())
        upstream.on('error',rejectPromise)
        upstream.on('response',response=>{response.resume();rejectPromise(Error('Upgrade refused'))})
        socket.once('close',()=>upstream.destroy())
        upstream.on('upgrade',async(response,peer,peerHead)=>{
          peer.pause();peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy())
          socket.once('close',()=>peer.destroy());peer.once('close',()=>socket.destroy())
          try {
            // Recheck withdrawal that committed during the upstream handshake.
            await allowed(token)
            if(socket.destroyed){peer.destroy();resolve();return}
            const result=['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade']
            for(const key of ['sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions']) if(response.headers[key])result.push(`${key}: ${response.headers[key]}`)
            socket.write(result.join('\r\n')+'\r\n\r\n')
            if(peerHead.length)socket.write(peerHead)
            if(head.length)peer.write(head)
            socket.pipe(peer);peer.pipe(socket);socket.resume();peer.resume();resolve()
          } catch {peer.destroy();rejectPromise(Error('Admission withdrawn'))}
        })
        upstream.end()
      })
    } catch {reject()}
    finally {pending--}
  })
  return {server,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()))}}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const proxy=createMeetingProxy({mediaURL:process.env.SIPPER_MEETING_INTERNAL_URL,admissionURL:process.env.SIPPER_MEETING_ADMISSION_URL,admissionKey:process.env.SIPPER_MEETING_ADMISSION_KEY ?? '',edgeSecret:process.env.SIPPER_EDGE_SHARED_SECRET ?? ''})
  const port=Number(process.env.PORT ?? 7881),host=process.env.HOST ?? '127.0.0.1'
  if(!Number.isInteger(port) || port<1 || port>65535)throw Error('Invalid meeting proxy port')
  proxy.server.listen(port,host,()=>console.log('Meeting signalling proxy started'))
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void proxy.close().then(()=>process.exit(0))})
}
