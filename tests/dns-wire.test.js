import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDnsQuery, decodeDnsResponse, queryDnsMessage, readBoundedDnsBytes } from '../src/layer5-transport/dns-wire.js';
const u16=n=>[n>>8&255,n&255],u32=n=>[n>>>24,n>>>16&255,n>>>8&255,n&255];
const name=s=>s==='.'?[0]:[...s.split('.').flatMap(l=>[l.length,...Buffer.from(l)]),0];
const txt=s=>[Buffer.byteLength(s),...Buffer.from(s)];
function answer({type=16,ttl=60,owner=[0xc0,0x0c],data=txt('hello'),klass=1}={}){return [...owner,...u16(type),...u16(klass),...u32(ttl),...u16(data.length),...data];}
function packet({query=encodeDnsQuery('example.test','TXT'),flags=0x8180,answers=[answer()],authority=[],additional=[]}={}){
 const q=query.bytes;return Uint8Array.from([0,0,...u16(flags),0,1,...u16(answers.length),...u16(authority.length),...u16(additional.length),...q.subarray(12),...answers.flat(),...authority.flat(),...additional.flat()]);
}
const expected=encodeDnsQuery('example.test','TXT');
const reject=(p,code)=>assert.throws(()=>decodeDnsResponse(p,expected),e=>!code||e.code===code);
test('RFC8484 query uses ID0, recursion desired, typed IN question and valid DNS names',()=>{
 assert.equal(Buffer.from(encodeDnsQuery('www.example.com','A').bytes).toString('hex'),'00000100000100000000000003777777076578616d706c6503636f6d0000010001');
 assert.equal(encodeDnsQuery('BÜCHER.Example.','TXT').name,'xn--bcher-kva.example');
 assert.equal(encodeDnsQuery('_stitch._udp.example.test','SRV').type,33);
 for(const value of ['bad..name','https://example.test','a'.repeat(64)+'.test','user@host','one test'])assert.throws(()=>encodeDnsQuery(value));
 for(const type of [0,65536,'BOGUS'])assert.throws(()=>encodeDnsQuery('example.test',type));
});
test('DNS compressed owners, complete TXT strings, SRV and opaque unknown RDATA decode',()=>{
 const response=decodeDnsResponse(packet({answers:[answer({data:[...txt('one'),...txt('two')]})]}),expected,{ageSeconds:7});
 assert.equal(response.selected[0].data,'"one" "two"');assert.equal(response.ttlSeconds,53);
 const query=encodeDnsQuery('_stitch._udp.example.test','SRV');
 const srv=decodeDnsResponse(packet({query,answers:[answer({type:33,data:[...u16(2),...u16(3),...u16(443),...name('target.example.test')]})]}),query);
 assert.deepEqual(srv.selected[0].srv,{priority:2,weight:3,port:443,target:'target.example.test'});
 const unknown=encodeDnsQuery('example.test',65000);
 assert.equal(decodeDnsResponse(packet({query:unknown,answers:[answer({type:65000,data:[1,2,3]})]}),unknown).selected[0].data,'\\# 3 010203');
});
test('CNAME association, negative SOA lifetime and Age never become signature or DNSSEC proof',()=>{
 const result=decodeDnsResponse(packet({answers:[answer({type:5,ttl:5,data:name('target.test')}),answer({owner:name('target.test'),ttl:90})]}),expected,{ageSeconds:6});
 assert.equal(result.selected.length,1);assert.equal(result.ttlSeconds,0);
 const soa=[...name('ns.example.test'),...name('hostmaster.example.test'),...u32(1),...u32(2),...u32(3),...u32(4),...u32(30)];
 const negative=decodeDnsResponse(packet({flags:0x81a3,answers:[],authority:[answer({type:6,ttl:60,data:soa})]}),expected,{ageSeconds:10});
 assert.equal(negative.negative,true);assert.equal(negative.status,3);assert.equal(negative.ttlSeconds,20);assert.equal(negative.authenticatedData,true);assert.equal(negative.dnssecValidatedByClient,false);
 assert.equal(decodeDnsResponse(packet({answers:[answer({ttl:0xffffffff})]}),expected).ttlSeconds,0);
});
test('malformed/truncated/compression/header/question and RDATA cases fail before association',()=>{
 const valid=packet();for(let i=0;i<valid.length;i++)reject(valid.slice(0,i));
 const id=valid.slice();id[1]=1;reject(id,'dns-response-header');
 const question=valid.slice();question[13]=120;reject(question,'dns-question-mismatch');
 reject(packet({flags:0x8380}),'dns-response-truncated');reject(packet({flags:0x0180}),'dns-response-header');
 reject(Uint8Array.from([...valid,0]),'dns-trailing-data');
 reject(packet({answers:[answer({owner:[0xc0,0xff]})]}),'dns-compression-pointer');
 reject(packet({answers:[answer({owner:[0xc0,0x00]})]}),'dns-compression-pointer');
 reject(packet({answers:[answer({owner:[64,1]})]}),'dns-label-kind');
 reject(packet({answers:[answer({data:[8,65]})]}),'dns-message-truncated');
 reject(packet({answers:[answer({type:5,data:[0xc0,0x0c]})]}),'dns-cname-cycle');
 reject(packet({answers:[answer({type:1,data:[1,2,3]})]}),'dns-rdata-length');
 reject(packet({flags:0x8182}),'dns-response-status');
});
test('DoH POST and GET/URI template use DNS-message with bounded response and no credentials',async()=>{
 for(const [method,endpoint] of [['POST','https://resolver.test/dns-query{?dns}'],['GET','https://resolver.test/dns-query{?dns}'],['GET','https://resolver.test/dns-query?x=1'],['GET','https://resolver.test/dns-query?dns={dns}']]){
  const reservations=[],calls=[];
  const result=await queryDnsMessage({name:'example.test',type:'TXT',method,endpoint,admission:{reserve:(...args)=>reservations.push(args)},fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(packet(),{headers:{'content-type':'application/dns-message','age':'5'}});}});
  const {url,options}=calls[0];assert.equal(options.headers.accept,'application/dns-message');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(result.ttlSeconds,55);assert.equal(reservations.length,1);
  if(method==='POST'){assert.deepEqual(options.body,expected.bytes);assert.equal(options.headers['content-type'],'application/dns-message');}
  else{const encoded=new URL(url).searchParams.get('dns');assert.ok(/^[A-Za-z0-9_-]+$/.test(encoded));assert.deepEqual(new Uint8Array(Buffer.from(encoded,'base64url')),expected.bytes);assert.equal(options.body,undefined);}
 }
});
test('HTTP errors/media/age/endpoint and oversized body never produce DNS success',async()=>{
 for(const response of [new Response('bad',{status:503}),new Response(packet(),{headers:{'content-type':'application/json'}}),new Response(packet(),{headers:{'content-type':'application/dns-message','age':'-1'}})])await assert.rejects(queryDnsMessage({name:'example.test',fetchImpl:async()=>response}));
 for(const endpoint of ['http://resolver.test/dns-query','https://user:pass@resolver.test/dns-query','https://resolver.test/path#fragment'])await assert.rejects(queryDnsMessage({name:'example.test',endpoint,fetchImpl:()=>{throw Error('must not fetch');}}));
 let cancelled=false;await assert.rejects(readBoundedDnsBytes(new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}}))),e=>e.code==='response-limit');assert.equal(cancelled,true);
});
test('TXT bytes can cross UTF8 boundaries; ANY returns owner alias without chasing away answer',()=>{
 const result=decodeDnsResponse(packet({answers:[answer({data:[1,0xe2,2,0x82,0xac]})]}),expected);
 assert.equal(result.selected[0].text,'€');
 const query=encodeDnsQuery('example.test','ANY');
 assert.equal(decodeDnsResponse(packet({query,answers:[answer({type:5,data:name('target.test')})]}),query).selected[0].type,5);
});
test('default public resolver uses actual DNS-message; vendor JSON remains explicit',async()=>{
 const {DohResolver}=await import('../src/layer5-transport/index.js');let sent;
 const resolver=new DohResolver({fetchImpl:async(url,options)=>{sent=options;return new Response(packet(),{headers:{'content-type':'application/dns-message'}});}});
 const result=await resolver.resolve('example.test','TXT');assert.equal(sent.headers['content-type'],'application/dns-message');assert.deepEqual(result.rawRecords,['hello']);assert.equal(result.cache_hit_inferred,false);
});
test('SRV forbids target compression and OPT belongs only in Additional',()=>{
 const query=encodeDnsQuery('example.test','SRV');
 assert.throws(()=>decodeDnsResponse(packet({query,answers:[answer({type:33,data:[0,0,0,0,0,80,0xc0,0x0c]})]}),query),e=>e.code==='dns-name-compression-forbidden');
 reject(packet({answers:[answer({owner:[0],type:41,data:[],klass:4096})]}),'dns-opt-section');
 reject(packet({answers:[],authority:[answer({owner:[0],type:41,data:[],klass:4096})]}),'dns-opt-section');
});
test('negative CNAME result lifetime includes alias chain and hidden CORS Age is not zero evidence',async()=>{
 const soa=[...name('ns.test'),...name('mail.test'),...u32(1),...u32(2),...u32(3),...u32(4),...u32(30)];
 const data=packet({flags:0x8183,answers:[answer({type:5,ttl:1,data:name('target.test')})],authority:[answer({owner:name('test'),type:6,ttl:60,data:soa})]});
 assert.equal(decodeDnsResponse(data,expected).ttlSeconds,1);
 const response=new Response(packet(),{headers:{'content-type':'application/dns-message'}});Object.defineProperty(response,'type',{value:'cors'});
 const result=await queryDnsMessage({name:'example.test',fetchImpl:async()=>response});assert.equal(result.selected.length,1);assert.equal(result.ttlSeconds,0);assert.equal(result.httpAgeObserved,false);
});
