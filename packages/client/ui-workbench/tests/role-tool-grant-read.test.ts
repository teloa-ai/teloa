import assert from 'node:assert/strict'
import test from 'node:test'
import {roleFormDraftModule} from './role-form-drafts-fixture.ts'
import {readFileSync,existsSync} from 'node:fs'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import * as contract from '@teloa/contract'
registerHooks({resolve(specifier,context,next){if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)}return next(specifier,context)}})
const rolePreview=await import('../src/client/role-preview.ts'),grantPresentation=await import('../src/client/role-tool-grant-presentation.ts')
const {createRoleToolGrantApi}=await import('../src/client/role-tool-grant-api.ts')
type View={type:unknown;props:Record<string,any>;children:any[]}
const nodes=(value:any):View[]=>value&&typeof value==='object'&&'props'in value?[value,...value.children.flatMap(nodes)]:[]
const tick=()=>new Promise<void>(done=>setImmediate(done))
function mount(props:Record<string,unknown>){
 const states:any[]=[],effects:Array<()=>void>=[];let cursor=0
 const react={useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),useRef:(value:unknown)=>{const i=cursor++;return states[i]??(states[i]={current:value})},createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props:props??{},children:children.flat(Infinity)}),useState:(initial:unknown)=>{const id=cursor++;if(!(id in states))states[id]=initial;return [states[id],(next:any)=>{states[id]=typeof next==='function'?next(states[id]):next}]},useEffect:(effect:()=>void,deps:unknown[])=>{const id=cursor++;if(!states[id]||deps.some((value,index)=>value!==states[id][index])){states[id]=deps;effects.push(effect)}}}
 const modules:Record<string,unknown>={react,'./role-form-drafts.js':roleFormDraftModule(react),'@teloa/contract':contract,'./role-preview.js':rolePreview,'./role-tool-grant-presentation.js':grantPresentation,'./CapabilityNotice.js':{useApplicationCapability:()=>true},'./application-presentation.js':{applicationPresentation:{can:()=>true}},'./i18n/provider.js':{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key})},'./i18n/errors.js':{localizeWorkError:(_:unknown,error:Error)=>error.message}}
 const exported:Record<string,any>={},code=ts.transpileModule(readFileSync(new URL('../src/client/RoleToolGrants.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 new Function('require','exports','React',code)((id:string)=>modules[id]??{default:{}},exported,react)
 return ()=>{cursor=0;const view=exported.RoleToolGrants(props);for(const effect of effects.splice(0))effect();return view as View}
}
const roleId='11111111-1111-4111-8111-111111111111'
test('在岗员工只读现有授权与正确暂停说明，不取不可编辑候选',async()=>{
 for(const withDelegations of [false,true]){
  const calls:string[]=[],api=createRoleToolGrantApi(async endpoint=>{calls.push(endpoint);if(endpoint==='role-tools/get')return {roleVersion:3,grant:null};throw Error('不应读取编辑候选')},{read:()=>null,write:()=>{},clear:()=>{}})
  const render=mount({role:{id:roleId,kind:'employee',state:'active',version:3},api,resources:{directory:async()=>({resources:[]})},changed:()=>{},...(withDelegations?{delegations:{get:async()=>({roleId,roleVersion:3,delegations:[],consents:[],canEditExecution:false})}}:{})})
  render();await tick();const view=render()
  assert.deepEqual(calls,['role-tools/get']);assert.equal(nodes(view).some(node=>node.props.role==='alert'),false)
  assert.ok(nodes(view).some(node=>node.children.includes('roleGrant.none')));assert.ok(nodes(view).some(node=>node.children.includes('roleGrant.pauseHint')))
 }

})
test('暂停员工12/30引用真实读取编辑候选，原保存入口可操作而非隐藏错误',async()=>{
 for(const count of [12,30]){
  const calls:string[]=[],allowed=Array.from({length:count},(_,index)=>({id:'source-'+index,version:'a'.repeat(64)}))
  const api=createRoleToolGrantApi(async endpoint=>{calls.push(endpoint);return endpoint==='role-tools/get'?{roleVersion:3,grant:null}:{roleVersion:3,rules:[{name:'mcp__teloa_reference__read_reference',allowed}]}},{read:()=>null,write:()=>{},clear:()=>{}})
  const render=mount({role:{id:roleId,kind:'employee',state:'paused',version:3},delegations:{get:async()=>({roleId,roleVersion:3,delegations:[],consents:[],canEditExecution:true})},api,resources:{directory:async()=>({resources:[]})},changed:()=>{}})
  render();await tick();const view=render()
  assert.deepEqual(calls,['role-tools/get','role-tools/candidates']);assert.equal(nodes(view).some(node=>node.props.role==='alert'),false)
  const options=nodes(view).find(node=>typeof node.type==='function'&&node.type.name==='RoleToolGrantOptions')!
  assert.equal(options.props.candidates.rules[0].allowed.length,count);assert.equal(options.props.disabled,false)
 }
})

test('现有授权回显勾选；增删从完整当前集合起步，最后一项取消仍保留空草稿',async()=>{
 const read={name:'read',allowed:[],workspaceFiles:'default-workspace'},web={name:'web_search',allowed:[],anyArguments:true}
 const current={roleVersion:3,grant:{roleId,roleVersion:2,state:'active',rules:[read],createdAt:'2026-10-28T00:00:00.000Z'}}
 const api=createRoleToolGrantApi(async endpoint=>endpoint==='role-tools/get'?current:{roleVersion:3,rules:[read,web]},{read:()=>null,write:()=>{},clear:()=>{}})
 const render=mount({role:{id:roleId,kind:'employee',state:'paused',version:3},api,resources:{directory:async()=>({resources:[]})},changed:()=>{}})
 render();await tick();let view=render()
 const options=()=>nodes(view).find(node=>typeof node.type==='function'&&node.type.name==='RoleToolGrantOptions')!
 const readKey=grantPresentation.roleToolGrantSelectionKey(read as never),webKey=grantPresentation.roleToolGrantSelectionKey(web as never)
 assert.deepEqual(options().props.selected,[readKey])
 options().props.toggle(webKey,true);view=render();assert.deepEqual(options().props.selected,[readKey,webKey])
 options().props.toggle(readKey,false);view=render();assert.deepEqual(options().props.selected,[webKey])
 options().props.toggle(webKey,false);view=render();assert.deepEqual(options().props.selected,[])
 assert.ok(nodes(view).some(node=>node.children.includes('roleDelegation.toolReplacement')))
 assert.equal(nodes(view).find(node=>node.type==='button'&&node.children.includes('roleGrant.save'))?.props.disabled,true)
})
test('未知有限参数即使被旧授权或伪造UI回调选中也阻止保存，明确移除后只保留可核对项',async()=>{
 const known={name:'read',allowed:[],workspaceFiles:'default-workspace'},unknown={name:'mcp__future__query',allowed:[{query:'unknown'}]},calls:unknown[]=[]
 const api=createRoleToolGrantApi(async(endpoint,payload)=>{if(endpoint==='role-tools/change'){calls.push(payload);throw Error('not expected')};return endpoint==='role-tools/get'?{roleVersion:3,grant:{roleId,roleVersion:3,state:'active',rules:[known,unknown],createdAt:'2026-10-28T00:00:00.000Z'}}:{roleVersion:3,rules:[known,unknown]}},{read:()=>null,write:()=>{},clear:()=>{}})
 const render=mount({role:{id:roleId,kind:'employee',state:'paused',version:3},api,resources:{directory:async()=>({resources:[]})},changed:()=>{}})
 render();await tick();let view=render();let save=nodes(view).find(node=>node.type==='button'&&node.children.includes('roleGrant.save'))!;assert.equal(save.props.disabled,true);await save.props.onClick();assert.equal(calls.length,0)
 const remove=nodes(view).find(node=>node.type==='button'&&node.children.includes('roleDelegation.reviewAvailableTools'))!;remove.props.onClick();view=render()
 const options=nodes(view).find(node=>typeof node.type==='function'&&node.type.name==='RoleToolGrantOptions')!;assert.deepEqual(options.props.selected,[grantPresentation.roleToolGrantSelectionKey(known as never)])
 save=nodes(view).find(node=>node.type==='button'&&node.children.includes('roleGrant.save'))!;assert.equal(save.props.disabled,false)
 options.props.toggle(grantPresentation.roleToolGrantSelectionKey(unknown,unknown.allowed[0]!),true);view=render();save=nodes(view).find(node=>node.type==='button'&&node.children.includes('roleGrant.save'))!;assert.equal(save.props.disabled,true);await save.props.onClick();assert.equal(calls.length,0)
})
