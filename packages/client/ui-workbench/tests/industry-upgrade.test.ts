import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {industryUpdateResourceOptions} from '@teloa/contract'
import {createIndustryLoadApi} from '../src/client/industry-load-api.ts'
import {industryUpdateSubmission} from '../src/client/industry-update-plan.ts'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'
import {compareIndustryUpdate} from '../src/client/industry-update.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const now='2026-09-14T00:00:00.000Z'
const loadId='12345678-1234-4234-8234-123456789012',spaceId='22345678-1234-4234-8234-123456789012',itemId='32345678-1234-4234-8234-123456789012'
const successorId='42345678-1234-4234-8234-123456789012',successorItemId='52345678-1234-4234-8234-123456789012'
const candidateContentId='62345678-1234-4234-8234-123456789012',requestId='72345678-1234-4234-8234-123456789012'
const mappingHash='b'.repeat(64),contentHash='a'.repeat(64)
const choices={resources:{guide:'candidate' as const},roles:{},relations:'keep' as const,entrypoints:'keep' as const,positioning:'keep' as const}
const load={id:loadId,ownerId:'local:teloa-owner',contentId:spaceId,contentHash,templateId:'research',templateVersion:'1.0.0',templateTitle:'研究模板',domain:'general',scope:'space-'+spaceId,description:'研究资料',targetVersion:1,
 space:{id:spaceId,name:'研究空间',version:1,scope:'space-'+spaceId},
 items:[{localId:'guide',instanceId:itemId,kind:'knowledge',title:'手册',version:'1.0.0',required:true,status:'pending-adapter'}],
 relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash,status:'active'}
const superseded={...load,status:'superseded'}
const successor={...load,id:successorId,contentId:candidateContentId,templateVersion:'1.1.0',targetVersion:2,space:{...load.space,version:2},
 items:[{...load.items[0],instanceId:successorItemId,carriedFrom:itemId}],createdAt:now,
 upgrade:{loadId,templateVersion:'1.0.0',choices,diffDigest:'c'.repeat(64),createdAt:now}}
const input={requestId,loadId,candidateContentId,expectedMappingHash:mappingHash,choices}

test('升级失败保留完整固定请求，恢复重放同一参数，明确拒绝才释放日志',async()=>{
 let raw:string|null=null,fail=true;const calls:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(method:string,payload:unknown)=>{calls.push([method,payload]);if(fail){fail=false;throw Error('连接断开')}return {superseded,successor}}
 await assert.rejects(createIndustryLoadApi(call,undefined,undefined,journal).upgrade(input),/连接断开/)
 assert.match(raw!,/teloa\.industry-load-upgrade\/v1/)
 const api=createIndustryLoadApi(call,undefined,undefined,journal)
 assert.deepEqual(api.upgradePending(),input)
 assert.deepEqual(await api.recoverUpgrade(),{superseded,successor})
 assert.deepEqual(calls[0],calls[1])
 assert.deepEqual(calls[0],['industry-loads/upgrade',input])
 assert.equal(raw,null)
 // 明确拒绝释放日志，瞬时故障保留日志。
 raw=null
 const rejected=createIndustryLoadApi(async()=>{throw Object.assign(Error('不符'),{rejected:true,code:'teloa/version-conflict'})},undefined,undefined,journal)
 await assert.rejects(rejected.upgrade(input),/不符/)
 assert.equal(raw,null)
 assert.equal(rejected.upgradePending(),undefined)
})

test('升级只提交五个字段，换目标先核对原请求，回包不自洽即拒绝',async()=>{
 const api=createIndustryLoadApi(async()=>({superseded,successor}))
 assert.deepEqual(await api.upgrade(input),{superseded,successor})
 await assert.rejects(createIndustryLoadApi(async()=>({superseded,successor})).upgrade({...input,choices:{...choices,extra:1}} as never),/格式不正确/)
 const stalled=createIndustryLoadApi(async()=>{throw Error('断开')})
 await assert.rejects(stalled.upgrade(input),/断开/)
 await assert.rejects(stalled.upgrade({...input,candidateContentId:successorId}),/原请求/)
 for(const bad of [
  {superseded:load,successor},
  {superseded,successor:{...successor,status:'superseded'}},
  {superseded,successor:{...successor,contentId:spaceId}},
  {superseded,successor:{...successor,upgrade:{...successor.upgrade,loadId:successorId}}},
  {superseded,successor:{...successor,items:[{...successor.items[0],carriedFrom:undefined}],upgrade:undefined}},
 ])await assert.rejects(createIndustryLoadApi(async()=>bad).upgrade(input),/不一致|格式不正确/)
})

const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
async function source(body='# 原手册',version='1.0.0'){
 const manifest={format:'teloa.business-package/v2',id:'research',title:'研究模板',version,domain:'general',description:'研究资料',resources:[{id:'guide',kind:'knowledge',title:'手册',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}}],relations:[],entrypoints:[]}
 return readIndustryDirectory([file('teloa.json',JSON.stringify(manifest)),file('guide.md',body)],'teloa.json','研究')
}
/** 直接转译真实表单执行：只替换 react、i18n 与错误本地化，比较核与提交整理都用真实实现。 */
function mountForm(props:Record<string,unknown>){
 const js=ts.transpileModule(readFileSync(new URL('../src/client/IndustryUpdateForm.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,attrs:Record<string,unknown>|null,...children:Node[])=>({type,props:attrs??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
 }
 const exports:Record<string,any>={}
 const require=(id:string)=>id==='react'?React
  :id==='@teloa/contract'?{industryUpdateResourceOptions}
  :id.endsWith('industry-update-plan.js')?{industryUpdateSubmission}
  :id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key})}
  :id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>String(value)}
  :new Proxy({},{get:(_,key)=>String(key)})
 new Function('require','exports','React',js)(require,exports,React)
 return ()=>{cursor=0;return exports.IndustryUpdateForm(props) as Node}
}
const nodes=(root:Node):Node[]=>root&&typeof root==='object'?[root,...root.children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]:[]
const text=(node:Node):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''

/** 表单只认宿主里的持久化加载记录：加载身份、内容身份与映射指纹都从它取。 */
async function form(saved?:unknown){
 const parsedBaseline=await source()
 const baseline={...parsedBaseline,contentStorage:{contentId:spaceId,createdAt:now,loaded:true}}
 const row={...load,scope:load.domain,contentHash:parsedBaseline.packageContent!.hash} as IndustryLoadRecord
 const context={industryRoles:[],tasks:[],plans:[]}
 const parsed=await source('# 新手册','1.1.0'),candidate={...parsed,contentStorage:{contentId:candidateContentId,createdAt:now,loaded:true}}
 const diff=compareIndustryUpdate(context,row,baseline,candidate)
 const submitted:unknown[]=[]
 const render=mountForm({context,record:row,baseline,candidate,diff,saved,upgrade:async(value:unknown)=>{submitted.push(value)}})
 return {render,submitted}
}

test('表单保存改为提交升级请求：逐项选择后固定五个字段调 API，不再落在页面内存里',async()=>{
 const {render,submitted}=await form()
 const selects=nodes(render()).filter(node=>node.type==='select')
 // 变化的资源一项（手册）+ 关联、入口、行业说明三项。
 assert.equal(selects.length,4)
 selects[0]!.props.onChange({target:{value:'candidate'}})
 nodes(render()).filter(node=>node.type==='input'&&node.props.type==='checkbox')[0]!.props.onChange({target:{checked:true}})
 const view=render()
 const submit=nodes(view).find(node=>node.type==='button'&&node.props.type==='submit')!
 assert.equal(submit.props.disabled,false)
 await nodes(view).find(node=>node.type==='form')!.props.onSubmit({preventDefault:()=>{}})
 assert.equal(submitted.length,1)
 const value=submitted[0] as {requestId:string;loadId:string;candidateContentId:string;expectedMappingHash:string;choices:unknown}
 assert.match(value.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
 assert.deepEqual({...value,requestId:''},{requestId:'',loadId,candidateContentId,expectedMappingHash:mappingHash,choices:{resources:{guide:'candidate'},roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'}})
})

test('已保存的方案从继任加载的升级血缘读回，只读回显且不再提供撤回',async()=>{
 const {render:withSaved,submitted}=await form(successor.upgrade)
 assert.equal(submitted.length,0)
 const view=withSaved()
 assert.equal(nodes(view).filter(node=>node.type==='form').length,0)
 assert.ok(nodes(view).some(node=>text(node)==='market.industry.update.saved'))
 // 方向固定为「被替代版本 → 候选版本」，不能反过来。
 // 两个版本号之间是单色箭头图标（读屏读「改为」），不再是箭头符号字符。
 const versions=nodes(view).find(node=>node.type==='p'&&node.children.some(child=>(child as unknown)==='1.0.0'))!
 assert.deepEqual(versions.children.filter(child=>typeof child==='string'&&/\d/.test(child)),['1.0.0','1.1.0'])
 assert.equal(versions.children.filter(child=>typeof child!=='string').map(child=>child.props['aria-label']).join(),'presentation.changeTo')
 assert.ok(text(view).includes('market.industry.update.notApplied'))
 assert.equal(nodes(view).filter(node=>node.type==='button').length,0)
})

/** 目录只需核对沿用标签：资源浏览器换成会真实调用 status 的桩，其余依赖沿用卸载用例的注入方式。 */
function mountDirectory(props:Record<string,unknown>,withRender=false){
 const js=ts.transpileModule(readFileSync(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  // 函数型元素立即执行：资源浏览器的 status 回调只有真正渲染才会被调用。
  createElement:(type:unknown,attrs:Record<string,unknown>|null,...children:Node[])=>typeof type==='function'?(type as (value:Record<string,unknown>)=>Node)({...(attrs??{}),children:children.flat(Infinity)}):{type,props:attrs??{},children:children.flat(Infinity)},
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useEffect:()=>{},
 }
 const exports:Record<string,any>={}
 const browser={IndustryResourceBrowser:(attrs:{resources:{id:string}[];status:(item:unknown)=>string;render:(item:unknown)=>Node})=>({type:'ul',props:{},children:attrs.resources.map(item=>({type:'li',props:{},children:[attrs.status(item) as unknown as Node,...(withRender?[attrs.render(item)]:[])]}))})}
 const require=(id:string)=>id==='react'?React
  :id.endsWith('IndustryResourceBrowser.js')?browser
  :id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key,dateTime:(value:string)=>value})}
  :id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>String(value)}
  :id.endsWith('industry-load-api.js')?{readUnloadBlockers:()=>[]}
  :new Proxy({default:new Proxy({},{get:(_,key)=>String(key)})},{get:(_,key)=>key==='default'?new Proxy({},{get:(_inner,name)=>String(name)}):()=>'none'})
 new Function('require','exports','React',js)(require,exports,React)
 return ()=>{cursor=0;return exports.SavedIndustryDirectory(props) as Node}
}
const emptyPort={items:[],error:undefined,partial:false,refresh:async()=>{},pending:undefined,recoveryError:undefined,instantiate:async()=>{throw Error()},recover:async()=>{throw Error()}}
const directoryProps=(rows:unknown[])=>({
 loads:rows,error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},
 knowledge:{...emptyPort},
 dataSources:{...emptyPort,authorize:async()=>{throw Error()}},
 executionTools:{...emptyPort,authorize:async()=>{throw Error()}},
 mcpConnections:{...emptyPort,connect:async()=>{throw Error()}},
 plugins:{...emptyPort,install:async()=>{throw Error()},reconcile:async()=>{throw Error()}},
 roles:{...emptyPort,open:async()=>{}},
 tasks:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{}},
 plans:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{},openRole:async()=>{}},
 unload:{pending:false,recoveryError:undefined,run:async()=>{},recover:async()=>{}},
 skillInstallApi:{},
})

test('继任加载里沿用旧实例的项显示沿用标签，其余项与未升级加载保持原文案',async()=>{
 const carriedView=mountDirectory(directoryProps([successor]))()
 assert.ok(text(carriedView).includes('market.industry.saved.status.carriedFrom · market.industry.saved.status.adapterPending'))
 const plainView=mountDirectory(directoryProps([load]))()
 assert.equal(text(plainView).includes('market.industry.saved.status.carriedFrom'),false)
 assert.ok(text(plainView).includes('market.industry.saved.status.adapterPending'))
})

test('沿用项的状态文案取来源实例：来源数据源已连接时继任加载同时显示沿用标签与已连接',()=>{
 const carriedSource={...successor,items:[{localId:'alerts',instanceId:successorItemId,kind:'data-source',title:'告警来源',version:'1.0.0',required:true,status:'active',carriedFrom:itemId}]}
 const props={...directoryProps([carriedSource]),dataSources:{...emptyPort,authorize:async()=>{throw Error()},items:[{id:'99999999-9999-4999-8999-999999999999',loadId,itemInstanceId:itemId,state:'active',revision:2}]}}
 assert.ok(text(mountDirectory(props)()).includes('market.industry.saved.status.carriedFrom · market.industry.saved.status.dataSourceConnected'))
})

test('沿用来的数据源尚未连接时，继任加载上仍给出连接并核验入口，且不再另开登记',()=>{
 const carried={...successor,items:[{localId:'alerts',instanceId:successorItemId,kind:'data-source',title:'告警来源',version:'1.0.0',required:true,status:'instantiated',carriedFrom:itemId}]}
 const authorized:unknown[]=[]
 const source={id:'99999999-9999-4999-8999-999999999999',loadId,itemInstanceId:itemId,state:'needs_authorization',revision:1}
 const props={...directoryProps([carried]),dataSources:{...emptyPort,items:[source],authorize:async(input:unknown)=>{authorized.push(input)}}}
 const view=mountDirectory(props,true)()
 const connect=nodes(view).find(node=>node.type==='button'&&text(node)==='market.industry.saved.connectDataSource')
 assert.ok(connect)
 // 来源实例已存在，继任加载上不再另开一个。
 assert.equal(nodes(view).some(node=>text(node)==='market.industry.saved.registerDataSource'),false)
})

const [preview,frame,marketPage]=await Promise.all([
 readFile(new URL('../src/client/IndustryUpdatePreview.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8'),
])

test('更新预览挂在持久化加载目录上：按身份认领基线与已保存方案，不再靠内容摘要或空间 scope 猜',()=>{
 // 工作台传的是同一份真实加载目录，比较所需的岗位事实来自持久化的岗位实例。
 assert.match(frame,/industryReview=\{\{loads:savedIndustryLoads,upgrade:upgradeIndustryLoad,rolesReady:industryRoleDirectory==='ready',rolesFailed:industryRoleDirectory==='failed',refreshRoles:\(\)=>\{void loadIndustryRoles\(\)\.catch\(\(\)=>\{\}\)\},context:\{industryRoles,/)
 assert.doesNotMatch(frame,/context:\{loads:tasks\.industryLoads/)
 assert.match(marketPage,/<IndustryUpdatePreview item=\{item\} items=\{props\.state\.items\} spaces=\{props\.spaces\} \{\.\.\.props\.industryReview\}\/>/)
 // 工作台选择器与比较入口都用加载记录本身。
 assert.match(preview,/const loads=records\.filter\(load=>load\.templateId===manifest\.id&&load\.domain===manifest\.domain/)
 assert.match(preview,/const selected=loads\.find\(row=>row\.id===loadId\)/)
 assert.match(preview,/compareIndustryUpdate\(context,selected,baseline,candidate\)/)
 assert.match(preview,/record=\{selected!\}/)
 // 两条认领启发式已删除：既不按内容摘要配基线，也不按空间 scope 配继任加载。
 assert.doesNotMatch(preview,/context\.loads/)
 assert.doesNotMatch(preview,/row\.contentHash===selected\.sourceHash/)
 assert.doesNotMatch(preview,/space\.scope===selected\.spaceId/)
 // 已保存方案只按"选中的就是这份候选内容的继任加载"读回，且与比较入口一样用严格相等，不做大小写归一。
 assert.match(preview,/const saved=selected\?\.upgrade&&candidate\?\.contentStorage\?\.contentId===selected\.contentId\?selected\.upgrade:undefined/)
 assert.doesNotMatch(preview,/toLowerCase/)
 // 岗位事实就绪前不给本地修改与提交入口。
 assert.match(preview,/\{!rolesReady\?\(rolesFailed$/m)
 assert.match(preview,/\?<p role="alert">\{t\('market\.industry\.updatePreview\.rolesFailed'\)\}<button type="button" onClick=\{refreshRoles\}>\{t\('market\.industry\.updatePreview\.rolesRetry'\)\}<\/button><\/p>$/m)
 assert.match(preview,/:<p role="status">\{t\('market\.industry\.updatePreview\.rolesPending'\)\}<\/p>\):<>/)
 assert.match(frame,/rolesReady:industryRoleDirectory==='ready'/)
 // 读取失败要有出口：不再永久停在「正在读取岗位现状」。
 assert.match(frame,/rolesFailed:industryRoleDirectory==='failed'/)
 // 四类实例的合并一律按 revision 回退保护：更低的修订丢弃，等值仍允许覆盖（漂移投影不改修订）。
 for(const name of ['DataSources','ExecutionTools','McpConnections','Plugins'])
  assert.match(frame,new RegExp('const mergeIndustry'+name+'=[^\\n]*if\\(index>=0&&next\\[index\\]!\\.revision>row\\.revision\\)continue;'),name)
 assert.doesNotMatch(frame,/revision>=row\.revision/)
 assert.match(frame,/if\(\['market','spaces','team','capabilities'\]\.includes\(state\.view\)\)void loadIndustryRoles\(\)/)
})
