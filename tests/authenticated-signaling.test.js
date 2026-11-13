import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalSession } from '../src/layer5-transport/signaling.js';
import { WebRtcTransportNode } from '../src/layer5-transport/index.js';

async function pair() {
  const a = new SignalSession('mesh'), b = new SignalSession('mesh');
  const challenge = await b.receive(await a.sign({ kind: 'announce' }));
  const response = await a.receive(await b.sign(challenge.reply));
  const joined = await b.receive(await a.sign(response.reply));
  assert.equal(joined.message.kind, 'announce');
  return { a, b };
}

test('public discovery requires signed session challenge before SDP admission', async () => {
  const a = new SignalSession('mesh'), b = new SignalSession('mesh');
  const announce = await a.sign({ kind: 'announce' });
  const result = await b.receive(announce);
  assert.equal(result.message, undefined);
  assert.equal(result.reply.kind, 'hello');
  assert.equal(await b.receive({kind:'offer',from:a.id,channelKey:'mesh',sdp:{}}), null);
  assert.equal(await b.receive(await a.sign({kind:'offer',to:(await b.identity()).id,targetSession:b.session,sdp:{type:'offer'}})), null);
});

test('signed SDP binds key/channel/destination/session and rejects concurrent replay', async () => {
  const {a,b} = await pair();
  const offer = await a.sign({kind:'offer',to:b.id,sdp:{type:'offer',sdp:'signed'}});
  const results = await Promise.all([b.receive(offer),b.receive(offer)]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(results.find(Boolean).message.sdp.sdp,'signed');
  for (const change of [{from:'key-forged'},{channelKey:'other'},{targetSession:a.session},{payload:{kind:'offer',sdp:{sdp:'injected'}}}]) {
    assert.equal(await b.receive({...offer,...change}), null);
  }
});

test('new key cannot impersonate bound key; reconnect invalidates old directed envelopes', async () => {
  const {a,b} = await pair(), attacker = new SignalSession('mesh');
  const forged = await attacker.sign({kind:'offer',to:b.id,targetSession:b.session,sdp:{}});
  assert.equal(await b.receive({...forged,from:a.id}),null);
  const old = await a.sign({kind:'offer',to:b.id,sdp:{}});
  b.close(); const fresh = new SignalSession('mesh');
  assert.equal(await b.receive(old),null);
  assert.equal(await fresh.receive(old),null);
});

test('bounded discovery and authentication do not evict anti-replay records', async () => {
  const b = new SignalSession('mesh',{maxPeers:1});
  const a = new SignalSession('mesh'), c = new SignalSession('mesh');
  assert.ok(await b.receive(await a.sign({kind:'announce'})));
  assert.equal(await b.receive(await c.sign({kind:'announce'})),null);
  assert.equal(b.pending.size,1);
});

test('live transport rejects unsigned SDP before allocating RTC peers', async () => {
  const node = new WebRtcTransportNode({channelKey:'mesh'});
  await node.handleSignal({kind:'offer',from:'claimed-victim',channelKey:'mesh',sdp:{}});
  assert.equal(node.peers.size,0);
  node.close();
});

test('two transport nodes negotiate using only authenticated relay envelopes', async t => {
  let dataChannelsCreated = 0;
  class Peer {
    signalingState = 'stable'; connectionState = 'new';
    createDataChannel() { dataChannelsCreated++; return { readyState:'connecting',close(){} }; }
    async createOffer() { return {type:'offer',sdp:'offer'}; }
    async createAnswer() { return {type:'answer',sdp:'answer'}; }
    async setLocalDescription(sdp) { this.localDescription=sdp; this.signalingState=sdp.type==='offer'?'have-local-offer':'stable'; }
    async setRemoteDescription(sdp) { this.remoteDescription=sdp; this.signalingState=sdp.type==='offer'?'have-remote-offer':'stable'; }
    close() {}
  }
  for (const [name,value] of Object.entries({RTCPeerConnection:Peer,RTCSessionDescription:class {constructor(sdp){Object.assign(this,sdp);}}})) {
    const old=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
    t.after(()=>old?Object.defineProperty(globalThis,name,old):delete globalThis[name]);
  }
  const a=new WebRtcTransportNode({channelKey:'mesh'}),b=new WebRtcTransportNode({channelKey:'mesh'}), queue=[];
  t.after(()=>{a.close();b.close();});
  for(const [node,other] of [[a,b],[b,a]]) t.mock.method(node,'_queueRelay',async snapshot=>{queue.push([other,JSON.parse(snapshot.raw)]);return true;});
  a.sendSignal({kind:'announce'});
  for(let step=0;step<20;step++) {
    await Promise.all([a,b].flatMap(n=>[...n.signalSigning.values()].map(j=>j.completion)));
    if(!queue.length)break;
    const [node,message]=queue.shift(); await node.handleSignal(message);
  }
  assert.equal(queue.length,0);
  assert.equal(dataChannelsCreated,1, 'a pair must negotiate exactly one application channel, not crossing channels');
  assert.equal(a.peers.size,1);assert.equal(b.peers.size,1);
  assert.ok(a.peers.get(b.signaling.id).pc.remoteDescription);
  assert.ok(b.peers.get(a.signaling.id).pc.remoteDescription);
  const before=a.peers.get(b.signaling.id).pc.remoteDescription;
  await a.handleSignal({kind:'offer',from:b.signaling.id,channelKey:'mesh',sdp:{type:'offer',sdp:'evil'}});
  assert.equal(a.peers.get(b.signaling.id).pc.remoteDescription,before);
});

test('storage placement uses authenticated route identity rather than display label', async t => {
  const {LiveUorMeshDatabase}=await import('../src/layer3-storage/index.js');
  const {createObject}=await import('../src/layer3-storage/custody.js');
  const node=new WebRtcTransportNode({peerId:'friendly-label',channelKey:'mesh'});
  t.after(()=>node.close());
  await node.signaling.identity();
  assert.notEqual(node.routingPeerId,node.peerId);
  const db=new LiveUorMeshDatabase({transport:node});
  const bundle=await createObject(new Uint8Array([1,2,3]));
  const packet=db._packet({manifest:bundle.manifest,label:'sample'},0,bundle.fragments[0].bytes,
    {purpose:'placement',requestId:'request-1',holder:node.routingPeerId,leaseExpiresAt:Date.now()+10000});
  assert.equal(db._readPacket(packet).holder,node.routingPeerId);
  assert.throws(()=>db._readPacket({...packet,holder:node.peerId}));
});

test('distinct offer and ICE remain in arrival order across delayed verification and RTC application', async t => {
  const {a,b}=await pair();
  const offer=await a.sign({kind:'offer',to:b.id,sdp:{type:'offer',sdp:'ordered'}});
  const ice=await a.sign({kind:'ice',to:b.id,candidate:{candidate:'ordered'}});
  let releaseVerify,releaseApply,enteredVerify,enteredApply;
  const verifyGate=new Promise(r=>releaseVerify=r), applyGate=new Promise(r=>releaseApply=r);
  const verifying=new Promise(r=>enteredVerify=r), applying=new Promise(r=>enteredApply=r);
  const original=crypto.subtle.verify.bind(crypto.subtle);let calls=0;
  t.mock.method(crypto.subtle,'verify',async(...args)=>{
    if(++calls===1){enteredVerify();await verifyGate;}
    return original(...args);
  });
  const order=[];
  const first=b.receive(offer,async result=>{order.push(result.message.kind);enteredApply();await applyGate;});
  await verifying;
  const second=b.receive(ice,result=>{order.push(result.message.kind);});
  await Promise.resolve();assert.equal(calls,1);
  releaseVerify();await applying;
  await Promise.resolve();assert.equal(calls,1);assert.deepEqual(order,['offer']);
  releaseApply();const results=await Promise.all([first,second]);
  assert.ok(results.every(Boolean));assert.deepEqual(order,['offer','ice']);
  assert.equal(await b.receive(offer),null);assert.equal(await b.receive(ice),null);
  assert.equal(b.verifying,0);assert.equal(b.queuedBytes,0);
});
