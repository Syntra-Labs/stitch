/** RFC8484 application/dns-message client boundary. DNSSEC validation and TLS,
 * HTTP negotiation/cache storage remain resolver/browser responsibilities. */
import { refuse } from '../layer1-uor/contracts.js';
import { wireBytes } from '../layer2-schedulers/policy.js';
const types = Object.freeze({ A:1, NS:2, CNAME:5, SOA:6, PTR:12, MX:15, TXT:16, AAAA:28, SRV:33, DS:43, RRSIG:46, DNSKEY:48, TLSA:52, SVCB:64, HTTPS:65, ANY:255, CAA:257 });
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true});
export function dnsQueryName(input) {
 if (typeof input !== 'string' || !input || /[\s/@:#?%\\]/.test(input)) refuse('dns-invalid-name');
 if (input === '.') return '.';
 let name = input.endsWith('.') ? input.slice(0,-1) : input;
 if (/[^\x00-\x7f]/.test(name)) {
  try { name = new URL('https://'+name).hostname; } catch { refuse('dns-invalid-name'); }
 }
 name=name.toLowerCase();
 if (name.length>253 || name.split('.').some(label=>!label || label.length>63 || !/^[a-z0-9_-]+$/.test(label))) refuse('dns-invalid-name');
 return name;
}
export function dnsTypeCode(type) {
 const value = types[String(type).toUpperCase()] ?? (/^\d+$/.test(String(type)) ? Number(type) : 0);
 if (!Number.isSafeInteger(value) || value<1 || value>65535) refuse('dns-query-type');
 return value;
}
export function encodeDnsQuery(name, type='TXT') {
 name=dnsQueryName(name);type=dnsTypeCode(type);
 const labels=name==='.'?[]:name.split('.'), size=12+labels.reduce((n,l)=>n+1+l.length,1)+4;
 const bytes=new Uint8Array(size), view=new DataView(bytes.buffer);
 view.setUint16(2,0x0100);view.setUint16(4,1); // ID0 improves DoH cache reuse; recursion desired.
 let at=12;
 for(const label of labels){bytes[at++]=label.length;bytes.set(enc.encode(label),at);at+=label.length;}
 bytes[at++]=0;view.setUint16(at,type);view.setUint16(at+2,1);
 return {bytes,name,type,id:0};
}
const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const labelText = bytes => Array.from(bytes,b=>b>=33&&b<=126&&b!==46&&b!==92?String.fromCharCode(b):'\\'+String(b).padStart(3,'0')).join('').toLowerCase();
const txtText = bytes => { try{return JSON.stringify(dec.decode(bytes));}catch{return '"'+Array.from(bytes,b=>b>=32&&b<=126&&b!==34&&b!==92?String.fromCharCode(b):'\\'+String(b).padStart(3,'0')).join('')+'"';} };
export function decodeDnsResponse(input, expected, {ageSeconds=0}={}) {
 if (!(input instanceof Uint8Array)||input.length<12||input.length>65535) refuse('dns-message-size');
 if (!Number.isSafeInteger(ageSeconds)||ageSeconds<0) refuse('dns-http-age');
 const bytes=new Uint8Array(input), view=new DataView(bytes.buffer), length=bytes.length;
 const need=(at,n,end=length)=>{if(at<0||at+n>end)refuse('dns-message-truncated');};
 const u16=at=>{need(at,2);return view.getUint16(at);}, u32=at=>{need(at,4);return view.getUint32(at);};
 function nameAt(start,end=length,allowCompression=true){
  let at=start,next=null,wireLength=1;const parts=[],seen=new Set();
  for(;;){
   need(at,1,next===null?end:length);if(seen.has(at))refuse('dns-compression-cycle');seen.add(at);
   const n=bytes[at];
   if((n&0xc0)===0xc0){if(!allowCompression)refuse('dns-name-compression-forbidden');need(at,2,next===null?end:length);const target=((n&63)<<8)|bytes[at+1];if(target<12||target>=at)refuse('dns-compression-pointer');if(next===null)next=at+2;at=target;continue;}
   if(n&0xc0)refuse('dns-label-kind');at++;
   if(n===0)return {name:parts.length?parts.join('.'):'.',next:next??at};
   need(at,n,next===null?end:length);wireLength+=n+1;if(wireLength>255)refuse('dns-name-size');
   parts.push(labelText(bytes.subarray(at,at+n)));at+=n;
  }
 }
 const id=u16(0),flags=u16(2),qd=u16(4),counts=[u16(6),u16(8),u16(10)];
 if(id!==(expected.id??0)||!(flags&0x8000)||(flags&0x7800)||(flags&0x0040)||qd!==1)refuse('dns-response-header');
 if(flags&0x0200)refuse('dns-response-truncated');
 let at=12;const question=nameAt(at);at=question.next;need(at,4);
 if(question.name!==dnsQueryName(expected.name)||u16(at)!==dnsTypeCode(expected.type)||u16(at+2)!==1)refuse('dns-question-mismatch');at+=4;
 function record(){
  const owner=nameAt(at);at=owner.next;need(at,10);
  const type=u16(at),klass=u16(at+2),wireTtl=u32(at+4),size=u16(at+8);at+=10;
  const start=at,end=at+size;need(at,size);
  const r={name:owner.name,type,class:klass,TTL:wireTtl>0x7fffffff?0:wireTtl,rdata:new Uint8Array(bytes.subarray(start,end))};
  const exact=p=>{if(p!==end)refuse('dns-rdata-length');};
  if(type===16){const strings=[];let p=start;while(p<end){const n=bytes[p++];need(p,n,end);strings.push(new Uint8Array(bytes.subarray(p,p+n)));p+=n;}if(!strings.length)refuse('dns-txt-empty-rdata');r.strings=strings;r.data=strings.map(txtText).join(' ');try{const total=strings.reduce((n,p)=>n+p.length,0),joined=new Uint8Array(total);let offset=0;for(const part of strings){joined.set(part,offset);offset+=part.length;}r.text=dec.decode(joined);}catch{r.text=null;}}
  else if([2,3,4,5,7,8,9,12].includes(type)){const n=nameAt(start,end);exact(n.next);r.data=n.name;}
  else if(type===33){need(start,6,end);const target=nameAt(start+6,end,false);exact(target.next);r.srv={priority:u16(start),weight:u16(start+2),port:u16(start+4),target:target.name};r.data=`${r.srv.priority} ${r.srv.weight} ${r.srv.port} ${r.srv.target}`;}
  else if(type===6){const primary=nameAt(start,end),mailbox=nameAt(primary.next,end);need(mailbox.next,20,end);exact(mailbox.next+20);r.soa={primary:primary.name,mailbox:mailbox.name,serial:u32(mailbox.next),refresh:u32(mailbox.next+4),retry:u32(mailbox.next+8),expire:u32(mailbox.next+12),minimum:u32(mailbox.next+16)};r.data=Object.values(r.soa).join(' ');}
  else if(type===14){const first=nameAt(start,end),second=nameAt(first.next,end);exact(second.next);r.data=first.name+' '+second.name;}
  else if(type===15){need(start,2,end);const exchange=nameAt(start+2,end);exact(exchange.next);r.data=`${u16(start)} ${exchange.name}`;}
  else if(type===1){if(size!==4)refuse('dns-rdata-length');r.data=Array.from(r.rdata).join('.');}
  else if(type===28){if(size!==16)refuse('dns-rdata-length');r.data=Array.from({length:8},(_,i)=>u16(start+i*2).toString(16)).join(':');}
  else if(type===41){if(owner.name!=='.')refuse('dns-opt-owner');r.extendedRcode=wireTtl>>>24;r.ednsVersion=(wireTtl>>>16)&255;let p=start;while(p<end){need(p,4,end);const n=u16(p+2);p+=4;need(p,n,end);p+=n;}r.data=hex(r.rdata);}
  else r.data=`\\# ${size} ${hex(r.rdata)}`; // RFC3597 unknown types stay opaque, never guessed.
  at=end;return r;
 }
 const sections=counts.map(count=>{const records=[];for(let i=0;i<count;i++)records.push(record());return records;});
 if(at!==length)refuse('dns-trailing-data');
 const [answers,authority,additional]=sections,opts=additional.filter(r=>r.type===41);
 if([...answers,...authority].some(r=>r.type===41))refuse('dns-opt-section');
 if(opts.length>1||opts.some(r=>r.ednsVersion!==0))refuse('dns-edns-version');
 const status=(flags&15)|((opts[0]?.extendedRcode??0)<<4);
 if(status!==0&&status!==3)refuse('dns-response-status',`DNS response code ${status}`);
 let terminal=question.name;const chain=[],visited=new Set([terminal]);
 if(![5,255].includes(dnsTypeCode(expected.type))){for(;;){
  const aliases=answers.filter(r=>r.class===1&&r.name===terminal&&r.type===5);
  if(!aliases.length)break;const targets=new Set(aliases.map(r=>r.data));if(targets.size!==1)refuse('dns-cname-conflict');
  if(answers.some(r=>r.class===1&&r.name===terminal&&r.type!==5&&r.type!==46))refuse('dns-cname-conflict');
  terminal=aliases[0].data;if(visited.has(terminal))refuse('dns-cname-cycle');visited.add(terminal);chain.push(...aliases);
 }}
 const type=dnsTypeCode(expected.type),selected=status===3?[]:answers.filter(r=>r.class===1&&r.name===terminal&&(type===255||r.type===type));
 const relevant=selected.length?[...chain,...selected]:authority.filter(r=>r.class===1&&r.type===6&&(r.name==='.'||terminal===r.name||terminal.endsWith('.'+r.name)));
 const lifetimeRecords=selected.length?relevant:[...chain,...relevant];
 const ttl=relevant.length?Math.min(...lifetimeRecords.map(r=>r.type===6?Math.min(r.TTL,r.soa.minimum):r.TTL)):0;
 return {status,question:{name:question.name,type},answers,authority,additional,selected,
  ttlSeconds:Math.max(0,ttl-ageSeconds),negative:status===3||!selected.length,
  authenticatedData:!!(flags&0x20),dnssecValidatedByClient:false};
}
export async function readBoundedDnsBytes(response,maximum=65535){
 const advertised=response.headers?.get?.('content-length');
 if(advertised!==null&&advertised!==undefined&&(!/^\d+$/.test(advertised)||Number(advertised)>maximum))refuse('response-limit');
 if(!response.body?.getReader){const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>maximum)refuse('response-limit');return bytes;}
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)refuse('response-limit');parts.push(value);}const result=new Uint8Array(size);let at=0;for(const p of parts){result.set(p,at);at+=p.length;}return result;}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function queryDnsMessage({name,type='TXT',endpoint='https://cloudflare-dns.com/dns-query',method='POST',fetchImpl=globalThis.fetch?.bind(globalThis),admission}){
 if(!fetchImpl)refuse('dns-fetch-unavailable');
 if(method!=='GET'&&method!=='POST')refuse('dns-http-method');
 const query=encodeDnsQuery(name,type);let url;
 // Configured URI template has one variable, dns. Literal HTTPS URLs are also
 // supported and expanded with that query parameter for GET.
 let configured=String(endpoint),template=/\{(?:[?&+])?dns\}/g;
 if(method==='POST')configured=configured.replace(template,'');
 else {const encoded=btoa(String.fromCharCode(...query.bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if(template.test(configured)){template.lastIndex=0;configured=configured.replace(template,part=>part==='\{?dns\}'?'?dns='+encoded:part==='\{&dns\}'?'&dns='+encoded:encoded);}
  else {try{url=new URL(configured);url.searchParams.set('dns',encoded);configured=url.href;}catch{refuse('dns-endpoint');}}
 }
 try{url=new URL(configured);}catch{refuse('dns-endpoint');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||/[{}]/.test(configured))refuse('dns-endpoint');
 if(method==='POST')url.searchParams.delete('dns');
 admission?.reserve('retrieve',{requests:1,transferBytes:wireBytes(url.href)+(method==='POST'?query.bytes.length:0)+65535});
 const start=performance.now();
 const response=await fetchImpl(url.href,{method,headers:{accept:'application/dns-message',...(method==='POST'?{'content-type':'application/dns-message'}:{})},...(method==='POST'?{body:query.bytes}:{}),credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});
 if(!response.ok)refuse('dns-http-status',`DoH HTTP ${response.status}`);
 if(response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase()!=='application/dns-message')refuse('dns-media-type');
 const observedAge=response.headers?.get?.('age');const age=observedAge??'0';if(!/^\d+$/.test(age)||!Number.isSafeInteger(Number(age)))refuse('dns-http-age');
 const result=decodeDnsResponse(await readBoundedDnsBytes(response),query,{ageSeconds:Number(age)});
 if(response.type==='cors'&&observedAge===null)result.ttlSeconds=0;
 return {...result,httpAgeObserved:observedAge!==null,rttMs:Number((performance.now()-start).toFixed(1)),httpAgeSeconds:Number(age),endpoint:url.origin+url.pathname};
}
