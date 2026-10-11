import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { RoomServiceClient } from 'livekit-server-sdk'
import { Room,RoomEvent,AudioSource,AudioFrame,AudioStream,LocalAudioTrack,VideoSource,VideoFrame,VideoStream,LocalVideoTrack,TrackPublishOptions,TrackSource,VideoBufferType,dispose } from '@livekit/rtc-node'
import { gatewayFixture } from '../gateway-fixture'
import { startMeeting,joinMeeting,admitMeetingConnection,requireMeetingAdmissionKey,leaveMeeting,endMeeting,runOneMeetingControl,meetingDetails } from '../../server/lib/meetings'
import { getPool,rows } from '../../server/lib/db'
import { safeFailure } from '../../server/lib/http'

test('real self-hosted LiveKit accepts Sipper admission, removes a session and refuses its still-valid token',async t=>{
  assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
  const name=`sipper-meetings-${randomUUID()}`,directory=await mkdtemp(join(tmpdir(),'sipper-meetings-'))
  const portalName=`${name}-portal`,edgeSecret=randomUUID()+randomUUID()
  const key='fictional-meeting-key',secret=randomUUID()+randomUUID(),admissionKey=randomUUID()+randomUUID()
  process.env.SIPPER_GATEWAY_ID=`meetings-${randomUUID()}`
  process.env.SIPPER_MEETING_API_KEY=key;process.env.SIPPER_MEETING_API_SECRET=secret;process.env.SIPPER_MEETING_ADMISSION_KEY=admissionKey
  let proxy:any,fixture:Awaited<ReturnType<typeof gatewayFixture>>|undefined,started=false,portalStarted=false
  const sockets=new Set<WebSocket>(),rooms:Room[]=[]
  const admission=http.createServer(async(req,res)=>{
    try {
      requireMeetingAdmissionKey(req.headers.authorization)
      let body='';for await(const chunk of req)body+=chunk
      const result=await admitMeetingConnection(JSON.parse(body));res.setHeader('content-type','application/json');res.end(JSON.stringify(result))
    } catch(error) {const failure=safeFailure(error);res.writeHead(failure.statusCode,{'content-type':'application/json'});res.end(JSON.stringify(failure))}
  })
  t.after(async()=>{
    for(const socket of sockets)socket.close()
    await Promise.allSettled(rooms.map(room=>room.disconnect()))
    if(proxy)await proxy.close()
    if(admission.listening)await new Promise<void>(resolve=>admission.close(()=>resolve()))
    if(fixture) {
      const keys=[...(await rows('SELECT id FROM meetings WHERE organisation_id=$1',[fixture.organisation])).map(m=>`meeting_end:${m.id}`),...(await rows('SELECT id FROM meeting_sessions WHERE organisation_id=$1',[fixture.organisation])).map(s=>`meeting_remove:${s.id}`)]
      await fixture.cleanup();await getPool().query("DELETE FROM jobs WHERE kind='meeting_control' AND deduplication_key=ANY($1::text[])",[keys])
    }
    if(started)execFileSync('docker',['rm','-f',name],{stdio:'ignore'})
    if(portalStarted)execFileSync('docker',['rm','-f',portalName],{stdio:'ignore'})
    await rm(directory,{recursive:true,force:true});await getPool().end();await dispose()
  })
  const config=join(directory,'livekit.yaml')
  // ICE uses the container's private interface. Advertising host loopback here
  // breaks native media through VM port forwarding; the host must route that interface.
  await writeFile(config,`port: 7880\nbind_addresses: [0.0.0.0]\nrtc:\n  tcp_port: 29382\n  udp_port: 29383\n  use_external_ip: false\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: false\n  enable_remote_unmute: false\nlogging:\n  level: warn\n`,{mode:0o600})
  execFileSync('docker',['run','--rm','-d','--name',name,'--user',`${process.getuid!()}:${process.getgid!()}`,'--cap-drop=ALL','--security-opt=no-new-privileges:true','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','-p','127.0.0.1::7880','-p','127.0.0.1:29382:29382/tcp','-p','127.0.0.1:29383:29383/udp','--mount',`type=bind,src=${config},dst=/livekit.yaml,readonly`,'livekit/livekit-server:v1.9.12@sha256:2c13cbf2edcbf13ea7b20d05c10b394d04d8fb3fe358269cff845a90b4de9576','--config','/livekit.yaml'],{stdio:'pipe'});started=true
  const address=execFileSync('docker',['port',name,'7880/tcp'],{encoding:'utf8'}).trim()
  process.env.SIPPER_MEETING_INTERNAL_URL=`http://${address}`
  for(let attempt=0;;attempt++) {
    try {if((await fetch(process.env.SIPPER_MEETING_INTERNAL_URL,{signal:AbortSignal.timeout(1000)})).ok)break} catch {}
    if(attempt>=30)throw Error('Local LiveKit did not start')
    await setTimeout(200)
  }
  await new Promise<void>(resolve=>admission.listen(0,'127.0.0.1',resolve))
  let admissionURL=`http://127.0.0.1:${(admission.address() as any).port}/api/meetings/admission`
  if(process.env.SIPPER_MEETING_TEST_IMAGE) {
    const database=new URL(process.env.DATABASE_URL!)
    assert.ok(['127.0.0.1','localhost'].includes(database.hostname),'The image rehearsal only uses a local test database')
    database.hostname='host.docker.internal'
    const environment={DATABASE_URL:database.href,NODE_ENV:'production',SIPPER_BASE_URL:'https://portal.example.invalid',BETTER_AUTH_SECRET:randomUUID()+randomUUID(),
      SIPPER_ENCRYPTION_KEYS:JSON.stringify({v1:Buffer.from(randomUUID().replaceAll('-','')).toString('base64')}),SIPPER_ENCRYPTION_KEY_ID:'v1',SMTP_HOST:'host.docker.internal',SMTP_PORT:'1029',MAIL_FROM:'Sipper fixture <fixture@example.invalid>',
      SIPPER_EDGE_SHARED_SECRET:edgeSecret,SIPPER_MEETING_PUBLIC_URL:'wss://meet.example.invalid',SIPPER_MEETING_INTERNAL_URL:`http://host.docker.internal:${address.split(':').at(-1)}`,
      SIPPER_MEETING_API_KEY:key,SIPPER_MEETING_API_SECRET:secret,SIPPER_MEETING_ADMISSION_KEY:admissionKey}
    const envFile=join(directory,'portal.env')
    await writeFile(envFile,Object.entries(environment).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600})
    execFileSync('docker',['run','--rm','-d','--name',portalName,'--env-file',envFile,'--cap-drop=ALL','--security-opt=no-new-privileges:true','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','-p','127.0.0.1::3100',process.env.SIPPER_MEETING_TEST_IMAGE],{stdio:'pipe'});portalStarted=true
    const portalAddress=execFileSync('docker',['port',portalName,'3100/tcp'],{encoding:'utf8'}).trim(),origin=`http://${portalAddress}`
    for(let attempt=0;;attempt++) {
      try {if((await fetch(`${origin}/api/health`,{signal:AbortSignal.timeout(1000)})).ok)break} catch {}
      if(attempt>=30)throw Error('Local packaged portal did not start')
      await setTimeout(200)
    }
    admissionURL=`${origin}/api/meetings/admission`
    assert.equal((await fetch(admissionURL,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403,'Origin protection remains enforced')
    assert.equal((await fetch(admissionURL,{method:'POST',headers:{'content-type':'application/json','x-sipper-edge-secret':edgeSecret},body:'{}'})).status,401,'Origin access alone cannot authorise admission')
  }
  const {createMeetingProxy}=await import(new URL('../../../gateway/src/meeting-proxy.mjs',import.meta.url).href)
  proxy=createMeetingProxy({mediaURL:process.env.SIPPER_MEETING_INTERNAL_URL,admissionURL,admissionKey,...(portalStarted ? {edgeSecret} : {})})
  await new Promise<void>(resolve=>proxy.server.listen(0,'127.0.0.1',resolve))
  process.env.SIPPER_MEETING_PUBLIC_URL=`ws://localhost:${proxy.server.address().port}`
  fixture=await gatewayFixture()
  const actor={...fixture.actor,sessionId:randomUUID()},scope={deviceId:fixture.devices[0]!.id}
  await getPool().query('INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 day\',now(),now())',[actor.sessionId,randomUUID(),actor.userId])
  // A one-person fictional group exercises signalling without capturing media.
  const conversationId=randomUUID()
  await getPool().query("INSERT INTO conversations(id,organisation_id,kind,title,created_by,owner_id) VALUES($1,$2,'group','LiveKit signalling fixture',$3,$3)",[conversationId,fixture.organisation,actor.userId])
  await getPool().query('INSERT INTO conversation_members(organisation_id,conversation_id,user_id) VALUES($1,$2,$3)',[fixture.organisation,conversationId,actor.userId])
  let meeting=(await startMeeting(actor,scope,conversationId,{id:randomUUID()})).meeting
  let grant=await joinMeeting(actor,scope,meeting.id,{id:randomUUID()})
  const service=new RoomServiceClient(process.env.SIPPER_MEETING_INTERNAL_URL,key,secret,{requestTimeout:5,failover:false})
  const connect=async(token:string,origin=grant.url)=>{
    const url=new URL('/rtc',origin);url.search=new URLSearchParams({access_token:token,protocol:'16',sdk:'js',version:'2.19.1',auto_subscribe:'0'}).toString()
    const socket=new WebSocket(url);sockets.add(socket)
    await new Promise<void>((resolve,reject)=>{
      const timeout=globalThis.setTimeout(()=>{socket.close();reject(Error('Signal join timed out'))},5000)
      socket.addEventListener('message',()=>{clearTimeout(timeout);resolve()},{once:true})
      socket.addEventListener('error',()=>{clearTimeout(timeout);reject(Error('Signal connection refused'))},{once:true})
      socket.addEventListener('close',()=>{clearTimeout(timeout);reject(Error('Signal closed before join'))},{once:true})
    })
    return socket
  }
  const first=await connect(grant.token)
  assert.ok((await service.listParticipants(`sipper-${meeting.id}`)).some(p=>p.identity===grant.identity))
  assert.equal((await fetch(`${grant.url.replace('ws:','http:')}/twirp/livekit.RoomService/DeleteRoom`)).status,403)
  await leaveMeeting(actor,scope,meeting.id,grant.sessionId)
  while(await runOneMeetingControl()) {}
  assert.ok((await meetingDetails(actor,scope,meeting.id)).sessions[0]!.controlConfirmedAt)
  assert.equal((await service.listParticipants(`sipper-${meeting.id}`)).length,0)
  await assert.rejects(connect(grant.token))
  assert.ok(Date.parse(grant.expiresAt)>Date.now(),'Original token is still within its signed expiry')
  // Prove the raw SFU would accept that same token: only the Sipper proxy is public.
  const bypass=new Room();rooms.push(bypass)
  await bypass.connect(process.env.SIPPER_MEETING_INTERNAL_URL.replace('http:','ws:'),grant.token)
  assert.equal(bypass.isConnected,true,'The raw private SFU still accepts media admission with the revoked token')
  assert.equal((await service.listParticipants(`sipper-${meeting.id}`)).length,1)
  await service.removeParticipant(`sipper-${meeting.id}`,grant.identity);await bypass.disconnect();first.close()
  await endMeeting(actor,scope,meeting.id);while(await runOneMeetingControl()) {}
  meeting=(await startMeeting(actor,scope,conversationId,{id:randomUUID()})).meeting
  // Real generated audio/video crosses the SFU. No browser/OS capture or
  // microphone/camera permission is used by these two native SDK peers.
  const sender=new Room(),receiver=new Room();rooms.push(sender,receiver)
  const receiverScope={deviceId:fixture.devices[1]!.id}
  assert.notEqual(receiverScope.deviceId,scope.deviceId)
  const senderGrant=await joinMeeting(actor,scope,meeting.id,{id:randomUUID()}),receiverGrant=await joinMeeting(actor,receiverScope,meeting.id,{id:randomUUID()})
  const admissions=(await meetingDetails(actor,scope,meeting.id)).sessions
  assert.equal(admissions.find(s=>s.id===senderGrant.sessionId)?.deviceId,scope.deviceId)
  assert.equal(admissions.find(s=>s.id===receiverGrant.sessionId)?.deviceId,receiverScope.deviceId)
  assert.equal((await rows('SELECT count(*)::int AS n FROM seat_assignments WHERE workspace_id=$1',[fixture.workspace]))[0]!.n,1,'Two devices consume one named-user seat')
  await assert.rejects(leaveMeeting(actor,scope,meeting.id,receiverGrant.sessionId),error=>safeFailure(error).statusCode===404,'One device cannot withdraw the other device’s session')
  const audio=new AudioSource(48000,1),video=new VideoSource(160,90)
  const readers:Array<ReadableStreamDefaultReader<any>>=[],received=new Map<number,{frames:number;signal:boolean;colours:Set<number>}>()
  const streams:Promise<void>[]=[]
  receiver.on(RoomEvent.TrackSubscribed,(track,publication)=>{
    const source=publication.source,stats={frames:0,signal:false,colours:new Set<number>()};received.set(source,stats)
    const reader=(source===TrackSource.SOURCE_MICROPHONE ? new AudioStream(track) : new VideoStream(track)).getReader();readers.push(reader)
    streams.push((async()=>{for(;;){const item=await reader.read();if(item.done)break;stats.frames++;if(source===TrackSource.SOURCE_MICROPHONE)stats.signal ||= item.value.data.some((sample:number)=>Math.abs(sample)>500);else stats.colours.add(item.value.frame.convert(VideoBufferType.RGBA).data[0])}})())
  })
  let producing=true
  try {
    await receiver.connect(receiverGrant.url,receiverGrant.token);await sender.connect(senderGrant.url,senderGrant.token)
    await sender.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('Generated tone',audio),new TrackPublishOptions({source:TrackSource.SOURCE_MICROPHONE}))
    await sender.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('Generated camera',video),new TrackPublishOptions({source:TrackSource.SOURCE_CAMERA}))
    await sender.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('Generated screen',video),new TrackPublishOptions({source:TrackSource.SOURCE_SCREENSHARE}))
    const producer=(async()=>{for(let frame=0;producing;frame++){
      const sound=AudioFrame.create(48000,1,480);for(let i=0;i<480;i++)sound.data[i]=Math.round(10_000*Math.sin(2*Math.PI*440*(frame*480+i)/48000));await audio.captureFrame(sound)
      if(frame%3===0){const pixels=new Uint8Array(160*90*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=(frame*5)%256;pixels[i+1]=80;pixels[i+2]=180;pixels[i+3]=255}video.captureFrame(new VideoFrame(pixels,160,90,VideoBufferType.RGBA))}
      await setTimeout(10)
    }})()
    try {
      const deadline=Date.now()+15_000
      for(;;){const a=received.get(TrackSource.SOURCE_MICROPHONE),v=received.get(TrackSource.SOURCE_CAMERA),s=received.get(TrackSource.SOURCE_SCREENSHARE)
        if(a && a.frames>=25 && a.signal && v && v.frames>=5 && v.colours.size>=2 && s && s.frames>=5 && s.colours.size>=2)break
        if(Date.now()>deadline)throw Error(`Decoded generated media did not arrive: ${JSON.stringify([...received].map(([source,value])=>({source,frames:value.frames,signal:value.signal,colours:value.colours.size})))}`)
        await setTimeout(100)
      }
      t.diagnostic(`Decoded generated media: ${JSON.stringify([...received].map(([source,value])=>({source,frames:value.frames,signal:value.signal,colours:value.colours.size})))}`)
    } finally {producing=false;await producer}
    await leaveMeeting(actor,scope,meeting.id,senderGrant.sessionId);while(await runOneMeetingControl()) {}
    const deadline=Date.now()+5000;while(sender.isConnected && Date.now()<deadline)await setTimeout(50)
    assert.equal(sender.isConnected,false,'Server withdrawal disconnects the actual publisher')
    assert.equal(receiver.isConnected,true,'Leaving one device preserves the same user’s other connected device')
    assert.equal((await meetingDetails(actor,receiverScope,meeting.id)).sessions.find(s=>s.id===receiverGrant.sessionId)?.revokedAt,null)
    const replay=new Room();rooms.push(replay);await assert.rejects(replay.connect(senderGrant.url,senderGrant.token))
  } finally {
    producing=false;await Promise.allSettled(readers.map(reader=>reader.cancel()));await Promise.allSettled(streams)
    await Promise.allSettled([sender.disconnect(),receiver.disconnect(),audio.close(),video.close()])
    await leaveMeeting(actor,receiverScope,meeting.id,receiverGrant.sessionId)
  }
  grant=await joinMeeting(actor,scope,meeting.id,{id:randomUUID()});await connect(grant.token)
  await endMeeting(actor,scope,meeting.id);while(await runOneMeetingControl()) {}
  assert.ok((await meetingDetails(actor,scope,meeting.id)).meeting.controlConfirmedAt)
  await assert.rejects(connect(grant.token));assert.equal((await service.listRooms([`sipper-${meeting.id}`])).length,0)
})
