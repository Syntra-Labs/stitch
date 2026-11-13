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
const initialReceipt=index=>({requestRoot:digest,manifestRoot:digest,fragmentRoot:digest,holderId:index,index,observedAt:0,leaseUntil:100,identityAuthenticated:true});
const placement={manifestRoot:digest,revision:0,holder0:0,holder1:1,holder2:2,active0:true,active1:true,active2:true,receipt0:initialReceipt(0),receipt1:initialReceipt(1),receipt2:initialReceipt(2)};
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
    for(let i=0;i<length;i++){blocks={tag:'More',fields:[{tag:v&1?'One':'Zero',fields:[]},{tag:v&2?'One':'Zero',fields:[]},blocks]};v>>=2;}
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
  assert.equal(call('Custody.physicalBytes',[{index:0,holder:0,byteLength:7,retained:true,superseded:true,externalRelay:false,manifestRoot:digest,fragmentRoot:digest,receipt:initialReceipt(0)},{index:1,holder:1,byteLength:9,retained:true,superseded:false,externalRelay:true,manifestRoot:digest,fragmentRoot:digest,receipt:initialReceipt(1)}]),16n);
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
  const custodyPlacement={...placement,receipt0:{...initialReceipt(0),fragmentRoot:rootAt(20)},receipt1:{...initialReceipt(1),fragmentRoot:rootAt(21)},receipt2:{...initialReceipt(2),fragmentRoot:rootAt(22)}};
  const state={objects:[],encodings:[],placement:custodyPlacement,peers:[],pointers:[],jobs:[],checkpoints:[],ledger:{budget:{epoch:0,start:0,end:100,last:0,limit:resources(100,100,100,100),spent:resources(),reserved:resources()},reservations:[]},evidence:[],transfers:[]};
  const integrity={fragmentRoot:receipt.fragmentRoot,encodingRoot:fragment.encodingRoot,index:fragment.index,payload:fragment.payload,digest:{expected:receipt.fragmentRoot,observed:receipt.fragmentRoot,domainMatches:true,canonicalSerializationMatches:true}};
  return {state,transfer,receipt,fragment,integrity,cost:resources(2,2,0,1)};
}
test('generic action reservation and settlement preserve product validity and the nested ledger semantics',()=>{
  const fixture=migrationFixture(),unknown={actionId:rootAt(60),epoch:0,actual:resources(),outcome:{tag:'Unknown',fields:[]}};
  const state=call('System.settleAction',fixture.state,unknown,0);
  for(const kind of ['Place','Repair','Refresh','Checkpoint','Reencode','PublishPointer'])for(let flags=0;flags<8;flags++)for(const now of [0,10,99,100])for(const cost of [resources(),resources(2,3,4,1),resources(101)]){
    const action={actionId:rootAt(60),kind:{tag:kind,fields:[]},cost,preconditionsChecked:Boolean(flags&1),dependenciesPresent:Boolean(flags&2),authorizationChecked:Boolean(flags&4)};
    const admitted=call('Custody.recoverableAt',state.placement,now)&&call('Budget.reserveLedgerAllowed',state.ledger,action.actionId,cost,now)&&action.preconditionsChecked&&action.dependenciesPresent&&action.authorizationChecked;
    const expected={...state,ledger:admitted?call('Budget.reserveLedger',state.ledger,action.actionId,cost,now):state.ledger};
    const requested=call('System.requestAction',state,action,now);
    assert.deepEqual(requested,expected);
    assert.equal(call('System.valid',requested),true);
    if(!admitted)continue;
    for(const settlementTime of [0,10,99,100])for(const outcome of ['Known','Unknown'])for(const actual of [resources(),cost,resources(102)]){
      const observation={actionId:action.actionId,epoch:0,actual,outcome:{tag:outcome,fields:[]}};
      const allowed=call('Custody.recoverableAt',requested.placement,settlementTime)&&call('Budget.settleLedgerAllowed',requested.ledger,observation,settlementTime);
      const expectedSettlement={...requested,ledger:allowed?call('Budget.settleLedger',requested.ledger,observation,settlementTime):requested.ledger};
      const settled=call('System.settleAction',requested,observation,settlementTime);
      assert.deepEqual(settled,expectedSettlement);
      assert.equal(call('System.valid',settled),true);
      assert.deepEqual(settled.placement,state.placement);
    }
  }
});
test('typed migration reserves before effects and consumes an exact requested transfer only once',()=>{
  const {state,transfer,receipt,fragment,integrity,cost}=migrationFixture();
  assert.equal(call('System.completeMigrationAllowed',state,transfer,receipt,fragment,integrity,20),false);
  assert.equal(call('System.completeMigrationAllowed',{...state,transfers:[transfer]},transfer,receipt,fragment,integrity,20),false);
  assert.deepEqual(call('System.applyMigration',state,transfer,receipt,fragment,integrity,20),call('System.requestMigration',state,transfer,resources(101),10));
  const requested=call('System.requestMigration',state,transfer,cost,10);
  assert.equal(call('System.valid',requested),true);
  assert.deepEqual(requested.placement,call('Custody.replaceIndex',state.placement,3,0,false));
  assert.deepEqual(requested.ledger.budget.reserved,resources(2n,2n,0n,1n));
  assert.equal(requested.transfers.length,1);
  assert.equal(call('System.requestMigrationAllowed',requested,transfer,cost,10),false);
  const prematurelySettled=call('System.settleAction',requested,{actionId:transfer.requestRoot,epoch:0,actual:resources(),outcome:{tag:'Known',fields:[]}},11);
  assert.equal(call('System.completeMigrationAllowed',prematurelySettled,transfer,receipt,fragment,integrity,20),false);
  const completed=call('System.applyMigration',requested,transfer,receipt,fragment,integrity,20);
  assert.equal(completed.placement.holder0,3n);
  assert.equal(completed.placement.revision,1n);
  assert.equal(completed.transfers[0].phase.tag,'Committed');
  assert.equal(call('System.valid',completed),true);
  assert.deepEqual(completed.ledger.budget.reserved,requested.ledger.budget.reserved);
  assert.deepEqual(completed.ledger.budget.spent,requested.ledger.budget.spent);
  assert.equal(completed.ledger.budget.last,20n);
  assert.deepEqual(completed.evidence,requested.evidence);
  assert.equal(call('System.completeMigrationAllowed',completed,transfer,receipt,fragment,integrity,21),false);
  assert.deepEqual(call('System.applyMigration',completed,transfer,receipt,fragment,integrity,21),completed);
  assert.equal(call('System.requestMigrationAllowed',completed,transfer,cost,22),false);
  const next={...transfer,requestRoot:rootAt(90),sourceHolder:3,targetHolder:4,placementRevision:1};
  assert.equal(call('System.requestMigrationAllowed',completed,next,cost,19),false);
  assert.equal(call('System.requestMigrationAllowed',completed,next,cost,21),true);
  const observation={actionId:transfer.requestRoot,epoch:0,actual:resources(1,1,0,1),outcome:{tag:'Known',fields:[]}};
  const settled=call('System.settleAction',completed,observation,21);
  assert.equal(call('Budget.ledgerValid',settled.ledger),true);
  assert.equal(call('System.valid',settled),true);
  assert.deepEqual(settled.ledger.budget.reserved,resources(0n,0n,0n,0n));
  assert.deepEqual(settled.ledger.budget.spent,resources(1n,1n,0n,1n));
  assert.equal(call('System.settleActionAllowed',settled,observation,22),false);
  assert.equal(call('System.requestMigrationAllowed',settled,transfer,cost,22),false);
  assert.equal(call('System.settleActionAllowed',completed,{...observation,outcome:{tag:'Unknown',fields:[]}},21),false);
  assert.deepEqual(call('System.settleAction',completed,{...observation,outcome:{tag:'Unknown',fields:[]}},21),completed);

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
  assert.equal(call('System.completeMigrationAllowed',{...requested,placement:{...requested.placement,receipt0:{...requested.placement.receipt0,fragmentRoot:rootAt(99)}}},transfer,receipt,fragment,integrity,20),false);
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
    const f=migrationFixture(),p={...f.state.placement,active0:Boolean(active&1),active1:Boolean(active&2),active2:Boolean(active&4)};
    if(!call('Custody.recoverable',p))continue;
    const fragmentRoot=rootAt(20+index);
    const state={...f.state,placement:p},transfer={...f.transfer,index,sourceHolder:index,fragmentRoot},receipt={...f.receipt,index,fragmentRoot},fragment={...f.fragment,index,payloadRoot:fragmentRoot},integrity={...f.integrity,index,fragmentRoot,digest:{...f.integrity.digest,expected:fragmentRoot,observed:fragmentRoot}};
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

test('observations require fresh observer-relative authenticated sequences, and timeout never becomes reachability',()=>{
  const current={observer:1,peer:2,failureDomain:3,observedAt:1,expires:10,sequence:0,reachability:{tag:'Unknown',fields:[]},authenticated:true};
  const candidate={...current,observedAt:10,expires:20,sequence:1,reachability:{tag:'Reachable',fields:[]}};
  assert.equal(call('Observation.acceptObservation',current,candidate,15),true);
  for(const [field,value] of [['observer',9],['peer',9],['sequence',0],['observedAt',16],['expires',15],['authenticated',false]])assert.equal(call('Observation.acceptObservation',current,{...candidate,[field]:value},15),false,field);
  assert.equal(call('Observation.acceptObservation',{...current,observedAt:12},candidate,15),false);
  for(const tag of ['Unknown','Reachable','TimedOut','Conflicting']){
    const observation={...candidate,reachability:{tag,fields:[]}};
    assert.equal(call('Observation.reachableObservation',observation,1,15),tag==='Reachable');
    assert.equal(call('Observation.reachableObservation',observation,9,15),false);
    assert.equal(call('Observation.reachableObservation',observation,1,20),false);
  }
  assert.equal(call('Observation.reachableObservation',{...candidate,authenticated:false},1,15),false);
  const kept=call('Observation.updateObservation',current,current,15);
  assert.deepEqual(call('Observation.updateObservation',current,{...candidate,expires:15},15),kept);
});
test('per-copy leases expire at the boundary and expired/superseded retained bytes still count physically',()=>{
  const p={...placement,receipt0:{...initialReceipt(0),leaseUntil:20},receipt1:{...initialReceipt(1),leaseUntil:30},receipt2:{...initialReceipt(2),leaseUntil:40}};
  assert.equal(call('Custody.liveCount',p,19),3n);
  assert.equal(call('Custody.liveCount',p,20),2n);
  assert.equal(call('Custody.recoverableAt',p,29),true);
  assert.equal(call('Custody.recoverableAt',p,30),false);
  assert.equal(call('Custody.recoverable',p),true);
  const inactiveDuplicate={...placement,active2:false,holder2:0,receipt2:{...initialReceipt(2),holderId:0}};
  assert.equal(call('Custody.recoverableAt',inactiveDuplicate,20),true);
  const collocated={...placement,holder1:0,holder2:0,receipt1:{...initialReceipt(1),holderId:0},receipt2:{...initialReceipt(2),holderId:0}};
  assert.equal(call('Custody.recoverableAt',collocated,20),false);
  for(const [field,value] of [['manifestRoot',rootAt(99)],['index',2],['holderId',9],['observedAt',21],['identityAuthenticated',false]]){
    const bad={...placement,active2:false,receipt1:{...initialReceipt(1),[field]:value}};
    assert.equal(call('Custody.recoverableAt',bad,20),false,field);
  }
  const copy={index:0,holder:0,byteLength:7,retained:true,superseded:false,externalRelay:false,manifestRoot:digest,fragmentRoot:digest,receipt:{...initialReceipt(0),leaseUntil:20}};
  assert.equal(call('Custody.physicalCopyLive',copy,19),true);
  assert.equal(call('Custody.physicalCopyLive',copy,20),false);
  assert.equal(call('Custody.physicalCopyLive',{...copy,superseded:true},19),false);
  assert.equal(call('Custody.physicalBytes',[copy,{...copy,superseded:true}]),14n);
  const f=migrationFixture(),state={...f.state,placement:{...f.state.placement,active2:false}};
  const requested=call('System.requestMigration',state,f.transfer,f.cost,10);
  const completed=call('System.applyMigration',requested,f.transfer,f.receipt,f.fragment,f.integrity,20);
  assert.equal(completed.placement.receipt0.leaseUntil,50n);
  assert.equal(completed.placement.receipt0.holderId,3n);
  assert.equal(call('System.validAt',completed,49),true);
  assert.equal(call('System.validAt',completed,50),false);
  assert.equal(call('System.requestMigrationAllowed',{...state,placement:p},f.transfer,f.cost,30),false);
});
function evidenceFixture(){
  const assumptions=Object.fromEntries(['digestCollisionResistance','signatureUnforgeability','authorizedKeyBinding','receiptAuthentication','storageRetentionForLease','independentFailureDomains','monotonicElapsedClock','releasedRuntimeMatchesModel'].map(name=>[name,true]));
  const dependencies=[{root:rootAt(70),kind:{tag:'Decoder',fields:[]},byteLength:4,present:true,integrityChecked:true},{root:rootAt(80),kind:{tag:'Basis',fields:[]},byteLength:7,present:true,integrityChecked:true}];
  const bindings={claim:{tag:'Reconstruction',fields:[]},kind:{tag:'KernelChecked',fields:[]},modelRoot:rootAt(1),artifactRoot:rootAt(2),subjectRoot:rootAt(3),assumptionsRoot:rootAt(4),dependencyRoot:rootAt(5),assumptions,dependencies};
  const hostEffects=[{tag:'ReadClock',fields:[]},{tag:'HashBytes',fields:[]}];
  const evidence={...bindings,hostEffects,observedAt:10,validUntil:100,horizon:60,failureBound:1};
  const requested={...bindings,hostEffects:[{tag:'HashBytes',fields:[]}],horizon:20,failures:1};
  return {evidence,requested};
}
test('typed evidence reuse binds exact claim, evidence kind, identities, named assumptions and dependency snapshots',()=>{
  const {evidence,requested}=evidenceFixture();
  assert.equal(call('Evidence.scopeReusable',evidence,requested,20),true);
  for(const name of ['modelRoot','artifactRoot','subjectRoot','assumptionsRoot','dependencyRoot']){
    assert.equal(call('Evidence.scopeReusable',evidence,{...requested,[name]:rootAt(99)},20),false,name);
    assert.equal(call('Evidence.scopeReusable',{...evidence,[name]:{...rootAt(0),w0:2n**32n}},requested,20),false,name);
  }
  for(const tag of ['Integrity','Authorization','PureExecution','Availability','Durability','Confidentiality'])assert.equal(call('Evidence.scopeReusable',evidence,{...requested,claim:{tag,fields:[]}},20),false);
  for(const tag of ['Specified','KernelChecked','ImplementationTested','IndependentlyReplayed','FieldMeasured','Refuted','Untested']){
    const kind={tag,fields:[]};
    assert.equal(call('Evidence.scopeReusable',{...evidence,kind},{...requested,kind},20),['KernelChecked','ImplementationTested','IndependentlyReplayed','FieldMeasured'].includes(tag));
    if(tag!=='KernelChecked')assert.equal(call('Evidence.scopeReusable',evidence,{...requested,kind},20),false);
  }
  for(const name of Object.keys(evidence.assumptions))assert.equal(call('Evidence.scopeReusable',evidence,{...requested,assumptions:{...requested.assumptions,[name]:false}},20),false,name);
  for(const [field,value] of [['root',rootAt(99)],['kind',{tag:'Residual',fields:[]}],['byteLength',5],['present',false],['integrityChecked',false]]){
    const dependencies=[{...requested.dependencies[0],[field]:value},requested.dependencies[1]];
    assert.equal(call('Evidence.scopeReusable',evidence,{...requested,dependencies},20),false,field);
  }
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,dependencies:[]},20),false);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,dependencies:[...requested.dependencies].reverse()},20),false);
});
test('evidence horizons cannot roll forward and host effects cannot expand during reuse',()=>{
  const {evidence,requested}=evidenceFixture();
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,horizon:50},20),true);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,horizon:51},20),false);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,horizon:20},51),false);
  assert.equal(call('Evidence.scopeReusable',evidence,requested,9),false);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,horizon:0},100),false);
  assert.equal(call('Evidence.scopeReusable',{...evidence,validUntil:30},requested,20),false);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,failures:2},20),false);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,hostEffects:[]},20),true);
  assert.equal(call('Evidence.scopeReusable',evidence,{...requested,hostEffects:[{tag:'SendFragment',fields:[]}]},20),false);
  assert.equal(call('Evidence.scopeReusable',{...evidence,hostEffects:[]},requested,20),false);
  for(const tag of ['ReadClock','SendFragment','PersistFragment','ReadDNS','WriteDNS','ReceivePeer','RunVM','FetchDependency','VerifySignature','HashBytes'])assert.equal(call('Evidence.pureEffectAllowed',{tag,fields:[]}),false);
});

function defect(mutator,pattern,mode='--write'){
  const dir=mkdtempSync(join(tmpdir(),'stitch-model-defect-'));
  try{
    for(const path of ['scripts/check-model.mjs','app/src','app/language','src/layer1-uor/generated-model.js','src/layer4-compute/replay.js','src/layer1-uor/index.js','src/layer1-uor/contracts.js','src/layer1-uor/custody.js'])cpSync(resolve(root,path),resolve(dir,path),{recursive:true});
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
