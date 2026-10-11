import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { createMeetingProxy } from '../src/meeting-proxy.mjs'

test('meeting proxy gates every signalling path and reconnect, rechecks the handshake and exposes no SFU administration',async t=>{
  const admissionKey='fictional-admission-key-for-local-tests-only',edgeSecret='fictional-origin-key-for-local-tests-only',seen=[],checks=[]
  let permitted=true,withdrawDuringUpgrade=false
  const admission=http.createServer(async(req,res)=>{
    assert.equal(req.url,'/api/meetings/admission');assert.equal(req.headers.authorization,`Bearer ${admissionKey}`)
    assert.equal(req.headers['x-sipper-edge-secret'],edgeSecret)
    let text='';for await(const part of req)text+=part
    const {token}=JSON.parse(text);checks.push(token)
    res.setHeader('content-type','application/json')
    res.writeHead(permitted && token==='fictional-join-token' ? 200 : 403);res.end(JSON.stringify({admitted:permitted && token==='fictional-join-token'}))
  })
  const media=http.createServer((req,res)=>{seen.push(req.url);assert.equal(req.headers.cookie,undefined);res.end('success')})
  const ws=new WebSocketServer({noServer:true})
  media.on('upgrade',(req,socket,head)=>{
    seen.push(req.url);assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['x-forwarded-for'],undefined)
    if(withdrawDuringUpgrade)permitted=false
    ws.handleUpgrade(req,socket,head,peer=>{peer.on('message',message=>peer.send(message));peer.send('joined')})
  })
  for(const server of [admission,media])await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const proxy=createMeetingProxy({mediaURL:`http://127.0.0.1:${media.address().port}`,admissionURL:`http://127.0.0.1:${admission.address().port}/api/meetings/admission`,admissionKey,edgeSecret})
  await new Promise(resolve=>proxy.server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${proxy.server.address().port}`
  t.after(async()=>{for(const peer of ws.clients)peer.terminate();await proxy.close();await Promise.all([media,admission].map(server=>new Promise(resolve=>server.close(resolve))))})
  const request=path=>fetch(base+path,{headers:{cookie:'private-cookie', 'x-forwarded-for':'203.0.113.1'}})
  assert.equal((await request('/health')).status,200)
  for(const path of ['/rtc/validate','/rtc/v1/validate'])assert.equal((await request(`${path}?access_token=fictional-join-token`)).status,200)
  for(const path of ['/twirp/livekit.RoomService/DeleteRoom','/rtc/anything','/rtc/validate?access_token=bad','/rtc/validate?access_token=fictional-join-token&access_token=bad'])assert.equal((await request(path)).status,403)
  assert.equal(seen.length,2)
  const connect=path=>new WebSocket(base.replace('http:','ws:')+path,{headers:{cookie:'private-cookie','x-forwarded-for':'203.0.113.1'}})
  const denied=async path=>{
    const peer=connect(path)
    await new Promise((resolve,reject)=>{peer.on('error',resolve);peer.on('open',()=>{peer.terminate();reject(Error('Denied connection opened'))})})
  }
  for(const path of ['/rtc','/rtc/v1']) {
    const peer=connect(`${path}?access_token=fictional-join-token`)
    const joined=await new Promise((resolve,reject)=>{peer.once('message',data=>resolve(data.toString()));peer.once('error',reject)})
    assert.equal(joined,'joined')
    const echo=new Promise(resolve=>peer.once('message',data=>resolve(data.toString())));peer.send('echo');assert.equal(await echo,'echo')
    peer.terminate()
  }
  permitted=false
  await denied('/rtc?access_token=fictional-join-token')
  assert.equal((await request('/rtc/validate?access_token=fictional-join-token')).status,403)
  permitted=true;withdrawDuringUpgrade=true
  await denied('/rtc/v1?access_token=fictional-join-token')
  assert.ok(checks.filter(token=>token==='fictional-join-token').length>=10)
  assert.throws(()=>createMeetingProxy({mediaURL:'http://localhost/',admissionURL:'http://localhost/other',admissionKey}))
})
