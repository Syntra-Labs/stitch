import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readProduct, validateProduct, productRegister, literalRows } from '../scripts/check-product.mjs';
const root=resolve(import.meta.dirname,'..');
const source=()=>readProduct(root);
const changed=fn=>{const p=structuredClone(source());fn(p);return p;};
test('complete product register is bound to current source and exact local assets',()=>{
  const expected=productRegister(root);
  assert.deepEqual(JSON.parse(readFileSync(resolve(root,'product/contracts.json'),'utf8')),expected);
  assert.equal(expected.components.length,18);
  assert.equal(expected.capabilities.length,expected.hostCapabilities.length);
  assert.equal(expected.releaseBlockers.length,5);
  for(const a of expected.assets){assert.match(a.sha256,/^[0-9a-f]{64}$/);assert.ok(a.bytes>0);}
  assert.equal(expected.assurance.includes('not a Prism receipt'),true);
});
test('dangling contract owner is refused',()=>assert.throws(()=>validateProduct(changed(p=>p.capabilities[0].owner='missing'),root),/unknown capability owner/));
test('undeclared assumptions are refused',()=>assert.throws(()=>validateProduct(changed(p=>p.capabilities[0].assumptions.push('invented')),root),/unknown assumption/));
test('omitted capability coverage is refused',()=>assert.throws(()=>validateProduct(changed(p=>p.capabilities.pop()),root),/capability coverage/));
test('duplicate components are refused',()=>assert.throws(()=>validateProduct(changed(p=>p.components.push(p.components[0])),root),/duplicate/));
test('missing component assets are refused',()=>assert.throws(()=>validateProduct(changed(p=>p.assets=p.assets.filter(a=>a.path!=='index.html')),root),/unregistered component asset/));
test('unknown deployment capabilities are refused',()=>assert.throws(()=>validateProduct(changed(p=>p.deployments[0].requiredCapabilities.push('bgp')),root),/unknown deployment capability/));
test('dangling architecture flows are refused',()=>assert.throws(()=>validateProduct(changed(p=>p.architecture.find(x=>x.type==='Foundation.Arch::Edge').toIndex=999),root),/dangling architecture edge/));
test('architecture indexes are sorted positions, not discretionary scores',()=>assert.throws(()=>validateProduct(changed(p=>p.architecture.find(x=>x.type==='Foundation.Arch::Component').index=50),root),/noncanonical architecture index/));
test('relay opt-in cannot be silently removed',()=>assert.throws(()=>validateProduct(changed(p=>p.capabilities.find(x=>x.capability==='PublicRelay').enabledByDefault=true),root),/relay consent boundary/));
test('native routing cannot be claimed supported in browser',()=>assert.throws(()=>validateProduct(changed(p=>p.capabilities.find(x=>x.capability==='NativeRouting').enabledByDefault=true),root),/native routing overclaim/));
test('literal register reader refuses duplicate fields and executable substitutions',()=>{
  const header='definition{\n name: x,\n parameters: [],\n result: Component,\n body: ';
  assert.throws(()=>literalRows(header+'(record Component {id := "x", id := "y"})\n}'),/duplicate field/);
  assert.throws(()=>literalRows(header+'(record Component {id := (computeIdentity)})\n}'),/unsupported literal/);
});
test('asset substitution changes the exact artifact identity without inventing provenance',()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'stitch-product-mutation-'));
  try{
    for(const path of ['app','src','v86','images','index.html','package.json','package-lock.json','prismpm.lock','standards.lock','CONTRACT.json'])cpSync(resolve(root,path),resolve(dir,path),{recursive:true});
    const before=productRegister(dir);writeFileSync(resolve(dir,'v86/seabios.bin'),new Uint8Array([0,1,2,3]));
    const after=productRegister(dir);
    assert.notEqual(before.assets.find(x=>x.path==='v86/seabios.bin').sha256,after.assets.find(x=>x.path==='v86/seabios.bin').sha256);
    assert.equal(after.releaseBlockers.some(x=>x.path==='v86/seabios.bin'),true);
  } finally{rmSync(dir,{recursive:true,force:true});}
});
