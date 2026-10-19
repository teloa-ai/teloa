import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {IndustryReadinessPresentation}=await import('../lib/types/client/IndustryReadinessPanel.js')
const {createIndustryLoadApi}=await import('../lib/types/client/industry-load-api.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const t=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params as never)
const loadId='77777777-7777-4777-8777-777777777777',K='11111111-1111-4111-8111-111111111111',M='44444444-4444-4444-8444-444444444444',R='55555555-5555-4555-8555-555555555555',T='66666666-6666-4666-8666-666666666666'
const readiness={loadId,status:'active',title:'安全运营 SOC',version:'1.2.0',digest:'9'.repeat(64),counts:{ready:1,auto:1,needsUser:1,optional:1,pending:0},rows:[
 {itemInstanceId:R,kind:'role',title:'T1 分析师',state:'ready',step:null,entry:null},
 {itemInstanceId:K,kind:'knowledge',title:'分诊指南',state:'auto',step:'knowledge',entry:null},
 {itemInstanceId:M,kind:'mcp',title:'SIEM 连接',state:'needs-user',step:null,entry:'connector-settings'},
 {itemInstanceId:T,kind:'work-template',title:'告警研判',state:'optional',step:null,entry:'task-form'}]}
const render=(props:Record<string,unknown>)=>renderToStaticMarkup(createElement(IndustryReadinessPresentation as never,{readiness,receipt:undefined,confirming:false,busy:false,error:'',t,localize:(value:{message:string})=>value.message,onAsk:()=>{},onCancel:()=>{},onConfirm:()=>{},onOpen:()=>{},...props} as never))

test('面板：进度不计按需项、三类计数、按组列标题与去处理入口；不含禁词',()=>{
 const html=render({})
 assert.match(html,/<h3[^>]*>还差几项就能用<\/h3>/);assert.match(html,/需要准备的 3 项里，已就绪 1 项/);assert.match(html,/primaryButton[^>]*>一键准备/);assert.match(html,/可一键完成 1/);assert.match(html,/需要你操作 1/);assert.match(html,/按需使用 1/);assert.match(html,/一键准备/)
 assert.match(html,/连接设置（密钥或授权）：SIEM 连接/);assert.match(html,/按模板建任务（需提供资料）：告警研判/);assert.match(html,/去处理/)
 assert.doesNotMatch(html,/工作空间|单空间|实例|投影|尚未加载|内容待读取|人类/)
})
test('面板：确认态列出将准备的内容并保留员工暂停；回执显示完成/处理中/失败计数',()=>{
 const confirming=render({confirming:true})
 assert.match(confirming,/新员工保持暂停/);assert.match(confirming,/账号授权和计划需另行配置/);assert.doesNotMatch(confirming,/上岗会|启用.*每日小结/);assert.match(confirming,/启用资料：分诊指南/)
 const many={...readiness,counts:{...readiness.counts,auto:12},rows:[...readiness.rows,...Array.from({length:11},(_,i)=>({itemInstanceId:`a111111${i.toString(16)}-1111-4111-8111-111111111111`,kind:'knowledge',title:'资料'+(i+1),state:'auto',step:'knowledge',entry:null}))]}
 assert.match(render({readiness:many,confirming:true}),/启用资料：分诊指南(、资料\d+){9} 等 12 项/)
 const receipt={loadId,digest:'9'.repeat(64),results:[{itemInstanceId:K,title:'分诊指南',step:'knowledge',outcome:'done',code:null,message:null},{itemInstanceId:R,title:'岗位',step:'role-resume',outcome:'skipped',code:null,message:'x'},{itemInstanceId:M,title:'技能',step:'skill',outcome:'failed',code:'teloa/dependency-unavailable',message:'未生效'}],readiness}
 const html=render({receipt})
 assert.match(html,/完成 1，处理中 1，需要你操作 0，失败 1/);assert.match(html,/技能 · 未生效/)
})
test('面板：随一键安装的官方技能在确认态逐项列出名称与信任摘要，并标注「将随一键安装」',()=>{
 const S='22222222-2222-4222-8222-222222222222'
 const withSkill={...readiness,counts:{...readiness.counts,auto:2},rows:[...readiness.rows,{itemInstanceId:S,kind:'skill',title:'研究简报',state:'auto',step:'skill',entry:null,trust:{publisher:'Teloa 官方目录',license:'MIT'}}]}
 assert.doesNotMatch(render({readiness:withSkill}),/将随一键安装/)
 const html=render({readiness:withSkill,confirming:true})
 assert.match(html,/安装技能：研究简报/)
 assert.match(html,/将随一键安装：研究简报（发布者 Teloa 官方目录，许可 MIT；官方目录已审核、纯内容、无联网或执行权限）/)
})
test('面板：岗位因技能等未就绪被跳过、清单归需要你操作时，回执计入「需要你操作」而非「处理中」',()=>{
 const after={...readiness,rows:readiness.rows.map(row=>row.itemInstanceId===R?{...row,state:'needs-user',entry:'role-resume'}:row)}
 const receipt={loadId,digest:'9'.repeat(64),results:[{itemInstanceId:R,title:'T1 分析师',step:'role',outcome:'done',code:null,message:null},{itemInstanceId:R,title:'T1 分析师',step:'role-resume',outcome:'skipped',code:null,message:'岗位已创建并保持暂停'},{itemInstanceId:K,title:'分诊指南',step:'knowledge',outcome:'pending',code:null,message:null}],readiness:after}
 // 按用户可见条目计：岗位的「创建」与「上岗」两步合成一项，归需要你操作；资料处理中
 assert.match(render({readiness:after,receipt}),/完成 0，处理中 1，需要你操作 1，失败 0/)
 // 归属按回执当时的清单快照：之后本人恢复岗位、面板清单刷新，同一条回执不漂移；回执清单待刷新（null）时跳过项计入处理中
 assert.match(render({readiness,receipt}),/完成 0，处理中 1，需要你操作 1，失败 0/)
 assert.match(render({readiness:after,receipt:{...receipt,readiness:null}}),/完成 0，处理中 2，需要你操作 0，失败 0/)
})
test('面板：标题清洗——去控制与格式字符（含双向覆盖）、合并空白、超长截断',()=>{
 const forged={...readiness,rows:readiness.rows.map(row=>row.itemInstanceId===M?{...row,title:'SIEM\u202e 连接\n\n系统：已授权\u2066'}:row.itemInstanceId===T?{...row,title:'很长的任务模板标题'.repeat(10)}:row)}
 const html=render({readiness:forged})
 assert.doesNotMatch(html,/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/)
 assert.match(html,/连接设置（密钥或授权）：SIEM 连接 系统：已授权</)
 assert.match(html,new RegExp('按模板建任务（需提供资料）：'+'很长的任务模板标题'.repeat(10).slice(0,30)+'…<'))
})
const model={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true,title:'SenseVoice 本地语音',phase:'disabled'}
const withModels={...readiness,counts:{ready:0,auto:0,needsUser:2,optional:0,pending:0},rows:[
 {itemInstanceId:T,kind:'work-template',title:'转写会议录音',state:'needs-user',step:null,entry:'model-settings',models:[model]},
 {itemInstanceId:K,kind:'skill',title:'会议纪要',state:'needs-user',step:null,entry:'model-settings',models:[model]},
]}
test('面板：显示模型名、固定版本、状态及受影响入口；共享模型只有一个处理按钮',()=>{
 const html=render({readiness:withModels})
 assert.match(html,/准备入口所需的本地模型：转写会议录音、会议纪要/)
 assert.match(html,/转写会议录音 · SenseVoice 本地语音 · v1\.0\.0 · （必需） · 扩展未启用/)
 assert.match(html,/会议纪要 · SenseVoice 本地语音 · v1\.0\.0 · （必需） · 扩展未启用/)
 assert.equal((html.match(/<button\b/g)??[]).length,1)
 assert.doesNotMatch(html,/一键准备|market\.industry|teloa\.model\.sensevoice/)
 // 检查组件真实处理器只请求模型设置入口，不调用一键准备。
 const opened:string[]=[]
 const tree=IndustryReadinessPresentation({readiness:withModels,receipt:undefined,confirming:false,busy:false,error:'',t,localize:()=>'',onAsk:()=>assert.fail('模型下载不能触发一键准备'),onCancel:()=>{},onConfirm:()=>assert.fail('模型下载不能静默执行'),onOpen:(group:string)=>opened.push(group)} as never)
 const buttons:Array<{props:{onClick:()=>void}}>=[]
 function walk(node:unknown){if(Array.isArray(node)){node.forEach(walk);return}if(!node||typeof node!=='object')return;const element=node as {type?:string;props?:{children?:unknown}};if(element.type==='button')buttons.push(node as never);walk(element.props?.children)}
 walk(tree);assert.equal(buttons.length,1);buttons[0]!.props.onClick();assert.deepEqual(opened,['models'])
})
test('面板：可选模型及准备状态有中英文可读文案，不能把未知阶段写成就绪',()=>{
 const labels={unsupported:['当前版本不支持','Unsupported version'],disabled:['扩展未启用','Extension disabled'],unprepared:['未下载','Not downloaded'],checking:['检查中','Checking'],downloading:['下载中','Downloading'],loading:['加载中','Loading'],waking:['唤醒中','Waking'],ready:['就绪','Ready'],standby:['已准备，待机中','Prepared, on standby'],cancelling:['正在取消','Cancelling'],cancelled:['已取消','Cancelled'],failed:['准备失败','Preparation failed'],unavailable:['暂时无法核对','Status unavailable']}
 for(const [phase,texts] of Object.entries(labels))for(const [index,locale] of ['zh-CN','en'].entries()){
  const translated=(key:string,params?:Record<string,string|number>)=>translateMessage(locale as never,key as never,params as never)
  const current={...withModels,counts:{ready:0,auto:0,needsUser:0,optional:1,pending:0},rows:[{...withModels.rows[0],state:'optional',entry:'task-form',models:[{...model,phase,required:false}]}]}
  const html=render({readiness:current,t:translated})
  assert.ok(html.includes(texts[index]!),`${locale}: ${phase}`)
  assert.ok(html.includes(index===0?'可选':'optional'))
  assert.doesNotMatch(html,/market\.industry\.model\.phase|undefined/)
 }
})
test('面板：模型标题与入口中的 HTML、双向字符不能注入界面',()=>{
 const forged={...withModels,rows:[{...withModels.rows[0],title:'转写\u202e\n会议',models:[{...model,title:'<img src=x onerror=1>\u2066'}]}]}
 const html=render({readiness:forged})
 assert.match(html,/转写 会议/);assert.match(html,/&lt;img src=x onerror=1&gt;/)
 assert.doesNotMatch(html,/<img|[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/)
})
test('api：白名单载荷与回包逐键校验；最终清单待刷新的回执可读',async()=>{
 const calls:unknown[]=[]
 const api=createIndustryLoadApi(async(method:string,payload:unknown)=>{calls.push([method,payload]);return method==='industry-loads/readiness'?readiness:{loadId,digest:readiness.digest,results:[],readiness}})
 assert.equal((await api.readiness(loadId)).digest,'9'.repeat(64))
 assert.equal((await api.prepare(loadId,'9'.repeat(64))).loadId,loadId)
 assert.deepEqual(calls,[['industry-loads/readiness',{loadId}],['industry-loads/prepare',{loadId,expectedDigest:'9'.repeat(64)}]])
 await assert.rejects(api.prepare(loadId,'zz'),/参数不正确/)
 await assert.rejects(createIndustryLoadApi(async()=>({...readiness,extra:1})).readiness(loadId),/格式不正确/)
 await assert.rejects(createIndustryLoadApi(async()=>({...readiness,rows:[{...readiness.rows[0],state:'unknown'}]})).readiness(loadId),/格式不正确/)
 await assert.rejects(createIndustryLoadApi(async()=>({...readiness,status:'gone'})).readiness(loadId),/格式不正确/)
 assert.equal((await createIndustryLoadApi(async()=>({loadId,digest:readiness.digest,results:[],readiness:null})).prepare(loadId,'9'.repeat(64))).readiness,null)
 const trusted={...readiness,rows:[...readiness.rows,{itemInstanceId:'22222222-2222-4222-8222-222222222222',kind:'skill',title:'研究简报',state:'auto',step:'skill',entry:null,trust:{publisher:'Teloa 官方目录',license:null}}]}
 assert.deepEqual((await createIndustryLoadApi(async()=>trusted).readiness(loadId)).rows.at(-1)!.trust,{publisher:'Teloa 官方目录',license:null})
 await assert.rejects(createIndustryLoadApi(async()=>({...trusted,rows:[{...trusted.rows.at(-1),trust:{publisher:'x',license:null,extra:1}}]})).readiness(loadId),/格式不正确/)
})

test('面板：全部就绪时标题改为「都准备好了」，没有一键准备按钮',()=>{
 const html=render({readiness:{...readiness,counts:{ready:3,auto:0,needsUser:0,optional:1,pending:0},rows:readiness.rows.map(row=>row.state==='optional'?row:{...row,state:'ready',entry:null})}})
 assert.match(html,/<h3[^>]*>都准备好了<\/h3>/);assert.match(html,/需要准备的 3 项里，已就绪 3 项/);assert.doesNotMatch(html,/一键准备/)
})

// N24：宿主只给本批新建、关联技能与连接都已就绪的员工绑定技能并上岗；关联项还需要你操作时，一键只会建出暂停、无技能的员工，之后也不再补绑。
// 主按钮因此先去处理那些项，「仍要先创建暂停的员工」降为显式次要入口，只打开原一键确认、不直接执行。
const WRole='88888888-8888-4888-8888-888888888888',WSkill='99999999-9999-4999-8999-999999999999',WConn='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const writing={...readiness,counts:{ready:0,auto:1,needsUser:1,optional:0,pending:0},rows:[
 {itemInstanceId:WRole,kind:'role',title:'Writing Bot',state:'auto',step:'role',entry:null},
 {itemInstanceId:WSkill,kind:'skill',title:'Writing revision',state:'needs-user',step:null,entry:'skill-confirm'}]}
const writingLinks=[{kind:'role-skill',from:WRole,to:WSkill}]
const label=(node:{props:{children?:unknown}})=>[node.props.children].flat(Infinity).filter(value=>typeof value==='string').join('')
function tree(props:Record<string,unknown>){
 const calls={asked:0,confirmed:0,opened:[] as string[]}
 const root=IndustryReadinessPresentation({readiness,receipt:undefined,confirming:false,busy:false,error:'',t,localize:()=>'',onAsk:()=>{calls.asked++},onCancel:()=>{},onConfirm:()=>{calls.confirmed++},onOpen:(group:string)=>calls.opened.push(group),...props} as never)
 const buttons:Array<{props:{onClick:()=>void;children?:unknown}}>=[]
 const walk=(node:unknown):void=>{if(Array.isArray(node)){node.forEach(walk);return}if(!node||typeof node!=='object')return;const element=node as {type?:string;props?:{children?:unknown}};if(element.type==='button')buttons.push(node as never);walk(element.props?.children)}
 walk(root)
 return {calls,button:(text:string)=>buttons.find(node=>label(node)===text)}
}
test('面板：员工关联的技能需要你先确认时，主按钮先去处理该技能，不把建出暂停、无技能员工包装成一键就绪',()=>{
 const html=render({readiness:writing,relations:writingLinks})
 assert.match(html,/先处理 Writing revision，再准备员工 Writing Bot：现在一键准备只会先建出暂停的员工，之后也不会再替它补上技能或上岗。/)
 assert.match(html,/primaryButton[^>]*>先去处理</)
 assert.doesNotMatch(html,/primaryButton[^>]*>一键准备/)
 assert.match(html,/逐个确认技能（信任说明或脚本）：Writing revision/)
 const view=tree({readiness:writing,relations:writingLinks})
 view.button('先去处理')!.props.onClick()
 assert.deepEqual(view.calls.opened,['capabilities'])
 assert.equal(view.calls.asked,0);assert.equal(view.calls.confirmed,0)
 view.button('仍要先创建暂停的员工')!.props.onClick()
 assert.equal(view.calls.asked,1);assert.equal(view.calls.confirmed,0,'次要入口只打开原确认，不直接执行')
 const confirming=render({readiness:writing,relations:writingLinks,confirming:true})
 assert.match(confirming,/创建员工：Writing Bot/)
 assert.match(confirming,/Writing Bot 会以暂停状态创建；之后再点一键准备也不会替它补上技能或上岗，需要你到员工分组检查后自行恢复。/)
})
test('面板：技能已装好、由一键安装的官方技能、与员工无关的待确认项或员工已建好时，保持原一键准备',()=>{
 for(const state of ['ready','auto'] as const){
  const rows=writing.rows.map(row=>row.itemInstanceId===WSkill?{...row,state,entry:null,step:state==='auto'?'skill':null}:row)
  const html=render({readiness:{...writing,rows},relations:writingLinks})
  assert.match(html,/primaryButton[^>]*>一键准备/);assert.doesNotMatch(html,/先去处理|仍要先创建暂停的员工|再准备员工/)
 }
 assert.match(render({readiness:writing,relations:[]}),/primaryButton[^>]*>一键准备/)
 assert.match(render({readiness:writing}),/primaryButton[^>]*>一键准备/)
 const created={...writing,rows:writing.rows.map(row=>row.itemInstanceId===WRole?{...row,state:'needs-user',step:null,entry:'role-resume'}:row)}
 assert.doesNotMatch(render({readiness:created,relations:writingLinks}),/再准备员工|仍要先创建暂停的员工/)
})
test('面板：员工关联的连接需要授权时同样先去处理连接；技能与连接都待处理时先去技能',()=>{
 const conn={itemInstanceId:WConn,kind:'mcp',title:'Docs MCP',state:'needs-user',step:null,entry:'connector-settings'}
 const connLinks=[{kind:'role-connection',from:WRole,to:WConn}]
 const onlyConn=tree({readiness:{...writing,rows:[writing.rows[0],conn]},relations:connLinks})
 onlyConn.button('先去处理')!.props.onClick();assert.deepEqual(onlyConn.calls.opened,['connectors'])
 const both={...writing,rows:[writing.rows[0],conn,writing.rows[1]]},links=[...connLinks,...writingLinks]
 const view=tree({readiness:both,relations:links})
 view.button('先去处理')!.props.onClick();assert.deepEqual(view.calls.opened,['capabilities'])
 assert.match(render({readiness:both,relations:links}),/先处理 Writing revision、Docs MCP，再准备员工 Writing Bot/)
})
test('面板只把当前核对过的清单回报给目录（行为见 industry-readiness-freshness.test.ts），供同事详情复用同一真实状态',async()=>{
 const source=await readFile(new URL('../src/client/IndustryReadinessPanel.tsx',import.meta.url),'utf8')
 assert.match(source,/useEffect\(\(\)=>\{onReadRef\.current\?\.\(fresh\?readiness:undefined\)\},\[fresh,readiness\]\)/)
})
test('面板：重新核对失败时旧清单只作上次结果——不写「都准备好了」、不给一键准备，并提供重新核对',()=>{
 const done={...readiness,counts:{ready:2,auto:1,needsUser:0,optional:0,pending:0},rows:readiness.rows.filter(row=>row.state!=='needs-user'&&row.state!=='optional')}
 let retried=0
 const html=render({readiness:done,stale:true,error:'准备清单读取失败',onRetry:()=>{retried++}})
 assert.match(html,/<h3[^>]*>上次核对的结果<\/h3>/)
 assert.match(html,/刚才没能重新核对，下面是上次核对的结果，实际状态可能已经变化。/)
 assert.doesNotMatch(html,/都准备好了|一键准备/)
 assert.match(html,/准备清单读取失败/)
 const view=tree({readiness:done,stale:true,error:'x',onRetry:()=>{retried++}})
 view.button('重新核对')!.props.onClick();assert.equal(retried,1)
 assert.equal(view.calls.asked+view.calls.confirmed,0)
 assert.match(render({readiness:undefined,error:'首次读取失败',onRetry:()=>{}}),/首次读取失败[\s\S]*重新核对/)
})
test('面板：依赖应用在确认态列为「安装并启用」，需要你处理的应用逐项写明原因并给去处理入口',()=>{
 const G='99999999-9999-4999-8999-999999999999',H='98888888-9999-4999-8999-999999999999'
 const rows=[...readiness.rows,{itemInstanceId:G,kind:'plugin',title:'工单应用',state:'auto',step:'plugin',entry:null,app:{version:'1.2.0',packageName:'@example/ticket'}},{itemInstanceId:H,kind:'plugin',title:'告警应用',state:'needs-user',step:null,entry:'plugin',reason:'unverified'}]
 const withApps={...readiness,counts:{...readiness.counts,auto:2,needsUser:2},rows}
 assert.match(render({readiness:withApps,confirming:true}),/将随一键安装并启用应用：工单应用（@example\/ticket@1\.2\.0；只装已核验、只新增配置的，会改动现有配置的不装、交你确认）/)
 const html=render({readiness:withApps})
 assert.match(html,/告警应用 会改动现有配置，未自动安装：查看改动与权限后自行确认/)
 assert.doesNotMatch(html,/确认扩展安装/)
 const unlinked={itemInstanceId:H,kind:'plugin',title:'告警应用',state:'needs-user',step:null,entry:'plugin'}
 assert.match(render({readiness:{...withApps,rows:[...readiness.rows,unlinked]}}),/确认扩展安装：告警应用/,'未被员工依赖的应用照旧并入确认扩展安装')
 for(const reason of ['rejected','restart-required','failed','drift','unreadable'])assert.match(render({readiness:{...withApps,rows:[...readiness.rows,{...rows.at(-1),reason}]}}),/告警应用 /,reason)
})
