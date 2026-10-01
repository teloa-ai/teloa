import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {createConnectorProbeApi} from '../src/client/connector-probe-api.ts'
import {CONNECTOR_MESSAGE_ROWS} from '../src/client/i18n/locales/connectors.ts'

test('探针回包形状不符即抛，不把失败原因当成功渲染',async()=>{
 const api=createConnectorProbeApi(async()=>({kind:'data-source',instanceId:'x',probedAt:'坏时刻',ok:true}))
 await assert.rejects(api.probe({kind:'data-source',instanceId:'11111111-1111-4111-8111-111111111111'}))
})

test('探针失败回包 reason 混入 C0 控制字符（垂直换行 \\x0b）即抛，禁 C0/DEL 控制字符',async()=>{
 const instanceId='11111111-1111-4111-8111-111111111111',probedAt='2026-09-14T00:00:00.000Z'
 const api=createConnectorProbeApi(async()=>({kind:'mcp',instanceId,probedAt,ok:false,reason:'第一行\x0b第二行'}))
 await assert.rejects(api.probe({kind:'mcp',instanceId}))
})

test('探针成功回包原样透出，字段之外没有多余键',async()=>{
 const instanceId='11111111-1111-4111-8111-111111111111',probedAt='2026-09-14T00:00:00.000Z'
 const api=createConnectorProbeApi(async(method,payload)=>{
  assert.equal(method,'connectors/probe')
  assert.deepEqual(payload,{kind:'mcp',instanceId})
  return {kind:'mcp',instanceId,probedAt,ok:false,reason:'MCP 服务当前没有登记这些工具。'}
 })
 assert.deepEqual(await api.probe({kind:'mcp',instanceId}),{kind:'mcp',instanceId,probedAt,ok:false,reason:'MCP 服务当前没有登记这些工具。'})
})

/**
 * 行业目录组件只依赖 React 的三个钩子与 i18n，直接在测试内转译执行即可核对真实文案与真实按钮；
 * 与 industry-source-drift.test.ts 同样的取巧：子组件（IndustryResourceBrowser 等）不展开，
 * 只核对传给它们的 props（status/render），需要时手动调用 render(item) 拿到那一行的真实子树。
 */
type Node={type:unknown;props:Record<string,any>;children:Node[]}
const connectorDict=new Map(CONNECTOR_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
const stamp='2026-09-14T00:00:00.000Z'
const loadId='22345678-1234-4234-8234-123456789012',contentId='42345678-1234-4234-8234-123456789012'
const dsItemId='32345678-1234-4234-8234-123456789012',mcpItemId='72345678-1234-4234-8234-123456789012',toolItemId='82345678-1234-4234-8234-123456789012'
const dsInstanceId='92345678-1234-4234-8234-123456789012',mcpInstanceId='a2345678-1234-4234-8234-123456789012',toolInstanceId='b2345678-1234-4234-8234-123456789012'

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
 // 只有 connector.* 走真词典（要核对真实"连接器"文案），其余键回原样，够不上翻译真实性的都不必较真。
 const t=(key:string,params?:Record<string,unknown>)=>{
  const template=connectorDict.get(key)
  if(template===undefined)return key
  return params?template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,(_,name)=>String((params as Record<string,unknown>)[name]??'')):template
 }
 const exports:Record<string,any>={}
 const require=(id:string)=>id==='react'?React:id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t,dateTime:(value:string)=>value})}:id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>String(value)}:new Proxy({default:new Proxy({},{get:(_,key)=>String(key)})},{get:(target,key)=>key==='default'?(target as Record<string,unknown>).default:()=>'none'})
 new Function('require','exports','React',js)(require,exports,React)
 return exports.SavedIndustryDirectory(props) as Node
}
const nodes=(root:Node):Node[]=>root&&typeof root==='object'?[root,...root.children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]:[]
const text=(node:Node):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''

const load={
 id:loadId,ownerId:'local:teloa-owner',contentId,contentHash:'a'.repeat(64),templateId:'security',templateVersion:'1.0.0',templateTitle:'安全模板',domain:'SOC',description:'安全工作资源',targetVersion:1,
 space:{id:contentId,name:'安全运营',version:1,scope:'space-'+loadId},
 items:[
  {localId:'alerts',instanceId:dsItemId,kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,status:'pending-adapter' as const},
  {localId:'mcp-conn',instanceId:mcpItemId,kind:'mcp' as const,title:'MCP 连接',version:'1.0.0',required:true,status:'pending-adapter' as const},
  {localId:'tool',instanceId:toolItemId,kind:'execution-tool' as const,title:'执行工具',version:'1.0.0',required:true,status:'pending-adapter' as const},
 ],
 relations:[],entrypoints:[],createdAt:stamp,
}
const base={ownerId:'local:teloa-owner',loadId,contentId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+loadId,createdAt:stamp,updatedAt:stamp}
const dsInstance={...base,id:dsInstanceId,itemInstanceId:dsItemId,itemLocalId:'alerts',state:'needs_authorization',revision:1,binding:null}
const mcpInstance={...base,id:mcpInstanceId,itemInstanceId:mcpItemId,itemLocalId:'mcp-conn',state:'needs_connection',revision:1,binding:null}
const toolInstance={...base,id:toolInstanceId,itemInstanceId:toolItemId,itemLocalId:'tool',state:'needs_authorization',revision:1,binding:null}

const empty={items:[],error:undefined,partial:false,refresh:async()=>{},pending:undefined,recoveryError:undefined,instantiate:async()=>{throw Error()},recover:async()=>{throw Error()}}
function directory(probe?:(input:unknown)=>Promise<unknown>){
 return render({
  loads:[load],error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},
  knowledge:{...empty},
  dataSources:{...empty,items:[dsInstance],authorize:async()=>{throw Error()}},
  executionTools:{...empty,items:[toolInstance],authorize:async()=>{throw Error()}},
  mcpConnections:{...empty,items:[mcpInstance],connect:async()=>{throw Error()}},
  plugins:{...empty,install:async()=>{throw Error()},reconcile:async()=>{throw Error()}},
  roles:{...empty,open:async()=>{}},
  tasks:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{}},
  plans:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{},openRole:async()=>{}},
  unload:{pending:false,recoveryError:undefined,run:async()=>{},recover:async()=>{}},
  skillInstallApi:{},
  ...(probe?{connectors:{probe}}:{}),
 })
}

test('已保存行业目录里三类连接统称连接器，每条都有一个测试连接按钮',()=>{
 const view=directory(async()=>({ok:true}))
 const browser=nodes(view).find(node=>typeof node.props.status==='function'&&typeof node.props.render==='function')
 assert.ok(browser,'必须能找到承载连接器行的资源浏览器')
 const rows=load.items.map(item=>browser!.props.render(item) as Node)
 const probeButtons=rows.flatMap(row=>nodes(row)).filter(node=>node.type==='button'&&node.props['data-connector-probe'])
 assert.equal(probeButtons.length,3)
 assert.deepEqual(new Set(probeButtons.map(node=>node.props['data-connector-probe'])),new Set(['data-source','mcp','execution-tool']))
 const wholeText=[text(view),...rows.map(text)].join('')
 // 与市场标签一致，三类统称「连接」：分类按钮与每一行的类型名都用它，不再说「连接器」。
 assert.ok(nodes(view).some(node=>node.type==='button'&&text(node).startsWith('market.presentation.category.connector ')),'「连接」分组必须出现在界面上')
 assert.deepEqual([...new Set(load.items.map(item=>(browser!.props.kindLabel as (kind:string)=>string)(item.kind)))],['market.presentation.category.connector'])
 assert.ok(!wholeText.includes('连接器'),'不再出现「连接器」')
 assert.ok(!wholeText.includes('数据面')&&!wholeText.includes('执行面'),'内部落点名不得出现在界面上')
})

test('未接线测试连接端口时目录照常渲染，只是没有测试连接入口',()=>{
 const view=directory()
 const browser=nodes(view).find(node=>typeof node.props.status==='function'&&typeof node.props.render==='function')
 assert.ok(browser)
 const rows=load.items.map(item=>browser!.props.render(item) as Node)
 const probeButtons=rows.flatMap(row=>nodes(row)).filter(node=>node.type==='button'&&node.props['data-connector-probe'])
 assert.equal(probeButtons.length,0)
})

/**
 * 2026-09-16 隔离宿主验收实测：上面两条组件用例只证明"给了 connectors 就有按钮"，
 * 而真装配处从来没给过——`createConnectorProbeApi` 全仓零调用方，「测试连接」在真 UI 上不存在。
 * 这条用例按源码文本钉住那条接线：装配处要造探针 api，框架要把它传给已保存行业目录。
 */
test('测试连接在真装配里有入口：index 造探针 api，WorkbenchFrame 传给已保存行业目录',()=>{
 const index=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(index,/createConnectorProbeApi\(call\)/,'装配处必须真造一个探针 api')
 assert.match(index,/connectorProbeApi,/,'探针 api 必须进 inject 表，否则框架拿不到')
 assert.match(frame,/connectors=\{\{probe:connectorProbeApi\.probe\}\}/,'框架必须把探针传给 SavedIndustryDirectory')
})
