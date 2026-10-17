import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes,type MarketNode} from './market-component-harness.ts'
import {PromptPreparation,type PreparedPrompt,type PreparedInputSnapshot} from '../src/client/prompt-preparation.ts'

type Effect={fn:()=>unknown;deps:unknown[]|undefined;cleanup?:unknown}
function reactRuntime(){
 const states:unknown[]=[];let cursor=0,previous:Effect[]=[],pending:Effect[]=[]
 const react={
  useState:(initial:unknown)=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?(initial as()=>unknown)():initial;return [states[i],(next:unknown)=>{states[i]=typeof next==='function'?(next as(v:unknown)=>unknown)(states[i]):next}]},
  useRef:(value:unknown)=>{const i=cursor++;return (states[i]??=({current:value})) as {current:unknown}},useId:()=>'fixture-id',
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),useMemo:(factory:()=>unknown)=>factory(),useCallback:(fn:unknown)=>fn,
  useEffect:(fn:()=>unknown,deps?:unknown[])=>{pending.push({fn,deps})},
 }
 const begin=()=>{cursor=0;pending=[]}
 const commit=()=>{pending.forEach((effect,index)=>{const before=previous[index],changed=!before||!effect.deps||!before.deps||effect.deps.length!==before.deps.length||effect.deps.some((dep,j)=>!Object.is(dep,before.deps![j]));if(!changed){effect.cleanup=before.cleanup;return}if(typeof before?.cleanup==='function')(before.cleanup as()=>void)();effect.cleanup=effect.fn()});previous=pending}
 const unmount=()=>{for(const effect of previous)if(typeof effect.cleanup==='function')(effect.cleanup as()=>void)();previous=[]}
 const strictRestart=()=>{for(const effect of previous){if(typeof effect.cleanup==='function')(effect.cleanup as()=>void)();effect.cleanup=effect.fn()}}
 return {react,begin,commit,unmount,strictRestart}
}
const SESSION='session-original',resource={id:'11111111-1111-4111-8111-111111111111',title:'原资料',version:2},skill={name:'summarize',source:'local/SKILL.md',provider:'teloa',userInvocable:true}
const originalAttachment='attachment-original' as PreparedInputSnapshot['attachmentIds'][number]
const settle=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(preparation=new PromptPreparation()){
 const runtime=reactRuntime(),page=mount('PreparedPromptCard.tsx',{react:runtime.react,
  './i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'zh-CN'})},
  './i18n/errors.js':{localizeWorkError:(_locale:string,error:unknown)=>error instanceof Error?error.message:String(error)},
  './ToolbarIconButton.js':{ToolbarIconButton:()=>null},
 })
 let state:PreparedInputSnapshot=Object.freeze({draft:'',draftRev:1,phase:'plain',attachmentIds:[],running:false})
 const replaceState=(next:PreparedInputSnapshot)=>{state=Object.freeze({...next,attachmentIds:Object.freeze([...next.attachmentIds])})}
 const calls:string[]=[],writes:{kind:string;revision:number;text?:string;id?:string}[]=[],legacy:string[]=[]
 let candidates:()=>Promise<typeof resource[]>=async()=>[resource],validate=async(_row:PreparedPrompt)=>{},failText=false,failReference=false
 const props=()=>({sessionId:SESSION,session:{running:state.running},input:{...state},inputActions:{setDraft:(text:string)=>legacy.push(text)},preparation,
  resourceApi:{candidates:async()=>{calls.push('resources');return candidates()}},
  resourceInput:{read:()=>({...state}),text:async(text:string,revision:number)=>{calls.push('text');assert.equal(revision,state.draftRev);if(failText)throw Error('输入未接收');writes.push({kind:'text',text,revision});replaceState({...state,draft:text,draftRev:state.draftRev+1});return {...state}},reference:async(value:typeof resource,revision:number)=>{calls.push('reference');assert.equal(revision,state.draftRev);if(failReference)throw Error('资料未接收');writes.push({kind:'reference',id:value.id,revision});replaceState({...state,draft:'[原资料]'+state.draft,draftRev:state.draftRev+1});return {...state}}},
  work:{subscribe:()=>()=>{},readCatalog:async()=>{calls.push('skills')},getSnapshot:()=>({sessionId:SESSION,status:'ready',catalogStatus:'ready',capabilities:{skills:catalogValue}})},
  validateTask:async(row:PreparedPrompt)=>{calls.push('task');await validate(row)},openSource:()=>{},
 })
 let tree:MarketNode|null=null,catalogValue=[skill]
 const render=()=>{runtime.begin();tree=page.render('PreparedPromptCard',props());runtime.commit();return tree}
 const button=()=>nodes(tree).find(node=>node.type==='button'&&node.children.includes('p6.preparedPrompt.insert'))
 const errors=()=>nodes(tree).filter(node=>node.props.role==='alert').flatMap(node=>node.children).join(' ')
 return {preparation,get state(){return state},replaceState,calls,writes,legacy,render,errors,unmount:runtime.unmount,strictRestart:runtime.strictRestart,cardVisible:()=>!!tree,
  async manual(){render();const action=button();assert.ok(action);assert.equal(action.props.disabled,false);await action.props.onClick();await settle();render()},
  status:(id='p1')=>preparation.getSnapshot().find(row=>row.id===id)?.status,
  preset:(id='p1',text='预设目标',extra:Partial<PreparedPrompt>={})=>preparation.prepare({id,sourceId:'source-original',sourceVersion:1,sessionId:SESSION,title:'本人选中的预设',text,...extra}),
  setCandidates:(read:typeof candidates)=>{candidates=read},setCatalog:(rows:typeof skill[])=>{catalogValue=rows},setValidation:(read:typeof validate)=>{validate=read},setTextFailure:(fail:boolean)=>{failText=fail},setReferenceFailure:(fail:boolean)=>{failReference=fail},
 }
}

test('一次明确准备后直接带入原草稿，使用原生修订号且没有发送或第二次按钮',async()=>{
 const f=fixture();f.preset();f.render();await settle();f.render()
 assert.equal(f.state.draft,'预设目标');assert.equal(f.status(),'inserted');assert.equal(f.cardVisible(),false)
 assert.deepEqual(f.writes,[{kind:'text',text:'预设目标',revision:1}]);assert.deepEqual(f.calls,['text']);assert.deepEqual(f.legacy,[])
 f.replaceState({...f.state,draft:'',draftRev:f.state.draftRev+1});f.render();await settle();f.render();assert.equal(f.state.draft,'','删掉已带入文字后不回填旧记录')
})

test('任务、固定资料与技能一并只读核验，直接进入同一输入而非等第二次带入',async()=>{
 const f=fixture();f.preset('p1','核对原资料',{sourceKind:'task',taskSnapshot:'snapshot-original',resources:[resource],skills:[skill]});f.render();await settle();f.render()
 assert.equal(f.status(),'inserted');assert.deepEqual(f.calls,['task','resources','skills','text','reference'])
 assert.deepEqual(f.writes,[{kind:'text',text:'/summarize \n核对原资料',revision:1},{kind:'reference',id:resource.id,revision:2}]);assert.equal(f.state.draft,'[原资料]/summarize \n核对原资料');assert.deepEqual(f.legacy,[])
})

test('已有草稿或附件保留人工入口，后来清空也不会意外回填旧预设',async()=>{
 for(const occupied of ['draft','attachment']){
  const f=fixture();f.replaceState(occupied==='draft'?{...f.state,draft:'本人原草稿'}:{...f.state,attachmentIds:[originalAttachment]});f.preset();f.render();await settle();f.render()
  assert.equal(f.status(),'pending');assert.deepEqual(f.writes,[]);assert.equal(f.state.draft,occupied==='draft'?'本人原草稿':'')
  f.replaceState({...f.state,draft:'',attachmentIds:[],draftRev:f.state.draftRev+1});f.render();await settle();f.render();assert.equal(f.status(),'pending');assert.deepEqual(f.writes,[])
  await f.manual();assert.equal(f.status(),'inserted');assert.equal(f.state.draft,'预设目标')
 }
})

test('明确准备时输入暂忙而空白，可等就绪带入；忙期间产生了草稿则不再自动',async()=>{
 for(const busy of ['running','phase'] as const){
  const f=fixture();f.replaceState(busy==='running'?{...f.state,running:true}:{...f.state,phase:'submitting'});f.preset();f.render();await settle();f.render();assert.deepEqual(f.writes,[])
  f.replaceState({...f.state,running:false,phase:'plain'});f.render();await settle();f.render();assert.equal(f.status(),'inserted')
 }
 const f=fixture();f.replaceState({...f.state,running:true});f.preset();f.render();await settle();f.replaceState({...f.state,draft:'忙期间本人输入',draftRev:f.state.draftRev+1});f.render();await settle();f.replaceState({...f.state,running:false,draft:'',draftRev:f.state.draftRev+1});f.render();await settle();assert.deepEqual(f.writes,[])
})

test('资源权限或版本、技能来源或唯一性不符时零写入，失败有错误且不自动重试',async()=>{
 for(const reason of ['permission','version','skill-source','skill-provider','skill-ambiguous','skill-noninvocable'] as const){
  const f=fixture();f.preset('p1','目标',reason.startsWith('skill')?{skills:[skill]}:{resources:[resource]})
  if(reason==='permission')f.setCandidates(async()=>[]);if(reason==='version')f.setCandidates(async()=>[{...resource,version:3}])
  if(reason==='skill-source')f.setCatalog([{...skill,source:'other/SKILL.md'}]);if(reason==='skill-provider')f.setCatalog([{...skill,provider:'other'}]);if(reason==='skill-ambiguous')f.setCatalog([skill,{...skill,source:'other/SKILL.md'}]);if(reason==='skill-noninvocable')f.setCatalog([{...skill,userInvocable:false}])
  f.render();await settle();f.render();assert.deepEqual(f.writes,[],reason);assert.equal(f.status(),'pending',reason);assert.ok(f.errors(),reason)
  const before=[...f.calls];for(let i=0;i<3;i++){f.render();await settle()}assert.deepEqual(f.calls,before,reason+'：无自动循环')
 }
})

test('任务原关联已变化时保留stale卡片和错误，不带入旧快照',async()=>{
 const f=fixture();f.preset('p1','旧任务目标',{sourceKind:'task',taskSnapshot:'snapshot-original'});f.setValidation(async row=>{f.preparation.invalidate(row.sourceId);throw Error('原任务关联已变化')});f.render();await settle();f.render()
 assert.equal(f.status(),'stale');assert.deepEqual(f.writes,[]);assert.equal(f.errors(),'原任务关联已变化');assert.deepEqual(f.calls,['task'])
})

test('异步核验期间用户输入的修订号变化，原草稿不覆盖且不冒充带入',async()=>{
 for(const source of ['task','resource']){
  const f=fixture();let finish!:()=>void
  const read=()=>new Promise<typeof resource[]>(resolve=>{finish=()=>resolve([resource])})
  if(source==='task')f.setValidation(async()=>{await read()});else f.setCandidates(read)
  f.preset('p1','目标',source==='task'?{sourceKind:'task',taskSnapshot:'snapshot-original'}:{resources:[resource]});f.render();await settle()
  f.replaceState({...f.state,draft:'核验期间本人写的内容',draftRev:f.state.draftRev+1});finish();await settle();f.render()
  assert.equal(f.state.draft,'核验期间本人写的内容',source);assert.deepEqual(f.writes,[],source);assert.equal(f.status(),'pending',source);assert.match(f.errors(),/输入已变化/)
 }
})

test('部分带入保存确切回执，重挂载不自动补写，手动继续不会重写目标',async()=>{
 const f=fixture();f.setReferenceFailure(true);f.preset('p1','目标',{resources:[resource]});f.render();await settle();f.render()
 assert.equal(f.status(),'pending');assert.deepEqual(f.writes,[{kind:'text',text:'目标',revision:1}]);assert.deepEqual(f.preparation.getSnapshot()[0]?.transfer,{textInserted:true,resourceIds:[]});assert.equal(f.errors(),'资料未接收')
 f.unmount();f.setReferenceFailure(false);f.render();await settle();f.render();assert.deepEqual(f.writes,[{kind:'text',text:'目标',revision:1}]);assert.equal(f.errors(),'资料未接收')
 await f.manual();assert.deepEqual(f.writes,[{kind:'text',text:'目标',revision:1},{kind:'reference',id:resource.id,revision:2}]);assert.equal(f.status(),'inserted')
})

test('输入写入失败在队列中保留错误，跨组件重挂载也不循环尝试，手动重试可恢复',async()=>{
 const f=fixture();f.setTextFailure(true);f.preset();f.render();await settle();f.render();assert.equal(f.errors(),'输入未接收');assert.deepEqual(f.calls,['text'])
 f.unmount();const next=fixture(f.preparation);next.render();await settle();next.render();assert.deepEqual(next.calls,[]);assert.equal(next.errors(),'输入未接收')
 await next.manual();assert.equal(next.status(),'inserted');assert.deepEqual(next.writes,[{kind:'text',text:'预设目标',revision:1}])
})

test('连续两个预设不覆盖第一个，后一个只能显式继续；其它会话不带入',async()=>{
 const f=fixture();f.preset();f.render();await settle();f.render();f.preset('p2','第二个目标');f.render();await settle();f.render();assert.equal(f.state.draft,'预设目标');assert.equal(f.status('p2'),'pending')
 f.replaceState({...f.state,draft:'',draftRev:f.state.draftRev+1});f.render();await settle();f.render();assert.equal(f.state.draft,'');assert.equal(f.status('p2'),'pending');await f.manual();assert.equal(f.state.draft,'第二个目标')
 const other=fixture();other.preset('other','其它目标',{sessionId:'other-session'});other.render();await settle();assert.deepEqual(other.writes,[]);assert.equal(other.cardVisible(),false)
})

test('StrictMode效果重启不取消健康的首次带入，也不会重复写草稿',async()=>{
 const f=fixture();f.preset();f.render();f.strictRestart();await settle();f.render();assert.equal(f.status(),'inserted');assert.equal(f.writes.length,1)
})

test('手动带入抢先于自动效果失败时也不会转成自动重试',async()=>{
 const f=fixture();f.setTextFailure(true);f.preset();await f.manual();assert.equal(f.errors(),'输入未接收');assert.deepEqual(f.calls,['text'])
 f.render();await settle();f.render();assert.deepEqual(f.calls,['text']);assert.equal(f.status(),'pending')
})

test('空白文字预设不虚报已带入，失败卡片仍可返回来源或撤回',async()=>{
 const f=fixture();f.preset('p1','  ');f.render();await settle();f.render();assert.equal(f.status(),'pending');assert.deepEqual(f.writes,[]);assert.match(f.errors(),/没有可恢复文字/)
})
