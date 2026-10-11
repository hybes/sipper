import { Track, type Room } from 'livekit-client'

export function stopMeetingCapture(room:Room) {
  for(const publication of room.localParticipant.trackPublications.values())publication.track?.stop()
}
export async function changeMeetingCapture(room:Room,source:Track.Source,enabled:boolean,current:()=>boolean) {
  if(!current())return
  const participant=room.localParticipant
  const sources=source===Track.Source.ScreenShare ? [source,Track.Source.ScreenShareAudio] : [source]
  if(!enabled) {
    const tracks=sources.map(item=>participant.getTrackPublication(item)?.track).filter(track=>Boolean(track))
    // Stop capture before network work, including both screen video and audio.
    tracks.forEach(track=>track!.stop())
    const results=await Promise.allSettled(tracks.map(track=>participant.unpublishTrack(track!,true)))
    if(results.some(result=>result.status==='rejected'))throw Error('capture_stop_failed')
    return
  }
  let published
  if(source===Track.Source.Microphone)published=await participant.setMicrophoneEnabled(true)
  else if(source===Track.Source.Camera)published=await participant.setCameraEnabled(true)
  else if(source===Track.Source.ScreenShare)published=await participant.setScreenShareEnabled(true,{audio:true})
  else throw Error('unsupported_capture_source')
  // A permission picker may outlive the page or this exact room connection.
  if(!current()) {
    published?.track?.stop()
    const tracks=sources.map(item=>participant.getTrackPublication(item)?.track).filter(track=>Boolean(track))
    tracks.forEach(track=>track!.stop())
    await Promise.allSettled(tracks.map(track=>participant.unpublishTrack(track!,true)))
  }
}
