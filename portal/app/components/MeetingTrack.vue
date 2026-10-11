<script setup lang="ts">
import { Track } from 'livekit-client'
const props=defineProps<{track:Track;local?:boolean}>(),element=ref<HTMLMediaElement>()
let attached:{track:Track;element:HTMLMediaElement}|undefined
function detach() {if(attached){attached.track.detach(attached.element);attached.element.srcObject=null;attached=undefined}}
watch(()=>[props.track,element.value],()=>{
  detach()
  if(element.value){props.track.attach(element.value);element.value.muted=Boolean(props.local);attached={track:props.track,element:element.value}}
},{flush:'post',immediate:true})
onBeforeUnmount(detach)
</script>
<template>
  <video v-if="track.kind==='video'" ref="element" autoplay playsinline :muted="local" class="aspect-video max-h-[50vh] w-full bg-stone-950 object-contain" />
  <audio v-else ref="element" autoplay />
</template>
