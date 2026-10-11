import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Track,type Room } from 'livekit-client'
import { stopMeetingCapture,changeMeetingCapture } from '../app/utils/meeting-capture'

test('turning capture off stops hardware before unpublishing, including screen audio on failed network work',async()=>{
  const stopped:string[]=[],unpublished:string[]=[]
  const tracks=new Map([Track.Source.ScreenShare,Track.Source.ScreenShareAudio].map(source=>[source,{source,stop:()=>stopped.push(source)}]))
  const room={localParticipant:{getTrackPublication:(source:string)=>({track:tracks.get(source as Track.Source)}),unpublishTrack:async(track:any)=>{assert.equal(stopped.length,2);unpublished.push(track.source);throw Error('offline')}}} as unknown as Room
  await assert.rejects(changeMeetingCapture(room,Track.Source.ScreenShare,false,()=>true),/capture_stop_failed/)
  assert.deepEqual(stopped,[Track.Source.ScreenShare,Track.Source.ScreenShareAudio]);assert.equal(unpublished.length,2)
})

test('a permission result arriving after cancellation stops only the former room capture',async()=>{
  for(const source of [Track.Source.Microphone,Track.Source.Camera,Track.Source.ScreenShare]) {
    let current=true,resolve!:(value:any)=>void,stopped=0,removed=0
    const track={stop:()=>stopped++},capture=()=>new Promise<any>(done=>{resolve=done})
    const room={localParticipant:{getTrackPublication:()=>({track}),setMicrophoneEnabled:capture,setCameraEnabled:capture,setScreenShareEnabled:capture,unpublishTrack:async()=>{removed++}}} as unknown as Room
    const pending=changeMeetingCapture(room,source,true,()=>current);current=false;resolve({track});await pending
    assert.ok(stopped>0);assert.equal(removed,source===Track.Source.ScreenShare ? 2 : 1)
  }
})

test('disconnect stops every published local track without depending on the network',()=>{
  let stopped=0;const track={stop:()=>stopped++}
  stopMeetingCapture({localParticipant:{trackPublications:new Map([['microphone',{track}],['camera',{track}],['empty',{}]])}} as unknown as Room)
  assert.equal(stopped,2)
})
