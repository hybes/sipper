import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Calls } from '../src/calls.mjs';

test('incoming offers prefer device codecs while outgoing calls inherit the caller capabilities', async () => {
  const ari = new EventEmitter(), requests = [];
  ari.request = async (...args) => { requests.push(args); };
  const calls = new Calls(ari, async () => {}, {});
  for (const incoming of [true, false]) {
    const call = { id: 'fixture', parent: 'caller', incoming, legs: new Map(), expires: Date.now() + 30000 };
    await calls.dial(call, 'PJSIP/fixture', 'device');
    const [, , body, query] = requests.at(-1);
    assert.equal(query.formats, incoming ? 'opus,g722,ulaw,alaw' : undefined);
    assert.equal(query.originator, incoming ? undefined : 'caller');
    assert.deepEqual(body.variables, incoming ? { 'PJSIP_HEADER(add,X-Sipper-Call-ID)': 'fixture' } : {});
  }
});

test('an Asterisk restart ends calls as failed instead of adopting channels from a different startup', async () => {
  const ari = new EventEmitter(), reports=[];
  ari.request=async (method,path) => {
    if(method==='GET' && path==='channels') return [];
    if(method==='DELETE') throw Object.assign(new Error('Gone'),{status:404});
    throw Error('No bridge adoption after server restart');
  };
  const calls=new Calls(ari,async (_method,path,body)=>reports.push([path,body]),{});
  calls.asteriskStartedAt='2026-09-26T17:00:00.000Z';
  for(const incoming of [true,false]) {
    const id=incoming?'incoming':'outgoing';
    calls.restore({calls:[{id,parent:`parent-${id}`,incoming,asteriskStartedAt:'2026-09-26T16:00:00.000Z',reported:true,connected:true,winner:`winner-${id}`,bridge:`bridge-${id}`,legs:[[`winner-${id}`,{}]]}],endings:[]});
  }
  await calls.reconcile(); await calls.tick();
  assert.equal(calls.calls.size,0); assert.equal(calls.pendingEnds.size,0);
  assert.deepEqual(reports.map(([path,body])=>[path,body.reason]),[['calls/incoming','failed'],['calls/outgoing','failed']]);
});

test('reconnection preserves a live bridge and cleans up a hangup missed by the event stream', async () => {
  const ari = new EventEmitter(), requests = [], ended = [];
  let live = [{ id: 'caller', state: 'Up' }, { id: 'winner', state: 'Up' }];
  ari.request = async (method, path) => {
    requests.push([method, path]);
    if (method === 'GET' && path === 'channels') return live;
  };
  const calls = new Calls(ari, async (method, path, body) => {
    if (method === 'GET') return {state:'answered',endRequested:false};
    ended.push([path, body]); return {state:'ended'};
  }, {});
  const call = { id: 'fixture', parent: 'caller', winner: 'winner', connected: true, incoming: true,
    reported: true, bridge: 'sipper-fixture', legs: new Map([['winner', { deviceId: 'phone' }]]) };
  calls.calls.set(call.id, call);
  calls.channels.set('caller', call); calls.channels.set('winner', call);
  await calls.reconcile();
  assert.equal(calls.calls.size, 1);
  assert.equal(requests.filter(([method]) => method === 'DELETE').length, 0);
  live = [{ id: 'winner', state: 'Up' }];
  await calls.reconcile();
  await calls.tick();
  assert.equal(calls.calls.size, 0);
  assert.equal(calls.channels.size, 0);
  assert.ok(requests.some(([method, path]) => method === 'DELETE' && path === 'channels/winner'));
  assert.deepEqual(ended, [['calls/fixture', { event: 'ended', reason: 'completed' }]]);
});

test('outgoing calls report admission, connection, recovery and durable ending with the originating device', async () => {
  const ari = new EventEmitter(), reports = [], persisted = [];
  ari.request = async (method, path) => {
    if (method === 'GET' && path === 'channels') return [{id:'caller',state:'Up'},{id:call.winner,state:'Up'}];
    if (method === 'GET') return {channels:['caller',call.winner]};
  };
  const calls = new Calls(ari, async (method, path, body) => {
    if (path === 'transfers') return {transfers:[]};
    if (method === 'GET') return {state:'answered',endRequested:false};
    reports.push([path,body]);
    if (path === 'outgoing') {
      assert.equal(persisted.at(-1).reported,true,'Journal intent before an uncertain HTTP response');
      return {configurationId:'config',revision:1,deviceId:'device'};
    }
    return {state:body.event==='ended'?'ended':'answered',endRequested:false};
  }, { get: () => ({id:'upstream'}) }, {save: call => persisted.push({...call}),finish:()=>{},acknowledged:()=>{}});
  const call = {id:'outgoing-call',parent:'caller',incoming:false,legs:new Map(),expires:Date.now()+45_000};
  calls.calls.set(call.id,call); calls.channels.set(call.parent,call);
  await calls.start(call,['outgoing',`d${'a'.repeat(32)}`,'2000'],{});
  assert.equal(call.originDeviceId,'device');
  await calls.answered(call,[...call.legs.keys()][0]);
  assert.equal(call.connected,true);
  assert.deepEqual(reports.map(([path])=>path),['outgoing','outgoing','calls/outgoing-call']);
  assert.equal(reports[0][1].callId,call.id); assert.equal(reports[1][1].callId,call.id);
  assert.deepEqual(reports[2][1],{event:'connected',deviceId:'device'});
  call.recovered=true; await calls.reconcile();
  assert.deepEqual(reports.at(-1),['calls/outgoing-call',{event:'connected',deviceId:'device'}]);
  await calls.end(call,'completed'); await calls.tick();
  assert.deepEqual(reports.at(-1),['calls/outgoing-call',{event:'ended',reason:'completed'}]);
});

test('end requests stop new ringing/admission and answer transitions before connecting the caller', async () => {
  for (const stage of ['incoming-start','outgoing-start','incoming-answer','outgoing-answer','connected','poll-incoming','poll-outgoing']) {
    const ari=new EventEmitter(), deleted=[], reports=[];
    ari.request=async (method,path)=>{ if(method==='DELETE') deleted.push(path); assert.notEqual(path,'channels/caller/answer'); };
    const calls=new Calls(ari,async (method,path,body)=>{
      reports.push([method,path,body]);
      const requested=stage==='connected'?body?.event==='connected':true;
      return {state:'ringing',endRequested:requested,configurationId:'config',revision:1,deviceId:'device'};
    },{accounts:new Map([['upstream',{id:'upstream',configurationId:'config',revision:1}]]),get:()=>({id:'upstream'})});
    const call={id:'call',parent:'caller',incoming:stage.includes('incoming'),legs:new Map([['phone',{deviceId:'device'}]]),expires:Date.now()+30000,
      reported:true,configurationId:'config',revision:1,originDeviceId:'device',deviceEndpoint:`d${'a'.repeat(32)}`,destination:'2000'};
    calls.calls.set(call.id,call); calls.channels.set(call.parent,call); calls.channels.set('phone',call);
    if(stage.endsWith('start')) await calls.start(call,call.incoming?['incoming','upstream']:['outgoing',call.deviceEndpoint,'2000'],{});
    else if(stage.startsWith('poll')) await calls.poll(call);
    else await calls.answered(call,'phone');
    assert.equal(call.ended,true,stage); assert.equal(call.endReason,'admin_ended',stage);
    assert.ok(deleted.includes('channels/caller') && deleted.includes('channels/phone'),stage);
    assert.ok(!reports.some(([, ,body])=>body?.event==='ended'),'Report only after teardown is committed');
    await calls.tick();
    assert.deepEqual(reports.at(-1),['POST','calls/call',{event:'ended',reason:'admin_ended'}]);
  }
});
