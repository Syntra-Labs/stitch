/** Implementation conformance and planted-defect checks, not a Lean substitute. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { model, budgetReserveAllowed, budgetSettlementAllowed, pointerSuccessorAllowed, custodyCommitAllowed, checkpointLinkAllowed, modelSourceDigest } from '../src/layer1-uor/generated-model.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const call=(name,...args)=>model['Stitch.'+name](...args);
const digest=Object.fromEntries(Array.from({length:8},(_,i)=>['w'+i,BigInt(i)]));
const placement={manifestRoot:digest,revision:0,holder0:0,holder1:1,holder2:2,active0:true,active1:true,active2:true};
test('source binding metadata is explicit and rejects inexact Nat or Boolean inputs',()=>{
  assert.match(modelSourceDigest,/^sha256:[0-9a-f]{64}$/);
  for(const value of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1'])assert.throws(()=>budgetReserveAllowed(value,0,0,1,0,0,1),TypeError);
  assert.throws(()=>budgetSettlementAllowed(1,1,1,1),TypeError);
  assert.equal(budgetReserveAllowed(2n**64n-1n,0n,1n,2n**64n-1n,0n,0n,1n),false);
});
test('every selected recovery pair agrees on the complete finite-stream corpus',()=>{
  const end={tag:'End',fields:[]};
  for(let length=0;length<=5;length++)for(let value=0;value<4**length;value++){
    let blocks=end,v=value;
    for(let i=0;i<length;i++){blocks={tag:'More',fields:[Boolean(v&1),Boolean(v&2),blocks]};v>>=2;}
    for(const tag of ['Systematic','LeftParity','RightParity']){
      const selection={tag,fields:[]};
      assert.deepEqual(call('Fragments.decodePair',call('Fragments.encodeForPair',blocks,selection),selection),blocks);
    }
  }
});
test('source budgets preserve charge and recovery transitions preserve valid custody',()=>{
  for(let spent=0;spent<=4;spent++)for(let reserved=0;reserved<=4;reserved++)for(let ceiling=0;ceiling<=5;ceiling++)for(let actual=0;actual<=6;actual++)for(const known of [true,false]){
    const afterSpent=call('Budget.settleSpent',spent,reserved,ceiling,actual,known),afterReserved=call('Budget.settleReserved',reserved,ceiling,actual,known);
    assert.ok(afterSpent+afterReserved<=BigInt(spent+reserved));
    if(!known)assert.equal(afterReserved,BigInt(reserved));
  }
  for(let active=0;active<8;active++){
    const p={...placement,active0:Boolean(active&1),active1:Boolean(active&2),active2:Boolean(active&4)};
    if(!call('Custody.recoverable',p))continue;
    for(let index=0;index<=3;index++)for(let target=0;target<=3;target++)for(const committed of [true,false])assert.equal(call('Custody.recoverable',call('Custody.replaceIndex',p,index,target,committed)),true);
    assert.equal(call('Custody.recoverable',call('Custody.retireFirst',p)),true);
  }
  assert.equal(call('Custody.physicalBytes',[{index:0,holder:0,byteLength:7,retained:true,superseded:true,externalRelay:false},{index:1,holder:1,byteLength:9,retained:true,superseded:false,externalRelay:true}]),16n);
});
test('full-byte equality and every external-observation admission flag fail closed',()=>{
  const base={objectRoot:digest,representationRoot:digest,recoveredBytes:Uint8Array.of(0,1,255),expectedBytes:Uint8Array.of(0,1,255),decoderBound:true,dependenciesPresent:true};
  assert.equal(call('Encoding.exactRecovery',base),true);
  assert.equal(call('Encoding.exactRecovery',{...base,expectedBytes:Uint8Array.of(0,1,254)}),false);
  assert.equal(call('Encoding.exactRecovery',{...base,dependenciesPresent:false}),false);
  assert.equal(custodyCommitAllowed(...Array(8).fill(true)),true);
  for(let i=0;i<8;i++){const flags=Array(8).fill(true);flags[i]=false;assert.equal(custodyCommitAllowed(...flags),false);}
  for(let i=0;i<3;i++){const flags=[true,true,true];flags[i]=false;assert.equal(pointerSuccessorAllowed(4,5,...flags,0,10,1),false);}
  assert.equal(checkpointLinkAllowed(true,true,true,true,true,true,1,1,2),false);
});

test('the complete source checkpoint verifier replays values rather than trusting a replay flag',()=>{
  const job={jobRoot:digest,inputRoot:digest,initialValue:255,program:{programRoot:digest,modelRoot:digest,bits:8,instructions:[{opcode:4,argument:1},{opcode:2,argument:0}]}};
  const checkpoint={jobRoot:digest,programRoot:digest,inputRoot:digest,modelRoot:digest,step:2,priorRoot:digest,stateRoot:digest,checkpointRoot:digest,value:1};
  assert.equal(call('Compute.checkpointMatchesJob',job,checkpoint),true);
  assert.equal(call('Compute.checkpointMatchesJob',job,{...checkpoint,value:2}),false);
  assert.equal(call('Compute.checkpointMatchesJob',job,{...checkpoint,step:3}),false);
  assert.equal(call('Compute.jobAllowed',job,2),true);
  assert.equal(call('Compute.jobAllowed',job,1),false);
});

const rootAt=n=>Object.fromEntries(Array.from({length:8},(_,i)=>['w'+i,BigInt(n+i)]));
const resources=(transferBytes=0,storageBytes=0,computeWork=0,refreshRequests=0)=>({transferBytes,storageBytes,computeWork,refreshRequests});
function migrationFixture(){
  const receipt={requestRoot:rootAt(10),manifestRoot:digest,fragmentRoot:rootAt(20),holderId:3,index:0,observedAt:10,leaseUntil:50,identityAuthenticated:true};
  const transfer={requestRoot:receipt.requestRoot,manifestRoot:receipt.manifestRoot,fragmentRoot:receipt.fragmentRoot,sourceHolder:0,targetHolder:3,index:0,placementRevision:0,phase:{tag:'Requested',fields:[]},receipt};
  const fragment={manifestRoot:digest,encodingRoot:rootAt(30),index:0,payloadRoot:receipt.fragmentRoot,payload:Uint8Array.of(1,2),byteLength:2};
  const state={objects:[],encodings:[],placement,peers:[],pointers:[],jobs:[],checkpoints:[],budget:{epoch:0,start:0,end:100,last:0,limit:resources(100,100,100,100),spent:resources(),reserved:resources()},evidence:[],transfers:[]};
  const integrity={fragmentRoot:receipt.fragmentRoot,encodingRoot:fragment.encodingRoot,index:fragment.index,payload:fragment.payload,digest:{expected:receipt.fragmentRoot,observed:receipt.fragmentRoot,domainMatches:true,canonicalSerializationMatches:true}};
  return {state,transfer,receipt,fragment,integrity,cost:resources(2,2,0,1)};
}
test('typed migration reserves before effects and consumes an exact requested transfer only once',()=>{
  const {state,transfer,receipt,fragment,integrity,cost}=migrationFixture();
  assert.equal(call('System.completeMigrationAllowed',state,transfer,receipt,fragment,integrity,20),false);
  assert.deepEqual(call('System.applyMigration',state,transfer,receipt,fragment,integrity,20),call('System.requestMigration',state,transfer,resources(101),10));
  const requested=call('System.requestMigration',state,transfer,cost,10);
  assert.equal(call('System.valid',requested),true);
  assert.deepEqual(requested.placement,call('Custody.replaceIndex',placement,3,0,false));
  assert.deepEqual(requested.budget.reserved,resources(2n,2n,0n,1n));
  assert.equal(requested.transfers.length,1);
  assert.equal(call('System.requestMigrationAllowed',requested,transfer,cost,10),false);
  const completed=call('System.applyMigration',requested,transfer,receipt,fragment,integrity,20);
  assert.equal(completed.placement.holder0,3n);
  assert.equal(completed.placement.revision,1n);
  assert.equal(completed.transfers[0].phase.tag,'Committed');
  assert.equal(call('System.valid',completed),true);
  assert.deepEqual(completed.budget.reserved,requested.budget.reserved);
  assert.deepEqual(completed.budget.spent,requested.budget.spent);
  assert.equal(completed.budget.last,20n);
  assert.deepEqual(completed.evidence,requested.evidence);
  assert.equal(call('System.completeMigrationAllowed',completed,transfer,receipt,fragment,integrity,21),false);
  assert.deepEqual(call('System.applyMigration',completed,transfer,receipt,fragment,integrity,21),completed);
  assert.equal(call('System.requestMigrationAllowed',completed,transfer,cost,22),false);
  const next={...transfer,requestRoot:rootAt(90),sourceHolder:3,targetHolder:4,placementRevision:1};
  assert.equal(call('System.requestMigrationAllowed',completed,next,cost,19),false);
  assert.equal(call('System.requestMigrationAllowed',completed,next,cost,21),true);
});
test('typed migration refuses mismatched requests, receipts, fragments, expired leases and stale placement revisions',()=>{
  const {state,transfer,receipt,fragment,integrity,cost}=migrationFixture();
  const requested=call('System.requestMigration',state,transfer,cost,10);
  for(const field of ['requestRoot','manifestRoot','fragmentRoot']){
    assert.equal(call('System.completeMigrationAllowed',requested,{...transfer,[field]:rootAt(99)},receipt,fragment,integrity,20),false,field);
    assert.equal(call('System.completeMigrationAllowed',requested,transfer,{...receipt,[field]:rootAt(99)},fragment,integrity,20),false,field);
  }
  for(const [field,value] of [['sourceHolder',9],['targetHolder',9],['index',1],['placementRevision',1]])assert.equal(call('System.completeMigrationAllowed',requested,{...transfer,[field]:value},receipt,fragment,integrity,20),false,field);
  for(const [field,value] of [['holderId',9],['index',1],['observedAt',21],['leaseUntil',20],['identityAuthenticated',false]])assert.equal(call('System.completeMigrationAllowed',requested,transfer,{...receipt,[field]:value},fragment,integrity,20),false,field);
  for(const [field,value] of [['manifestRoot',rootAt(99)],['payloadRoot',rootAt(99)],['index',1]])assert.equal(call('System.completeMigrationAllowed',requested,transfer,receipt,{...fragment,[field]:value},integrity,20),false,field);
  assert.equal(call('System.completeMigrationAllowed',requested,transfer,{...receipt,observedAt:0},fragment,integrity,9),false);
  assert.equal(call('System.completeMigrationAllowed',requested,transfer,receipt,fragment,integrity,50),false);
  for(const bad of [
    {...integrity,fragmentRoot:rootAt(99)}, {...integrity,encodingRoot:rootAt(99)}, {...integrity,index:1}, {...integrity,payload:Uint8Array.of(9,9)},
    {...integrity,digest:{...integrity.digest,observed:rootAt(99)}}, {...integrity,digest:{...integrity.digest,domainMatches:false}}, {...integrity,digest:{...integrity.digest,canonicalSerializationMatches:false}}
  ])assert.equal(call('System.completeMigrationAllowed',requested,transfer,receipt,fragment,bad,20),false);
  const stale={...requested,placement:{...requested.placement,revision:2}};
  assert.equal(call('System.completeMigrationAllowed',stale,transfer,receipt,fragment,integrity,20),false);
  for(const phase of ['Acknowledged','Committed','Failed','Uncertain']){
    assert.equal(call('System.requestMigrationAllowed',state,{...transfer,phase:{tag:phase,fields:[]}},cost,10),false);
    assert.equal(call('System.completeMigrationAllowed',requested,{...transfer,phase:{tag:phase,fields:[]}},receipt,fragment,integrity,20),false);
  }
  assert.equal(call('System.requestMigrationAllowed',state,{...transfer,targetHolder:1},cost,10),false);
  assert.equal(call('System.requestMigrationAllowed',state,{...transfer,sourceHolder:8},cost,10),false);
  assert.equal(call('System.requestMigrationAllowed',state,{...transfer,placementRevision:1},cost,10),false);
  assert.equal(call('System.requestMigrationAllowed',state,transfer,resources(101),10),false);
  for(const field of ['requestRoot','manifestRoot','fragmentRoot'])assert.equal(call('System.requestMigrationAllowed',state,{...transfer,[field]:{...rootAt(0),w0:2n**32n}},cost,10),false);
});
test('typed migration preserves every recoverable active mask and rejects unknown or uncertain outcomes',()=>{
  for(let active=0;active<8;active++)for(let index=0;index<3;index++){
    const f=migrationFixture(),p={...placement,active0:Boolean(active&1),active1:Boolean(active&2),active2:Boolean(active&4)};
    if(!call('Custody.recoverable',p))continue;
    const state={...f.state,placement:p},transfer={...f.transfer,index,sourceHolder:index},receipt={...f.receipt,index},fragment={...f.fragment,index},integrity={...f.integrity,index};
    const requested=call('System.requestMigration',state,transfer,f.cost,10);
    const after=call('System.applyMigration',requested,transfer,receipt,fragment,integrity,20);
    assert.equal(call('System.valid',after),true);
    if(p['active'+index])assert.equal(after.placement['holder'+index],3n);
    else assert.equal(requested.transfers.length,0);
    const uncertain=call('Custody.failTransfer',transfer,true);
    assert.equal(uncertain.phase.tag,'Uncertain');
    assert.equal(call('Custody.migrationAllowed',p,uncertain,20),false);
  }
});

function defect(mutator,pattern,mode='--write'){
  const dir=mkdtempSync(join(tmpdir(),'stitch-model-defect-'));
  try{
    for(const path of ['scripts/check-model.mjs','app/src','app/language','src/layer1-uor/generated-model.js'])cpSync(resolve(root,path),resolve(dir,path),{recursive:true});
    const file=resolve(dir,'app/src/Stitch/Budget.lex.tex');const original=readFileSync(file,'utf8');writeFileSync(file,mutator(original));
    const result=spawnSync(process.execPath,['scripts/check-model.mjs',mode],{cwd:dir,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,pattern);
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('planted unsupported syntax, unbound variables, primitive arity and stale outputs are rejected',()=>{
  defect(s=>s.replace('(prim subtract reserved ceiling : Nat)','(prim unknown reserved ceiling : Nat)'),/unsupported primitive/);
  defect(s=>s.replace('(prim subtract reserved ceiling : Nat)','(prim subtract reserved ceiling 1 : Nat)'),/unsupported primitive/);
  defect(s=>s.replace('(reserved + cost)','(missing + cost)'),/unbound variable/);
  defect(s=>s.replace('(reserveAllowed spent reserved cost limit now last end)','(missing spent reserved cost limit now last end)'),/unknown function\/arity/);
  defect(s=>s.replace('(reserved + cost)','(reserved + (cost + 1))'),/stale source bindings/,'--check');
});
