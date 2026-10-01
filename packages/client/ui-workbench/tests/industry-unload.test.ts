import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const loadId='12345678-1234-4234-8234-123456789012',spaceId='22345678-1234-4234-8234-123456789012',itemId='32345678-1234-4234-8234-123456789012'
const occurrenceId='42345678-1234-4234-8234-123456789012',runId='52345678-1234-4234-8234-123456789012',mappingHash='b'.repeat(64)
const load={id:loadId,ownerId:'local:teloa-owner',contentId:spaceId,contentHash:'a'.repeat(64),templateId:'security',templateVersion:'1.0.0',templateTitle:'安全模板',domain:'SOC',description:'安全工作资源',targetVersion:1,
 space:{id:spaceId,name:'安全运营',version:1,scope:'space-'+spaceId},
 items:[{localId:'alerts',instanceId:itemId,kind:'data-source',title:'告警源',version:'1.0.0',required:true,status:'pending-adapter'}],
 relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash,status:'active'}

/**
 * 行业目录组件只依赖 React 的三个钩子与 i18n，直接在测试内转译执行即可核对真实按钮与真实文案。
 * 与漂移用例的渲染器不同的是：这里的 useState 跨多次渲染保留，以便核对"点击 → 确认 → 阻塞项"的真实序列。
 */
function mount(props:Record<string,unknown>){
 const source=readFileSync(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:Node[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useEffect:()=>{},
 }
 const exports:Record<string,any>={}
 // 阻塞项读取本身由 industry-load-api 的用例覆盖，这里只注入真实形状以核对界面如何呈现。
 const readBlockers=(reason:unknown):unknown[]=>{
  const details=reason&&typeof reason==='object'&&'details' in reason?(reason as {details?:{blockers?:unknown[]}}).details:undefined
  return Array.isArray(details?.blockers)?details.blockers:[]
 }
 const require=(id:string)=>id==='react'?React:id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key,dateTime:(value:string)=>value})}:id.endsWith('errors.js')?{localizeWorkError:(_:string,value:unknown)=>String(value)}:id.endsWith('industry-load-api.js')?{readUnloadBlockers:readBlockers}:new Proxy({default:new Proxy({},{get:(_,key)=>String(key)})},{get:(_,key)=>key==='default'?new Proxy({},{get:(_inner,name)=>String(name)}):()=>'none'})
 new Function('require','exports','React',js)(require,exports,React)
 return ()=>{cursor=0;return exports.SavedIndustryDirectory(props) as Node}
}
const nodes=(root:Node):Node[]=>root&&typeof root==='object'?[root,...root.children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]:[]
const text=(node:Node):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''
const buttons=(view:Node,label:string)=>nodes(view).filter(node=>node.type==='button'&&text(node)===label)
const empty={items:[],error:undefined,partial:false,refresh:async()=>{},pending:undefined,recoveryError:undefined,instantiate:async()=>{throw Error()},recover:async()=>{throw Error()}}
const props=(rows:unknown[],unload:Record<string,unknown>)=>({
 loads:rows,error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},
 knowledge:{...empty},
 dataSources:{...empty,authorize:async()=>{throw Error()}},
 executionTools:{...empty,authorize:async()=>{throw Error()}},
 mcpConnections:{...empty,connect:async()=>{throw Error()}},
 plugins:{...empty,install:async()=>{throw Error()},reconcile:async()=>{throw Error()}},
 roles:{...empty,open:async()=>{}},
 tasks:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{}},
 plans:{api:{},pending:false,recoveryError:undefined,create:async()=>{},recover:async()=>{},openRole:async()=>{}},
 unload,
 skillInstallApi:{},
})

test('卸载入口先确认再提交，只带请求身份、加载与映射指纹',async()=>{
 const calls:unknown[]=[]
 const render=mount(props([load],{pending:false,recoveryError:undefined,recover:async()=>{},run:async(input:unknown)=>{calls.push(input)}}))
 const initial=render()
 assert.equal(buttons(initial,'market.industry.saved.unload').length,1)
 assert.ok(!nodes(initial).some(node=>text(node).includes('market.industry.saved.unloadConfirm')))
 buttons(initial,'market.industry.saved.unload')[0]!.props.onClick()
 const confirming=render()
 assert.ok(nodes(confirming).some(node=>text(node).includes('market.industry.saved.unloadConfirm')))
 assert.equal(buttons(confirming,'market.industry.saved.unloadCancel').length,1)
 buttons(confirming,'market.industry.saved.unload')[1]!.props.onClick()
 await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(calls.length,1)
 const submitted=calls[0] as Record<string,unknown>
 assert.deepEqual(Object.keys(submitted).sort(),['expectedMappingHash','loadId','requestId'])
 assert.equal(submitted.loadId,loadId);assert.equal(submitted.expectedMappingHash,mappingHash)
 assert.match(String(submitted.requestId),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
 assert.ok(!nodes(render()).some(node=>text(node).includes('market.industry.saved.unloadConfirm')))
})

test('卸载被在途执行阻断时提示原因并逐条列出阻塞项',async()=>{
 const blockers=[{kind:'plan-occurrence',id:occurrenceId},{kind:'task-run',id:runId}]
 const render=mount(props([load],{pending:false,recoveryError:undefined,recover:async()=>{},run:async()=>{throw Object.assign(Error('阻塞'),{rejected:true,code:'teloa/conflict',details:{blockers}})}}))
 buttons(render(),'market.industry.saved.unload')[0]!.props.onClick()
 buttons(render(),'market.industry.saved.unload')[1]!.props.onClick()
 await new Promise(resolve=>setTimeout(resolve,0))
 const blocked=render(),alert=nodes(blocked).find(node=>node.props.role==='alert'&&text(node).includes('market.industry.saved.unloadBlocked'))
 assert.ok(alert)
 // 主区按类型报数量，不念编号；编号只在默认收起的技术详情里。
 const tech=nodes(alert).find(node=>node.type==='details')!
 assert.ok(tech&&!tech.props.open)
 const inTech=new Set(nodes(tech))
 const listed=nodes(alert).filter(node=>node.type==='li'&&!inTech.has(node)).map(text)
 assert.deepEqual(listed,['market.industry.saved.blocker.planOccurrence · market.industry.saved.blocker.count','market.industry.saved.blocker.taskRun · market.industry.saved.blocker.count'])
 assert.ok(!listed.some(value=>value.includes(occurrenceId)||value.includes(runId)))
 assert.deepEqual(nodes(tech).filter(node=>node.type==='li').map(text),['market.industry.saved.blocker.planOccurrence · market.industry.saved.load.numbering '+occurrenceId,'market.industry.saved.blocker.taskRun · market.industry.saved.load.numbering '+runId])
 assert.ok(nodes(blocked).some(node=>text(node).includes('market.industry.saved.unloadConfirm')))
})

test('已卸载的加载只显示保留本地对象的徽标，不再提供卸载入口',()=>{
 const render=mount(props([{...load,status:'unloaded',unloadedAt:'2026-09-13T00:00:00.000Z'}],{pending:false,recoveryError:undefined,recover:async()=>{},run:async()=>{}}))
 const view=render()
 assert.equal(buttons(view,'market.industry.saved.unload').length,0)
 assert.ok(nodes(view).some(node=>node.props.role==='status'&&text(node)==='market.industry.saved.status.unloaded'))
})
