import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

const source=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
const file=ts.createSourceFile('WorkbenchFrame.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
let declaration:ts.FunctionDeclaration|undefined
function find(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='openSetupReview')declaration=node;else ts.forEachChild(node,find)}
find(file);assert.ok(declaration)
const code=ts.transpileModule(declaration.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function fixture(follow=false,initialSession='original'){
 const read=deferred(),open=deferred(),calls:string[]=[],item={draftId:'draft',scope:'SOC',sessionId:'builder'},binding={...item},plan={...item,state:'draft',rejected:[]}
 const latestState={current:{view:'spaces',messageMode:'native',detail:{open:true,target:{kind:'business',scope:'SOC'}},rolePreview:null as null|{id:string;request:number},rolePreviewRequest:0}}
 let visible=true,session=initialSession,previewCalls=0
 const flow={getSnapshot:()=>({binding,setupPlan:plan}),refreshSetupPlan:()=>read.promise,previewSetup:async()=>{previewCalls++}}
 const identity={api:{},namespace:'owner',flow},businessBuilder={getSnapshot:()=>identity,captureNavigation:(current:()=>boolean)=>({current}),open:async(_id:string,_allow:boolean,token:{current:()=>boolean})=>{await open.promise;if(!token.current())throw Error('cancelled');session='builder';if(follow){latestState.current.view='messages';visible=false}}}
 const actions={closeDetail:()=>{calls.push('close');latestState.current.detail={...latestState.current.detail,open:false}},openMessages:()=>{calls.push('navigate');latestState.current.view='messages';latestState.current.rolePreview=null;visible=false}}
 const env={businessBuilder,projectFrameMounted:{current:true},latestState,homeCreationLocation:(state:typeof latestState.current)=>state.view,mainSession:{getSnapshot:()=>session},work:{getSnapshot:()=>({sessionId:session})},actions,setBuilderTab:()=>calls.push('tab'),setBuilderError:()=>calls.push('error'),t:(key:string)=>key,localizeWorkError:(_locale:string,error:unknown)=>String(error),locale:'zh-CN'}
 const run=new Function(...Object.keys(env),code+';return openSetupReview')(...Object.values(env)) as (item:typeof binding,current:()=>boolean)=>Promise<void>
 return {run:()=>run(item,()=>visible),read,open,calls,latestState,close:()=>{visible=false},get previewCalls(){return previewCalls}}
}
test('业务方案复核的明确导航先于慢预览；后续员工抽屉保留',async()=>{
 const f=fixture(),pending=f.run();f.open.resolve();await new Promise<void>(r=>setImmediate(r))
 assert.deepEqual(f.calls,['close','navigate','tab'])
 f.latestState.current.rolePreviewRequest++;f.latestState.current.rolePreview={id:'new-role',request:1}
 f.read.resolve();await pending.catch(()=>{})
 assert.equal(f.latestState.current.rolePreview?.id,'new-role');assert.deepEqual(f.calls,['close','navigate','tab']);assert.equal(f.previewCalls,0)
})
test('明确导航后新详情不会被旧复核回包关闭',async()=>{
 const f=fixture(),pending=f.run();f.open.resolve();await new Promise<void>(r=>setImmediate(r))
 f.latestState.current.detail={open:true,target:{kind:'business',scope:'CRM'}}
 f.read.resolve();await pending.catch(()=>{});assert.equal(f.latestState.current.detail.open,true);assert.equal(f.latestState.current.detail.target.scope,'CRM');assert.deepEqual(f.calls,['close','navigate','tab'])
})
test('复核窗口先关闭，即使原生会话随后打开也不能再获得导航权',async()=>{
 const f=fixture(),pending=f.run();f.close();f.latestState.current.view='messages';f.open.resolve();f.read.resolve();await assert.rejects(pending)
 assert.deepEqual(f.calls,[]);assert.equal(f.previewCalls,0)
})
test('来源未变化时仅导航一次并预览原方案',async()=>{
 const f=fixture(),pending=f.run();f.open.resolve();f.read.resolve();await pending
 assert.deepEqual(f.calls,['close','navigate','tab']);assert.equal(f.previewCalls,1)
})

test('原生自身切换已卸载复核来源时，成功回执仍可完成这一次明确导航',async()=>{
 const f=fixture(true),pending=f.run();f.open.resolve();f.read.resolve();await pending
 assert.deepEqual(f.calls,['close','navigate','tab']);assert.equal(f.previewCalls,1)
})

test('原生已在同一搭建会话时，从业务页复核不会因未自动跳转而失败',async()=>{
 const f=fixture(false,'builder'),pending=f.run();f.open.resolve();f.read.resolve();await pending
 assert.deepEqual(f.calls,['close','navigate','tab']);assert.equal(f.previewCalls,1)
})
