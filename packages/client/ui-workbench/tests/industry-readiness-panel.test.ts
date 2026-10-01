import assert from 'node:assert/strict'
import test from 'node:test'
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
test('面板：确认态按组列出将自动完成的条目（每组最多 10 个）并注明每日小结；回执显示完成/处理中/失败计数',()=>{
 const confirming=render({confirming:true})
 assert.match(confirming,/密钥与授权仍需你在对应页面完成/);assert.match(confirming,/每日小结/);assert.match(confirming,/启用资料：分诊指南/)
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
