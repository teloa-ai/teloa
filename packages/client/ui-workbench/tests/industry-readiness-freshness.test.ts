import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

// N24 同批收尾：准备清单只把「本加载当前这轮核对读到的」清单回报给目录。重读开始、重读失败、一键后宿主未带最终清单且重读失败时，
// 旧清单只能作上次结果；迟到的旧读取与其他加载的清单都不能写入。读取与一键准备仍走同一个 port。
type Node={type:unknown;props:Record<string,any>}
const loadId='77777777-7777-4777-8777-777777777777',otherLoad='78777777-7777-4777-8777-777777777777'
const R='88888888-8888-4888-8888-888888888888',S='99999999-9999-4999-8999-999999999999'
type SkillState='ready'|'needs-user'
const sheet=(skill:SkillState,id=loadId,role:'ready'|'auto'='ready')=>({loadId:id,status:'active',title:'Writing partner',version:'1.0.0',digest:(skill==='ready'?'a':'b').repeat(63)+(role==='ready'?'1':'2'),
 counts:{ready:Number(skill==='ready')+Number(role==='ready'),auto:Number(role==='auto'),needsUser:Number(skill!=='ready'),optional:0,pending:0},rows:[
 {itemInstanceId:R,kind:'role',title:'Writing Bot',state:role,step:role==='auto'?'role':null,entry:null},
 {itemInstanceId:S,kind:'skill',title:'Writing revision',state:skill,step:null,entry:skill==='ready'?null:'skill-confirm'}]})
const t=(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail});return {promise,resolve,reject}}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
const nodes=(node:unknown):Node[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'&&'props' in node?[node as Node,...nodes((node as Node).props.children)]:[]
const text=(node:unknown):string=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'&&'props' in node?text((node as Node).props.children):''
const button=(tree:unknown,label:string)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label)

/** 转译真实面板执行：useState/useRef/useEffect 按依赖调度与清理，异步结果到来后由测试再渲染。 */
function mount(initial:Record<string,unknown>){
 const js=ts.transpileModule(readFileSync(new URL('../src/client/IndustryReadinessPanel.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const slots:unknown[]=[],effects=new Map<number,{deps:readonly unknown[];cleanup:(()=>void)|undefined}>()
 let cursor=0,dirty=false,pending:Array<()=>void>=[]
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>({type,props:{...props,children:children.flat(Infinity)}}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (previous:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(value:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:value})},
  useEffect:(run:()=>void|(()=>void),deps:readonly unknown[])=>{const index=cursor++,previous=effects.get(index);if(previous&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return;pending.push(()=>{previous?.cleanup?.();const cleanup=run();effects.set(index,{deps,cleanup:typeof cleanup==='function'?cleanup:undefined})})},
 }
 const require=(id:string)=>id==='react'?React:id.endsWith('.css')?{default:new Proxy({},{get:(_,key)=>String(key)})}:id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t})}:id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>value instanceof Error?value.message:String(value)}:assert.fail('未声明的依赖：'+id)
 const exports:Record<string,any>={}
 new Function('require','exports','React',js)(require,exports,React)
 let props=initial
 const view=()=>{let guard=0,tree:Node;do{assert.ok(guard++<20,'不应无限重渲染');dirty=false;cursor=0;pending=[];tree=exports.IndustryReadinessPanel(props);for(const run of pending)run()}while(dirty);return (tree.type as (value:unknown)=>unknown)(tree.props)}
 return {view,update:(next:Record<string,unknown>)=>{props={...props,...next};return view()}}
}
function harness(){
 const reads:Array<{id:string}&ReturnType<typeof deferred<unknown>>>=[],reported:unknown[]=[],prepared:unknown[]=[]
 const prepare=deferred<unknown>()
 const port={read:(id:string)=>{const next={id,...deferred<unknown>()};reads.push(next);return next.promise},prepare:(id:string,digest:string)=>{prepared.push([id,digest]);return prepare.promise}}
 const digestOf=()=>(reported.at(-1) as {digest?:string}|undefined)?.digest
 return {reads,reported,prepared,prepare,port,digestOf,props:{loadId,port,refreshKey:'k1',onOpen:()=>{},onRead:(value:unknown)=>reported.push(value)}}
}

test('成功核对后关联状态变化且重读失败：不再回报旧清单，面板标为上次结果并可重新核对；重新读成功后回报同一条目的准确状态',async()=>{
 const h=harness(),panel=mount(h.props)
 panel.view()
 h.reads[0]!.resolve(sheet('ready'));await flush()
 let tree=panel.view()
 assert.equal(h.digestOf(),sheet('ready').digest)
 assert.match(text(tree),/market\.industry\.prepare\.titleDone/)
 // 关联状态变化：重读一开始就撤下旧清单，读取期间没有当前核对
 panel.update({refreshKey:'k2'})
 assert.equal(h.reported.at(-1),undefined)
 h.reads[1]!.reject(Error('准备清单读取失败'));await flush()
 tree=panel.view()
 assert.equal(h.reported.at(-1),undefined,'重读失败后不把旧清单当当前')
 assert.match(text(tree),/market\.industry\.prepare\.titleStale/)
 assert.doesNotMatch(text(tree),/market\.industry\.prepare\.titleDone/,'上次结果不写成都准备好了')
 assert.match(text(tree),/market\.industry\.prepare\.staleNote/)
 assert.match(text(tree),/准备清单读取失败/)
 // 重新核对复用同一个读取入口
 button(tree,'market.industry.prepare.retry')!.props.onClick()
 panel.view()
 assert.deepEqual(h.reads.map(read=>read.id),[loadId,loadId,loadId])
 h.reads[2]!.resolve(sheet('needs-user'));await flush()
 tree=panel.view()
 assert.equal(h.digestOf(),sheet('needs-user').digest)
 assert.doesNotMatch(text(tree),/market\.industry\.prepare\.(titleStale|staleNote)/)
})

test('迟到的旧读取（成功或失败）都不能覆盖较新的核对结果',async()=>{
 const h=harness(),panel=mount(h.props)
 panel.view();panel.update({refreshKey:'k2'});panel.update({refreshKey:'k3'})
 assert.equal(h.reads.length,3)
 h.reads[2]!.resolve(sheet('needs-user'));await flush();panel.view()
 h.reads[0]!.resolve(sheet('ready'));h.reads[1]!.reject(Error('旧读取失败'));await flush()
 const tree=panel.view()
 assert.equal(h.digestOf(),sheet('needs-user').digest)
 assert.equal(h.reported.filter(value=>(value as {digest?:string}|undefined)?.digest===sheet('ready').digest).length,0)
 assert.doesNotMatch(text(tree),/market\.industry\.prepare\.(titleDone|titleStale|staleNote)|旧读取失败/)
})

test('换到另一个加载：上一加载的清单不再显示、不回报；新加载读到后只回报自己的清单',async()=>{
 const h=harness(),panel=mount(h.props)
 panel.view();h.reads[0]!.resolve(sheet('ready'));await flush();panel.view()
 assert.equal(h.digestOf(),sheet('ready').digest)
 const tree=panel.update({loadId:otherLoad})
 assert.equal(h.reported.at(-1),undefined)
 assert.doesNotMatch(text(tree),/Writing revision|titleDone/)
 assert.deepEqual(h.reads.map(read=>read.id),[loadId,otherLoad])
 h.reads[1]!.resolve(sheet('needs-user',otherLoad));await flush();panel.view()
 assert.equal((h.reported.at(-1) as {loadId:string}).loadId,otherLoad)
})

test('一键准备后宿主未带最终清单且重读失败：按原摘要提交一次，旧清单只作上次结果，不回报为当前',async()=>{
 const h=harness(),panel=mount(h.props)
 panel.view();h.reads[0]!.resolve(sheet('ready',loadId,'auto'));await flush()
 button(panel.view(),'market.industry.prepare.run')!.props.onClick()
 button(panel.view(),'market.industry.prepare.confirmRun')!.props.onClick()
 assert.deepEqual(h.prepared,[[loadId,sheet('ready',loadId,'auto').digest]])
 h.prepare.resolve({loadId,digest:sheet('ready',loadId,'auto').digest,results:[{itemInstanceId:R,title:'Writing Bot',step:'role',outcome:'done',code:null,message:null}],readiness:null});await flush()
 assert.equal(h.reads.length,2,'回执未带最终清单时用同一入口再读一次')
 h.reads[1]!.reject(Error('最终清单读取失败'));await flush()
 const tree=panel.view()
 assert.equal(h.reported.at(-1),undefined)
 assert.match(text(tree),/market\.industry\.prepare\.titleStale/)
 assert.match(text(tree),/market\.industry\.prepare\.result/)
 assert.equal(button(tree,'market.industry.prepare.run'),undefined,'上次结果上不再提供一键准备')
 assert.equal(h.prepared.length,1,'不自动重试一键准备')
})
