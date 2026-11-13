#!/usr/bin/env node
/**
 * Reproduce the handwritten host's small pure bindings from the LexLean source.
 * This is a strict subset translator, NOT LexLean, Lean, PrismPM, a proof checker,
 * or a replacement for the pinned SDK gate. Unsupported syntax is an error.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'src/layer1-uor/generated-model.js');
const sourceRoot = resolve(root, 'app/src/Stitch');
// Product.Experience intentionally uses this same declared subset for browser journeys.
const selectedSources = [...readdirSync(sourceRoot).filter(x=>x.endsWith('.lex.tex')).sort().map(x=>resolve(sourceRoot,x)), resolve(root,'app/src/Product/Experience.lex.tex')];
const modes = new Set(process.argv.slice(2));
if ([...modes].some(x => !['--write', '--check', '--inventory'].includes(x)) || modes.has('--write') && modes.has('--check')) throw Error('usage: node scripts/check-model.mjs [--write|--check] [--inventory]');
const hash = value => createHash('sha256').update(value).digest('hex');
function lex(text) {
  const tokens = []; let i = 0;
  while (i < text.length) {
    const rest = text.slice(i); let m;
    if ((m = /^\s+/.exec(rest))) { i += m[0].length; continue; }
    if ((m = /^"(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/.exec(rest))) { tokens.push(m[0]); i += m[0].length; continue; }
    if ((m = /^(?:<->|::|:=|<=\?|<\?|=\?|&&|\|\||->|<=|\/\\|[(){}\[\],:+|=<>;]|[0-9]+|[A-Za-z_][A-Za-z0-9_'.-]*)/.exec(rest))) { tokens.push(m[0]); i += m[0].length; continue; }
    throw Error(`unsupported token at ${i}: ${JSON.stringify(rest.slice(0, 40))}`);
  }
  return tokens;
}
function split(tokens, sep) {
  const out = []; let start = 0; const stack = [];
  const close = {')':'(',']':'[','}':'{'};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (['(', '[', '{'].includes(t)) stack.push(t);
    else if (Object.hasOwn(close,t)) { if (stack.pop() !== close[t]) throw Error('unbalanced source delimiters'); }
    else if (t === sep && !stack.length) { out.push(tokens.slice(start,i)); start=i+1; }
  }
  if (stack.length) throw Error('unbalanced source delimiters');
  out.push(tokens.slice(start)); return out;
}
function fields(tokens) {
  if (tokens[0] !== '{' || tokens.at(-1) !== '}') throw Error('expected declaration record');
  const result = Object.create(null);
  for (const part of split(tokens.slice(1,-1), ',')) {
    if (part.length < 3 || part[1] !== ':' || Object.hasOwn(result,part[0])) throw Error(`bad/duplicate field ${part.join(' ')}`);
    result[part[0]] = part.slice(2);
  }
  return result;
}
function list(tokens) { if (tokens[0] !== '[' || tokens.at(-1) !== ']') throw Error('expected array'); return tokens.length === 2 ? [] : split(tokens.slice(1,-1),','); }
function single(tokens) { if (tokens?.length !== 1) throw Error(`expected atom: ${tokens?.join(' ')}`); return tokens[0]; }
function member(tokens) { if (tokens.length === 1) return tokens[0]; if (tokens.length === 3 && tokens[1] === '::') return `${tokens[0]}::${tokens[2]}`; throw Error('invalid member'); }
function type(tokens) {
  if (tokens[0] === '(' && tokens.at(-1) === ')') { const inner=tokens.slice(1,-1); if (['List','Option'].includes(inner[0])) return { kind:inner[0],element:type(inner.slice(1)) }; throw Error(`unsupported type ${tokens.join(' ')}`); }
  return {kind:member(tokens)};
}
function parameters(tokens) {
  return list(tokens).map(xs => { if (xs[1]!==':') throw Error('invalid parameter'); return {name:xs[0],type:type(xs.slice(2))}; });
}
class TermParser {
  constructor(tokens) { this.tokens=tokens; this.i=0; }
  peek() { return this.tokens[this.i]; }
  take(want) { const got=this.tokens[this.i++]; if (want!==undefined && got!==want) throw Error(`expected ${want}; found ${got} at ${this.i-1}`); return got; }
  name() { const a=this.take(); return this.peek()==='::' ? (this.take(), a+'::'+this.take()) : a; }
  term() {
    const t=this.take();
    if (/^\d+$/.test(t)) return {k:'nat',value:t};
    if (t==='true'||t==='false') return {k:'bool',value:t==='true'};
    if (t?.startsWith('"')) return {k:'string',value:JSON.parse(t)};
    if (t==='(') {
      const first=this.peek(); let out;
      if (first==='if') { this.take(); const cond=this.term(); this.take('then'); const yes=this.term(); this.take('else'); const no=this.term(); out={k:'if',cond,yes,no}; }
      else if (first==='let') { this.take(); const name=this.take(); this.take(':'); const ty=[]; while(this.peek()!==':=') ty.push(this.take()); this.take(':='); const value=this.term(); this.take(';'); const body=this.term(); out={k:'let',name,type:type(ty),value,body}; }
      else if (first==='project') { this.take(); out={k:'project',value:this.term(),field:this.take()}; }
      else if (first==='record') {
        this.take(); const name=this.name(); this.take('{'); const values=Object.create(null);
        while(this.peek()!=='}') { const key=this.take(); this.take(':='); if(Object.hasOwn(values,key)) throw Error('duplicate record assignment'); values[key]=this.term(); if(this.peek()!=='}') this.take(','); }
        this.take('}'); out={k:'record',name,values};
      }
      else if (first==='prim') { this.take(); const operation=this.take(),args=[]; while(this.peek()!==':') args.push(this.term()); this.take(':'); const ty=[]; let depth=0; while(this.peek()!==')'||depth) { const t=this.take(); if(t==='(')depth++; if(t===')')depth--; ty.push(t); if(this.i>this.tokens.length)throw Error('unclosed primitive'); } out={k:'prim',operation,args,type:type(ty)}; }
      else if (first==='match') {
        this.take(); const value=this.term(),branches=[];
        while(this.peek()==='|') { this.take(); const constructor=this.name(),binders=[]; while(this.peek()!=='=>') { if(this.peek()==='='&&this.tokens[this.i+1]==='>')break; binders.push(this.take()); if(this.i>this.tokens.length)throw Error('bad match'); }
          if(this.peek()==='=>')this.take();else {this.take('=');this.take('>');} branches.push({constructor,binders,body:this.term()}); }
        out={k:'match',value,branches};
      }
      else if (first==='ctor') { this.take(); const name=this.name(),args=[]; while(this.peek()!==')')args.push(this.term()); out={k:'ctor',name,args}; }
      else if (first==='cons') { this.take(); out={k:'cons',head:this.term(),tail:this.term()}; }
      else if (first==='nil') { this.take(); const ty=[]; while(this.peek()!==')')ty.push(this.take()); out={k:'nil',type:type(ty)}; }
      else if (first==='not') { this.take(); out={k:'not',value:this.term()}; }
      else {
        const left=this.term();
        if (['+','=?','<=?','<?','&&','||'].includes(this.peek())) { const op=this.take(); out={k:'binary',op,left,right:this.term()}; }
        else { if(left.k!=='var')throw Error('only named function applications supported'); const args=[]; while(this.peek()!==')')args.push(this.term()); out={k:'call',name:left.name,args}; }
      }
      this.take(')'); return out;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_'.-]*$/.test(t??''))throw Error(`unsupported term ${t}`);
    return {k:'var',name:this.peek()==='::'?(this.take(),t+'::'+this.take()):t};
  }
  finish() { const out=this.term(); if(this.i!==this.tokens.length)throw Error(`trailing expression tokens: ${this.tokens.slice(this.i).join(' ')}`); return out; }
}
const sources=[], defs={}, types={}, theorems=[];
for (const sourcePath of selectedSources) {
  const file=relative(root,sourcePath);
  const text=readFileSync(sourcePath,'utf8');
  if(text.includes('\r'))throw Error(`${file}: CRLF refused`);
  if(/\b(?:sorry|unsafe)\b/.test(text.replace(/name: admit,/g,'')))throw Error(`${file}: forbidden unchecked escape`);
  const module=/^\\begin\{lexlean\}\{(Stitch\.[A-Za-z]+|Product\.Experience)\}/.exec(text)?.[1];
  if(!module||file!==`app/src/${module.replace('.', '/')}.lex.tex`)throw Error(`${file}: module/path mismatch`);
  const body=text.split('\\begin{semanticmodule}\n')[1]?.split('\\end{semanticmodule}')[0];
  if(!body)throw Error(`${file}: missing semantic module`);
  const tokens=lex(body); let i=0;
  while(i<tokens.length) {
    const kind=tokens[i++]; if(!['definition','structure','inductive','theorem'].includes(kind))throw Error(`${file}: unsupported declaration ${kind}`);
    if(tokens[i]!=='{')throw Error('missing declaration block'); const start=i; let depth=0;
    do { const t=tokens[i++]; if(t==='{')depth++;if(t==='}')depth--;if(i>tokens.length)throw Error('unclosed declaration'); }while(depth);
    let f; try { f=fields(tokens.slice(start,i)); } catch(e) { throw Error(module+' '+tokens.slice(start,start+6).join(' ')+': '+e.message); } const name=single(f.name),id=`${module}.${name}`;
    const allowed={definition:['name','parameters','result','body','axioms','recursive_argument','executable','production'],theorem:['name','parameters','statement','proof','axioms'],structure:['name','type_parameters','parameters','fields'],inductive:['name','type_parameters','parameters','constructors']}[kind];
    for(const key of Object.keys(f))if(!allowed.includes(key))throw Error(`${id}: unsupported declaration field ${key}`);
    if(kind==='definition') { if(defs[id])throw Error('duplicate definition'); defs[id]={module,name,params:parameters(f.parameters),result:type(f.result),body:new TermParser(f.body).finish()}; }
    if(kind==='structure')types[id]={kind,fields:list(f.fields).map(x=>{const ff=fields(x);return{name:single(ff.name),type:type(ff.type)};})};
    if(kind==='inductive')types[id]={kind,constructors:list(f.constructors).map(x=>{const ff=fields(x);return{name:single(ff.name),fields:list(ff.fields).map(type)};})};
    if(kind==='theorem') { if(!f.proof||!f.statement)throw Error('theorem without proof');theorems.push({id,proof:single(f.proof.slice(0,1)),source:relative(root,sourcePath),status:'source-obligation-not-kernel-checked'}); }
  }
  sources.push({path:relative(root,sourcePath),sha256:hash(text)});
}
function qualify(module,name) { return name.includes('::') ? name.replace('::','.') : `${module}.${name}`; }
const primitiveArity={subtract:2,multiply:2,quotient:3,remainder:3,equal:2};
const prims=new Set(Object.keys(primitiveArity));
function visit(ast,mod,locals) {
  if(!ast||typeof ast!=='object')throw Error('invalid AST');
  switch(ast.k) {
    case 'nat':case 'bool':case 'string':case 'nil':return;
    case 'var':if(!locals.has(ast.name))throw Error(`${mod}: unbound variable ${ast.name}`);return;
    case 'call': {const id=qualify(mod,ast.name); if(!defs[id]||defs[id].params.length!==ast.args.length)throw Error(`${mod}: unknown function/arity ${ast.name}`);ast.args.forEach(x=>visit(x,mod,locals));return;}
    case 'prim':if(!prims.has(ast.operation)||primitiveArity[ast.operation]!==ast.args.length||!(ast.operation==='equal'?ast.type.kind==='Bool':ast.type.kind==='Nat'))throw Error(`unsupported primitive ${ast.operation}`);ast.args.forEach(x=>visit(x,mod,locals));return;
    case 'record': {const shape=types[qualify(mod,ast.name)];if(!shape||shape.kind!=='structure'||shape.fields.map(x=>x.name).sort().join(',')!==Object.keys(ast.values).sort().join(','))throw Error('unknown record or wrong record fields');Object.values(ast.values).forEach(x=>visit(x,mod,locals));return;}
    case 'project':case 'not':visit(ast.value,mod,locals);return;
    case 'binary':visit(ast.left,mod,locals);visit(ast.right,mod,locals);return;
    case 'if':visit(ast.cond,mod,locals);visit(ast.yes,mod,locals);visit(ast.no,mod,locals);return;
    case 'let':visit(ast.value,mod,locals);visit(ast.body,mod,new Set([...locals,ast.name]));return;
    case 'ctor': {const i=ast.name.lastIndexOf('.'),owner=qualify(mod,ast.name.slice(0,i)),name=ast.name.slice(i+1);const constructor=types[owner]?.constructors?.find(x=>x.name===name);if(!constructor||constructor.fields.length!==ast.args.length)throw Error('unknown constructor or wrong constructor arity');ast.args.forEach(x=>visit(x,mod,locals));return;}
    case 'cons':visit(ast.head,mod,locals);visit(ast.tail,mod,locals);return;
    case 'match':visit(ast.value,mod,locals);ast.branches.forEach(b=>visit(b.body,mod,new Set([...locals,...b.binders])));return;
    default:throw Error(`unsupported AST ${ast.k}`);
  }
}
for(const d of Object.values(defs))visit(d.body,d.module,new Set(d.params.map(x=>x.name)));
const aliases={budgetReserveAllowed:'Stitch.Budget.reserveAllowed',budgetSettlementAllowed:'Stitch.Budget.settlementAllowed',pointerSuccessorAllowed:'Stitch.Pointer.successorAllowed',checkpointLinkAllowed:'Stitch.Compute.checkpointLinkAllowed',custodyCommitAllowed:'Stitch.Custody.commitAllowed',custodyRetireAllowed:'Stitch.Custody.retireAllowed',custodyPairAllowed:'Stitch.Fragments.pairAllowed'};
for(const [name,id] of Object.entries(aliases))if(!defs[id])throw Error(`missing public binding ${name}`);
const bindingSources = [];
function gather(dir) { for (const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { const p=resolve(dir,e.name); if(e.isDirectory())gather(p); else bindingSources.push({path:relative(root,p),sha256:hash(readFileSync(p))}); } }
gather(resolve(root,'app/src')); gather(resolve(root,'app/language'));
const sourceDigest='sha256:'+hash(bindingSources.map(x=>x.path+'\0'+x.sha256+'\n').join(''));
// Execution compatibility is narrower than exact project-source provenance.
// Canonical reachable LexLean declarations exclude proofs and layout. The
// interpreter and complete transitive JS adapter modules remain byte-bound:
// compatibility is conservative for handwritten adapter edits, never guessed.
const interpreter = `const qualify = (module, name) => name.includes('::') ? name.replace('::','.') : module+'.'+name;
function natural(value) {
  if(typeof value==='bigint'&&value>=0n)return value;
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
  throw new TypeError('model Nat must be a non-negative BigInt or safe integer');
}
function coerce(value,type,module) {
  if(type.kind==='Nat')return natural(value);
  if(type.kind==='Bool') {if(typeof value!=='boolean')throw new TypeError('model Bool required');return value;}
  if(type.kind==='Bytes') {if(!(value instanceof Uint8Array))throw new TypeError('model Bytes required');return value.slice();}
  if(type.kind==='String') {if(typeof value!=='string')throw new TypeError('model String required');return value;}
  if(type.kind==='List') {if(!Array.isArray(value))throw new TypeError('model List required');return value.map(x=>coerce(x,type.element,module));}
  const id=qualify(module,type.kind),shape=types[id];
  if(!shape)throw new TypeError('unknown model type '+id);
  if(shape.kind==='structure') {if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==shape.fields.map(x=>x.name).sort().join(','))throw new TypeError('exact model record fields required for '+id);return Object.fromEntries(shape.fields.map(f=>[f.name,coerce(value[f.name],f.type,id.slice(0,id.lastIndexOf('.')))]));}
  const constructor=shape.constructors.find(x=>x.name===value?.tag);
  if(!constructor||!Array.isArray(value.fields)||value.fields.length!==constructor.fields.length)throw new TypeError('model constructor required for '+id);
  return {tag:value.tag,fields:value.fields.map((v,i)=>coerce(v,constructor.fields[i],id.slice(0,id.lastIndexOf('.'))))};
}
const tailCall = Symbol("source-tail-call");
function evaluate(ast,env,module,tail=false) {
  switch(ast.k) {
    case 'nat':return BigInt(ast.value);
    case 'bool':case 'string':return ast.value;
    case 'var':if(!Object.hasOwn(env,ast.name))throw Error('unbound model variable');return env[ast.name];
    case 'if':return evaluate(evaluate(ast.cond,env,module)?ast.yes:ast.no,env,module,tail);
    case 'not':return !evaluate(ast.value,env,module);
    case 'project':return evaluate(ast.value,env,module)[ast.field];
    case 'let':return evaluate(ast.body,{...env,[ast.name]:evaluate(ast.value,env,module)},module,tail);
    case 'record':return Object.fromEntries(Object.entries(ast.values).map(([k,v])=>[k,evaluate(v,env,module)]));
    case 'call': {const id=qualify(module,ast.name),args=ast.args.map(x=>evaluate(x,env,module));return tail?{[tailCall]:true,id,args}:invoke(id,args);}
    case 'nil':return [];
    case 'cons':return [evaluate(ast.head,env,module),...evaluate(ast.tail,env,module)];
    case 'ctor':return {tag:ast.name.split('.').at(-1),fields:ast.args.map(x=>evaluate(x,env,module))};
    case 'match': {
      const value=evaluate(ast.value,env,module);let tag,fields;
      if(Array.isArray(value)){tag=value.length?'cons':'nil';fields=value.length?[value[0],value.slice(1)]:[];}else if(typeof value==='bigint'){tag=value===0n?'zero':'succ';fields=value===0n?[]:[value-1n];}else if(typeof value==='boolean'){tag=value?'true':'false';fields=[];}else {tag=value.tag;fields=value.fields;}
      const b=ast.branches.find(x=>x.constructor.split('.').at(-1)===tag);
      if(!b||b.binders.length!==fields.length)throw Error('nonexhaustive model match');return evaluate(b.body,{...env,...Object.fromEntries(b.binders.map((n,i)=>[n,fields[i]]))},module,tail);
    }
    case 'binary': {
      const left=evaluate(ast.left,env,module);
      if(ast.op==='&&')return left&&evaluate(ast.right,env,module);
      if(ast.op==='||')return left||evaluate(ast.right,env,module);
      const right=evaluate(ast.right,env,module);
      switch(ast.op){case '+':return left+right;case '=?':return left===right;case '<=?':return left<=right;case '<?':return left<right;default:throw Error('unsupported model operator');}
    }
    case 'prim': {
      const a=ast.args.map(x=>evaluate(x,env,module));
      switch(ast.operation){case 'subtract':return a[0]>=a[1]?a[0]-a[1]:0n;case 'multiply':return a[0]*a[1];case 'quotient':return a[1]===0n?a[2]:a[0]/a[1];case 'remainder':return a[1]===0n?a[2]:a[0]%a[1];case 'equal':return a[0].length===a[1].length&&a[0].every((x,i)=>x===a[1][i]);default:throw Error('unsupported model primitive');}
    }
    default:throw Error('unsupported model node '+ast.k);
  }
}
function invoke(id,args) {for(;;){const d=definitions[id];if(!d||d.params.length!==args.length)throw Error('unknown model function/arity '+id);const result=evaluate(d.body,Object.fromEntries(d.params.map((p,i)=>[p.name,args[i]])),d.module,true);if(!result?.[tailCall])return result;id=result.id;args=result.args;}}
export const model=Object.freeze(Object.fromEntries(Object.entries(definitions).map(([id,d])=>[id,(...args)=>{if(args.length!==d.params.length)throw new TypeError('model arity '+id);return invoke(id,args.map((v,i)=>coerce(v,d.params[i].type,d.module)));}])));
`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const adapterSources = [], adapterTexts = new Map();
function gatherAdapter(path) {
  const full = resolve(root, path), normalized = relative(root, full);
  if (!normalized.startsWith('src/') || !normalized.endsWith('.js')) throw Error('unsupported execution adapter dependency '+path);
  if (full === output || adapterTexts.has(normalized)) return;
  const text = readFileSync(full, 'utf8');
  adapterTexts.set(normalized, text);
  adapterSources.push({ path: normalized, sha256: hash(text) });
  if (/\bimport\s*\(/.test(text)) throw Error('dynamic execution adapter import is not supported');
  for (const match of text.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) throw Error('external execution adapter import is not supported');
    gatherAdapter(relative(root, resolve(dirname(full), match[1])));
  }
}
gatherAdapter('src/layer4-compute/replay.js');
adapterSources.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const replayAdapter = adapterTexts.get('src/layer4-compute/replay.js');
const executionRoots = new Set();
const directCalls = [...replayAdapter.matchAll(/\bmodel\[['"]([^'"]+)['"]\]/g)];
if ([...replayAdapter.matchAll(/\bmodel\s*\[/g)].length !== directCalls.length) throw Error('dynamic execution model access is not supported');
for (const match of directCalls) executionRoots.add(match[1]);
for (const match of replayAdapter.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*generated-model\.js['"]/g)) {
  for (const name of match[1].split(',').map(x=>x.trim())) {
    if (Object.hasOwn(aliases,name)) executionRoots.add(aliases[name]);
    else if (!['model','modelSourceDigest','modelExecutionDigest'].includes(name)) throw Error('unsupported execution model import '+name);
  }
}
if (!executionRoots.size) throw Error('missing execution model roots');
const executionDefinitions = {}, executionTypes = {};
function includeType(type, module) {
  if (type.element) includeType(type.element,module);
  if (['Nat','Bool','Bytes','String','List','Option'].includes(type.kind)) return;
  const id=qualify(module,type.kind), shape=types[id];
  if (!shape) throw Error('unknown execution type '+id);
  if (executionTypes[id]) return;
  executionTypes[id]=shape;
  const owner=id.slice(0,id.lastIndexOf('.'));
  if (shape.fields) shape.fields.forEach(field=>includeType(field.type,owner));
  if (shape.constructors) shape.constructors.forEach(c=>c.fields.forEach(field=>includeType(field,owner)));
}
function includeDefinition(id) {
  if (executionDefinitions[id]) return;
  const definition=defs[id];
  if (!definition) throw Error('unknown execution definition '+id);
  executionDefinitions[id]=definition;
  definition.params.forEach(p=>includeType(p.type,definition.module));
  includeType(definition.result,definition.module);
  function walk(node) {
    if (!node || typeof node!=='object') return;
    if (node.k==='call') includeDefinition(qualify(definition.module,node.name));
    if (node.type) includeType(node.type,definition.module);
    if (node.k==='record') includeType({kind:node.name},definition.module);
    if (node.k==='ctor') includeType({kind:node.name.slice(0,node.name.lastIndexOf('.'))},definition.module);
    Object.values(node).forEach(value=>Array.isArray(value)?value.forEach(walk):walk(value));
  }
  walk(definition.body);
}
[...executionRoots].sort().forEach(includeDefinition);
const executionIdentity = canonical({ schema:'stitch/execution-semantics/1',
  roots:[...executionRoots].sort(), definitions:executionDefinitions, types:executionTypes,
  interpreterSha256:hash(interpreter), adapterSources });
const executionDigest='sha256:'+hash('stitch/execution-semantics/v1\0'+JSON.stringify(executionIdentity));
const inventory={schema:'stitch/source-bindings/1',verification:'source-derived, not kernel-checked',sourceDigest,executionDigest,executionIdentity,generatorSha256:hash(readFileSync(fileURLToPath(import.meta.url))),bindingSources,sources,theorems,definitions:Object.keys(defs).sort(),aliases};
const generated=`/** GENERATED by scripts/check-model.mjs. DO NOT EDIT.
 * Exact BigInt evaluation of a declared subset of the project LexLean source.
 * This is NOT a Prism compiler, proof certificate, or whole-runtime certification.
 */
const definitions = ${JSON.stringify(defs,null,2)};
const types = ${JSON.stringify(types,null,2)};
export const modelSourceDigest = ${JSON.stringify(sourceDigest)};
export const modelExecutionDigest = ${JSON.stringify(executionDigest)};
export const MODEL_SOURCE = Object.freeze(${JSON.stringify(inventory,null,2)});
${interpreter}
${Object.entries(aliases).map(([name,id])=>`export const ${name} = model[${JSON.stringify(id)}];`).join('\n')}
`;
if(modes.has('--write')) {mkdirSync(dirname(output),{recursive:true});writeFileSync(output,generated);}
else if(readFileSync(output,'utf8')!==generated)throw Error('stale source bindings: run node scripts/check-model.mjs --write, then review');
if(modes.has('--inventory'))console.log(JSON.stringify(inventory,null,2));
else console.log(`model bindings: ${sources.length} selected domain/experience modules, ${Object.keys(defs).length} definitions, ${theorems.length} unverified theorem obligations; ${modes.has('--write')?'written':'fresh'}`);
