export function stopMeetingCapture(room) {
  for (const publication of room.localParticipant.trackPublications.values()) publication.track?.stop();
}
export async function changeMeetingCapture(room, source, enabled, current) {
  if (!current()) return;
  const person = room.localParticipant;
  const sources = source === 'screen_share' ? [source, 'screen_share_audio'] : [source];
  if (!enabled) {
    const tracks = sources.map(item => person.getTrackPublication(item)?.track).filter(Boolean);
    tracks.forEach(track => track.stop());
    const results = await Promise.allSettled(tracks.map(track => person.unpublishTrack(track, true)));
    if (results.some(result => result.status === 'rejected')) throw Error('capture_stop_failed');
    return;
  }
  let published;
  if (source === 'microphone') published = await person.setMicrophoneEnabled(true);
  else if (source === 'camera') published = await person.setCameraEnabled(true);
  else if (source === 'screen_share') published = await person.setScreenShareEnabled(true, { audio: true });
  else throw Error('unsupported_capture_source');
  if (!current()) {
    published?.track?.stop();
    const tracks = sources.map(item => person.getTrackPublication(item)?.track).filter(Boolean);
    tracks.forEach(track => track.stop());
    await Promise.allSettled(tracks.map(track => person.unpublishTrack(track, true)));
  }
}

// Switching an active input can await OS permission just like starting capture.
// A late result belongs to the departed room, never its replacement.
export async function changeMeetingDevice(room, kind, deviceId, current) {
  const source = { audioinput: 'microphone', videoinput: 'camera', audiooutput: null }[kind];
  if (source === undefined || typeof deviceId !== 'string') throw Error('unsupported_device');
  if (!current()) return;
  try {
    if (!await room.switchActiveDevice(kind, deviceId, deviceId !== '')) throw Error('device_change_failed');
  } finally {
    if (!current() && source) {
      const track = room.localParticipant.getTrackPublication(source)?.track;
      if (track) { track.stop(); await room.localParticipant.unpublishTrack(track, true).catch(() => {}); }
    }
  }
}
