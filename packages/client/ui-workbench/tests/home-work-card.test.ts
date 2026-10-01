import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {readHomeWorkStatus,changeHomeWorkStatus} from '../src/client/home-work-status.ts'
const nodes=(node:any):any[]=>node&&typeof node==='object'&&node.props?[node,...node.children.flatMap(nodes)]:[]
const text=(node:any):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''
function statusCard(){
 const source=readFileSync(new URL('../src/client/HomeWorkRequestCard.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const react={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),useState:(initial:any)=>[initial,()=>{}],useEffect:()=>{}}
 const modules:any={react,'./home-work-status.js':{readHomeWorkStatus,changeHomeWorkStatus},'./business-scope-context.js':{useBusinessScopes:()=>({SOC:'安全运营'})},'./i18n/provider.js':{useI18n:()=>({locale:'zh-CN'})},'./i18n/errors.js':{localizeWorkError:(_:any,error:Error)=>error.message}}
 const exports:any={};new Function('require','exports','React',js)((id:string)=>modules[id]??{default:{}},exports,react)
 return exports.HomeWorkStatusCard as (props:any)=>any
}

test('真实工具进度卡打开回包任务、显示部分失败，并把停止交给原请求',async()=>{
 const initial=readHomeWorkStatus({sessionId:'source',requestId:'same',title:'分工核查',scope:'SOC',stoppedAt:null,members:[{roleId:'a',name:'同事甲',scope:'SOC',status:'received',task:{id:'actual-task',title:'真实任务'},result:'已核查完毕'},{roleId:'b',name:'同事乙',scope:'SOC',status:'waiting'},{roleId:'c',name:'同事丙',scope:'SOC',status:'failed',reason:'配置尚未就绪'}]},'source')
 const opened:string[]=[],calls:any[]=[],changed:any[]=[]
 const view=statusCard()({initial,onChange:(row:any)=>changed.push(row),openTask:(id:string)=>opened.push(id),call:async(endpoint:string,payload:any)=>{calls.push([endpoint,payload]);return initial}})
 assert.match(text(view),/同事甲.*已收到/);assert.match(text(view),/同事乙.*等待中/);assert.match(text(view),/同事丙.*未完成/);assert.match(text(view),/已核查完毕/)
 assert.match(text(view),/安全运营/);assert.doesNotMatch(text(view),/SOC/)
 const button=(label:string)=>nodes(view).find(node=>node.type==='button'&&text(node)===label)
 button('真实任务').props.onClick();assert.deepEqual(opened,['actual-task'])
 button('停止剩余工作').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(calls,[['work-requests/stop',{sessionId:'source',requestId:'same'}]])
 assert.deepEqual(changed,[initial])
})
test('确定未启动的岗位变化隐藏原请求重试，保留打开原任务入口；其他失败仍可重试',()=>{
 const render=statusCard(),opened:string[]=[],calls:string[]=[]
 const base={sessionId:'source',requestId:'same',title:'原任务',scope:'SOC',stoppedAt:null}
 const terminal=readHomeWorkStatus({...base,members:[{roleId:'a',name:'调查员',scope:'SOC',status:'failed',reason:'Role changed',task:{id:'original-task',title:'原任务'},run:{id:'original-run',state:'prepared'}}]},'source')
 const props={initial:terminal,openTask:(id:string)=>opened.push(id),call:async(endpoint:string)=>{calls.push(endpoint);return terminal}}
 const view=render(props)
 assert.match(text(view),/查看原任务.*重新安排/)
 assert.equal(nodes(view).some(node=>node.type==='button'&&text(node)==='重试未完成的工作'),false)
 const task=nodes(view).find(node=>node.type==='button'&&text(node)==='原任务')
 assert.ok(task);task.props.onClick();assert.deepEqual(opened,['original-task']);assert.deepEqual(calls,[])

 const retryable=readHomeWorkStatus({...base,members:[{roleId:'a',name:'调查员',scope:'SOC',status:'failed',reason:'配置未就绪',task:{id:'original-task',title:'原任务'},run:{id:'original-run',state:'configuration_failed'}}]},'source')
 assert.ok(nodes(render({...props,initial:retryable})).some(node=>node.type==='button'&&text(node)==='重试未完成的工作'))
 const unknown=readHomeWorkStatus({...base,members:[{roleId:'a',name:'调查员',scope:'SOC',status:'waiting',reason:'发送状态未知',task:{id:'original-task',title:'原任务'},run:{id:'original-run',state:'prepared'}}]},'source')
 assert.equal(nodes(render({...props,initial:unknown})).some(node=>node.type==='button'&&text(node)==='重试未完成的工作'),false)
})

test('交办进度同时接官方常驻input dock，不依赖工具步骤展开',()=>{
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
 assert.match(source,/name:'conversation.input.dock',id:'teloa-work-requests'/)
 assert.match(source,/HomeWorkRequestsDock/)
})


test('交办、全员重新汇报、状态、停止、续办五种原生工具都注册同一进度卡',()=>{
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
 assert.match(source,/for\(const key of \['teloa_work_dispatch','teloa_work_collect_reports','teloa_work_status','teloa_work_stop','teloa_work_resume'\]\)[^\n]+HomeWorkRequestCard/)
})
