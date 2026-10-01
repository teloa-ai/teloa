import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {createIndustryDataSourceApi} from '../src/client/industry-data-source-api.ts'
import {createIndustryPluginApi} from '../src/client/industry-plugin-api.ts'

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
const contentId='42345678-1234-4234-8234-123456789012',broken='52345678-1234-4234-8234-123456789012',installationId='62345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const base={id,ownerId:'local:teloa-owner',loadId,itemInstanceId,itemLocalId:'alerts',contentId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+loadId,createdAt:stamp,updatedAt:stamp}
const drifted={...base,state:'needs_authorization' as const,revision:2,binding:{sourceId:'security-alert-http',scopes:['SOC'],definitionHash:'b'.repeat(64),probedAt:stamp},drift:true as const}
const definition={format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'@teloa/threat-intel-plugin',version:'1.2.0'}
const driftedPlugin={...base,definition,definitionHash:'b'.repeat(64),installationId,state:'needs_install' as const,revision:2,drift:true as const}

test('行业实例目录接受漂移投影与逐行失败项，拒绝伪造的 drift 与错误码',async()=>{
 const page={items:[drifted],errors:[{instanceId:broken,code:'teloa/storage-corrupt' as const}]}
 assert.deepEqual(await createIndustryDataSourceApi(async()=>page).list(),page)
 assert.deepEqual(await createIndustryDataSourceApi(async()=>drifted).get(id),drifted)
 const pluginPage={items:[driftedPlugin],errors:[{instanceId:broken,code:'teloa/source-unavailable' as const}]}
 assert.deepEqual(await createIndustryPluginApi(async()=>pluginPage).list(),pluginPage)
 const bad=[
  {items:[{...drifted,drift:false}]},
  {items:[{...drifted,state:'active'}]},
  {items:[{...base,state:'needs_authorization',revision:1,binding:null,drift:true}]},
  {items:[drifted],errors:[{instanceId:broken,code:'teloa/forbidden'}]},
  {items:[drifted],errors:[{instanceId:'not-a-uuid',code:'teloa/storage-corrupt'}]},
  {items:[drifted],errors:[{instanceId:broken}]},
  {items:[drifted],errors:[]},
  // 失败项不得重复，也不得与已返回的实例身份重合——否则界面会同时把一条实例既当好又当坏。
  {items:[drifted],errors:[{instanceId:broken,code:'teloa/storage-corrupt'},{instanceId:broken,code:'teloa/source-unavailable'}]},
  {items:[drifted],errors:[{instanceId:id,code:'teloa/storage-corrupt'}]},
 ]
 for(const value of bad)await assert.rejects(createIndustryDataSourceApi(async()=>value).list(),/格式不正确/)
 // 漂移的插件行必须保持 revision 与安装身份的耦合：后端不可能产出「带安装身份却只有 1 版」。
 for(const value of [{items:[{...driftedPlugin,revision:1}]},{items:[{...driftedPlugin,installationId:null}]},{items:[{...driftedPlugin,installationId:'not-a-uuid'}]}])await assert.rejects(createIndustryPluginApi(async()=>value).list(),/格式不正确/)
 assert.deepEqual((await createIndustryPluginApi(async()=>({items:[{...driftedPlugin,installationId:null,revision:1}]})).list()).items,[{...driftedPlugin,installationId:null,revision:1}])
})

/** 行业目录组件只依赖 React 的三个钩子与 i18n，直接在测试内转译执行即可核对真实文案与真实按钮。 */
function render(props:Record<string,unknown>){
 const source=readFileSync(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:Node[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useEffect:()=>{},
 }
 const exports:Record<string,any>={}
 const require=(id:string)=>id==='react'?React:id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key,dateTime:(value:string)=>value})}:id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>String(value)}:new Proxy({default:new Proxy({},{get:(_,key)=>String(key)})},{get:(target,key)=>key==='default'?(target as Record<string,unknown>).default:()=>'none'})
 new Function('require','exports','React',js)(require,exports,React)
 return exports.SavedIndustryDirectory(props) as Node
}
const nodes=(root:Node):Node[]=>root&&typeof root==='object'?[root,...root.children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]:[]
const text=(node:Node):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''

const load={id:loadId,ownerId:'local:teloa-owner',contentId,contentHash:'a'.repeat(64),templateId:'security',templateVersion:'1.0.0',templateTitle:'安全模板',domain:'SOC',description:'安全工作资源',targetVersion:1,space:{id:contentId,name:'安全运营',version:1,scope:'space-'+loadId},items:[{localId:'alerts',instanceId:itemInstanceId,kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,status:'pending-adapter' as const}],relations:[],entrypoints:[],createdAt:stamp}
const directory=(dataSource:unknown,partial:boolean)=>{
 const empty={items:[],error:undefined,partial:false,refresh:async()=>{},pending:undefined,recoveryError:undefined,instantiate:async()=>{throw Error()},recover:async()=>{throw Error()}}
 return render({
  loads:[load],error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},
  knowledge:{...empty},
  dataSources:{...empty,items:[dataSource],partial,authorize:async()=>{throw Error()}},
  executionTools:{...empty,authorize:async()=>{throw Error()}},
  mcpConnections:{...empty,connect:async()=>{throw Error()}},
  plugins:{...empty,install:async()=>{throw Error()},reconcile:async()=>{throw Error()}},
  roles:{...empty,open:async()=>{}},
  tasks:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{}},
  plans:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{},openRole:async()=>{}},
  unload:{pending:false,recoveryError:undefined,run:async()=>{},recover:async()=>{}},
  skillInstallApi:{},
 })
}

test('目录把漂移实例标注为需重新核验，并在部分读取失败时各提示一次',()=>{
 const view=directory(drifted,true)
 const browser=nodes(view).find(node=>typeof node.props.status==='function')
 assert.ok(browser)
 const item={...load.items[0],id:itemInstanceId}
 assert.equal(browser.props.status(item),'market.industry.saved.status.drift')
 // 漂移实例投影为初始态，因此初始态的动作按钮（连接并核验）照常出现。
 const actions=nodes(browser.props.render(item)).filter(node=>node.type==='button').map(text)
 assert.ok(actions.includes('market.industry.saved.connectDataSource'))
 const alerts=nodes(view).filter(node=>node.props.role==='alert').map(text)
 assert.equal(alerts.filter(value=>value.includes('market.industry.saved.listPartial')).length,1)
 // 未漂移的同一条记录仍按状态显示「已登记·待连接」，目录完整时也不出现部分失败提示。
 const {drift,...steady}=drifted
 const plain=directory({...steady,revision:1,binding:null},false)
 const plainBrowser=nodes(plain).find(node=>typeof node.props.status==='function')
 assert.ok(plainBrowser)
 assert.equal(plainBrowser.props.status(item),'market.industry.saved.status.dataSourceRegistered')
 assert.equal(nodes(plain).filter(node=>node.props.role==='alert').map(text).filter(value=>value.includes('market.industry.saved.listPartial')).length,0)
})
