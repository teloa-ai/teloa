import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createSkillSecretsApi,skillSecretsBadge} from '../src/client/skill-secrets-api.ts'
const req=createRequire(import.meta.url),ts=req('typescript')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const variable={envVarName:'SKILL_API_KEY',label:{'zh-CN':'密钥',en:'Key'},required:true,configured:false,target:'bearer',endpoints:[{origin:'https://api.example.com',pathPrefixes:['/v1/']}]}
const state=(id='install-A',skill='own-skill',authorized=true)=>({skill,binding:authorized?'a'.repeat(64):null,writable:true,reconfirm:false,vars:authorized?[variable]:[],owner:{installation:'b'.repeat(64),installationId:id,version:'1.0.0',authorized}})

// 直接加载实际TSX；仅替换React hook调度、i18n与CSS外壳，不启动产品浏览器。
function harness(file){
 const slots=[],effects=[];let cursor=0
 const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useRef:value=>{const i=cursor++;return slots[i]??(slots[i]={current:value})},useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}]},useEffect:run=>effects.push(run)}
 const load=name=>{
  const source=new URL('../src/client/'+name,import.meta.url),code=ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,exports={}
  const modules={react:React,'lucide-react':{ArrowLeft:()=>null},'./ToolbarIconButton.js':{ToolbarIconButton:()=>null},'./McpConnectionView.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})},'./i18n/provider.js':{useI18n:()=>({locale:'zh-CN',t:key=>key})},'./i18n/format.js':{formatList:(_locale,items)=>items.join(', ')}}
  if(name!=='OwnedSkillConsent.tsx')modules['./OwnedSkillConsent.js']=load('OwnedSkillConsent.tsx')
  new Function('require','exports','React',code)(id=>{assert(id in modules,'Unexpected component dependency '+id);return modules[id]},exports,React)
  return exports
 }
 const exports=load(file)
 return {exports,effects,render:(name,props)=>{cursor=0;effects.length=0;assert.equal(typeof exports[name],'function');return exports[name](props)}}
}
const nodes=node=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const component=(tree,name)=>nodes(tree).find(n=>n.type?.name===name)
const text=node=>node==null?'':typeof node==='string'?node:(node.children??[]).map(text).join(' ')
async function mounted(api,initial=state()){
 const ui=harness('SkillSecretsView.tsx'),props={skill:'own-skill',title:'Clicked A',expectedInstallationId:'install-A',api:{describe:async()=>initial,...api},onBack(){}}
 const render=()=>ui.render('SkillSecretsView',props);render();ui.effects[0]();await tick()
 return {ui,props,render}
}

test('首次describe错skill或安装即收起授权控件，不能在A详情接纳B',async()=>{
 for(const reply of [state('install-B'),state('install-A','another-skill')]){
  const f=await mounted({},reply),tree=f.render(),view=component(tree,'SkillSecretsViewPresentation')
  assert.equal(view.props.state,null);assert.match(view.props.error,/重新打开/);assert.equal(component(tree,'OwnedSkillConsent'),undefined)
 }
})
test('动作成功和version-conflict刷新同样检查skill及点击安装，不把B授权表单装进A',async()=>{
 for(const flow of ['success','conflict'])for(const wrong of [state('install-B'),state('install-A','another-skill')]){
  let reads=0,sends=0
  const f=await mounted({describe:async()=>++reads===1?state():wrong,save:async()=>{sends++;if(flow==='conflict')throw Object.assign(Error('changed'),{code:'teloa/version-conflict'});return wrong}})
  component(f.render(),'SkillSecretsViewPresentation').props.onSave({SKILL_API_KEY:'synthetic-only-value'})
  await tick();const tree=f.render(),view=component(tree,'SkillSecretsViewPresentation')
  assert.equal(view.props.state,null);assert.match(view.props.error,/重新打开/);assert.equal(component(tree,'OwnedSkillConsent'),undefined);assert.equal(sends,1)
 }
})
test('拒绝或超时保留非秘密授权草稿，只有同origin实际成功才清目标/参数/确认且不自动重发',async()=>{
 const original=state('install-A','own-skill',false);let fail=true,calls=0
 const f=await mounted({authorizeOwned:async()=>{calls++;if(fail)throw Error('timeout');return state()},revokeOwned:async()=>original},original)
 let own=component(f.render(),'OwnedSkillConsent')
 own.props.onDraft({target:'header',destination:'https://api.example.com/v1/',parameter:'X-Api-Key',method:'POST',confirmed:true})
 const submit=()=>{const child=harness('OwnedSkillConsent.tsx');const form=nodes(child.render('OwnedSkillConsent',component(f.render(),'OwnedSkillConsent').props)).find(n=>n.type==='form');form.props.onSubmit({preventDefault(){}})}
 submit();await tick();own=component(f.render(),'OwnedSkillConsent')
 assert.deepEqual(own.props.draft,{target:'header',destination:'https://api.example.com/v1/',parameter:'X-Api-Key',method:'POST',confirmed:true});assert.equal(calls,1)
 f.render();await tick();assert.equal(calls,1,'渲染不重试未知结果')
 fail=false;submit();await tick();own=component(f.render(),'OwnedSkillConsent')
 assert.deepEqual(own.props.draft,{target:'header',destination:'',parameter:'',method:'POST',confirmed:false});assert.equal(calls,2)
})
test('不可写/锁定优先恢复存储，不显示未安装、待授权或可提交的授权表单',async()=>{
 const locked={...state('install-A','own-skill',false),writable:false,owner:{...state().owner,authorized:null}}
 const api=createSkillSecretsApi(async()=>locked),reply=await api.describe('own-skill');assert.equal(reply.owner.authorized,null)
 assert.match(skillSecretsBadge(reply,key=>key),/lockedShort/);assert.doesNotMatch(skillSecretsBadge(reply,key=>key),/needsInstall|待本人授权/)
 assert.match(skillSecretsBadge(state('install-A','own-skill',false),key=>key),/待本人授权/)
 const ui=harness('SkillSecretsView.tsx'),tree=ui.render('SkillSecretsViewPresentation',{state:reply,busy:false,error:'',locale:'zh-CN',t:key=>key,title:'A',confirmingDelete:false})
 assert.match(text(tree),/market.skillSecrets.locked/);assert.doesNotMatch(text(tree),/needsInstall/);assert.equal(nodes(tree).some(n=>n.type==='form'),false)
 const own=harness('OwnedSkillConsent.tsx');assert.equal(own.render('OwnedSkillConsent',{skill:'own-skill',state:reply,api:{authorizeOwned(){},revokeOwned(){}},locale:'zh-CN',busy:false,draft:own.exports.initialOwnedSkillConsentDraft(),onDraft(){},act(){throw Error('must not submit')}}),null)
})
