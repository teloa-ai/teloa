import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// 官方方案详情按原型 `市场方案.jsx` 的产品页：hero（插画 + 标题 + 一句话 + 一个主按钮）→「添加后你会得到」七行 → 小字折叠「来源与版本」。
// 七行不另存数据：宿主从方案包清单算出，这里只核对渲染口径与本机方案产品页一致（顺序、标签、计数、附注、空行不显示）。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {CatalogSolutionProduct}=await import('../lib/types/client/MarketCatalogSection.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {validateIndustryManifest}=await import('../lib/types/client/industry-manifest.js')

const read=(path:string)=>JSON.parse(readFileSync(new URL('../../../../tests/fixtures/public-market/'+path,import.meta.url),'utf8'))
const entry=read('catalog/solutions/teloa.cn-workspace.json')
const manifest=validateIndustryManifest(read('artifacts/solutions/teloa.cn-workspace/1.0.0/teloa.json'))
const socEntry=read('catalog/solutions/teloa.soc.json')
const socManifest=validateIndustryManifest(read('artifacts/solutions/teloa.soc/1.0.2/teloa.json'))
const runtime=(locale:'zh-CN'|'en')=>({t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})})
const item=(patch:Record<string,unknown>={},value=entry)=>({entry:value,artifact:{files:[{path:'teloa.json',sha256:'a'.repeat(64),size:1}],treeHash:'c'.repeat(64)},addedContentId:null,addedRoleId:null,secretGroup:null,...patch})
const ready=(readOnlyResources:string[]=['lark-read','yuque-read'],value=manifest)=>({status:'ready',manifest:value,readOnlyResources})
const render=(props:Record<string,unknown>,locale:'zh-CN'|'en'='zh-CN')=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime(locale) as never},createElement(CatalogSolutionProduct as never,{item:item(),pkg:ready(),busy:undefined,add:()=>{},open:()=>{},back:()=>{},retry:()=>{},...props} as never)))
const text=(html:string)=>html.replace(/<[^>]+>/g,'\n').replace(/&amp;/g,'&').split('\n').map(line=>line.trim()).filter(Boolean)
const indexOf=(lines:string[],value:string)=>{const at=lines.indexOf(value);assert.ok(at>=0,'找不到：'+value);return at}

test('纵向顺序照原型：回到市场 → 标题 → 一句话 → 主按钮 → 添加后你会得到 → 七行 → 来源与版本',()=>{
 const lines=text(render({}))
 const order=['回到市场','中国企业办公协同',entry.solution.summary['zh-CN'],'添加方案','添加后你会得到','AI 员工','技能','依据资料','接入源','任务模板','来源与版本']
 order.reduce((last,value)=>{const at=indexOf(lines,value);assert.ok(at>last,value+' 的位置不对');return at},-1)
 const html=render({})
 assert.match(html,/<h1[^>]*data-catalog-detail-title[^>]*>中国企业办公协同<\/h1>/)
 assert.match(html,/class="[^"]*primaryAction[^"]*"[^>]*>添加方案/)
})

test('七行只列方案包里真有的：没有业务看板与扩展就不出这两行，不留空标题，不写「0 个」',()=>{
 const lines=text(render({}))
 for(const absent of ['业务看板','扩展','工作室通用'])assert.equal(lines.includes(absent),false,absent)
 assert.doesNotMatch(render({}),/>0 /)
 for(const count of ['1 位员工','5 项技能','1 份资料','2 个接入源','4 个任务模板'])assert.ok(lines.includes(count),count)
 // 每行列出的名字取自清单里的资源标题
 for(const name of ['群消息日报','飞书只读连接（群消息与云文档）','语雀只读连接（知识库文档）'])assert.ok(lines.some(line=>line===name),name)
})

test('接入源的「读 / 写」：官方连接器目录里全是只读工具的连接写「读」；判定不了的仍按保守口径写「写」',()=>{
 const lines=text(render({}))
 const lark=indexOf(lines,'飞书只读连接（群消息与云文档）')
 assert.equal(lines[lark+1],'读')
 assert.equal(lines.includes('写'),false)
 const conservative=text(render({pkg:ready([])}))
 assert.equal(conservative[indexOf(conservative,'飞书只读连接（群消息与云文档）')+1],'写')
})

test('同事行显示头像与名字；任务模板行只在真有自动化时写附注',()=>{
 const soc=render({item:item({},socEntry),pkg:ready([],socManifest)})
 const lines=text(soc)
 assert.ok(lines.includes('2 位员工'))
 assert.ok(lines.includes('T1 告警研判员')&&lines.includes('T2 事件调查员'))
 assert.ok(lines.includes('其中 1 个设成了自动化'))
 assert.equal(lines.includes('接入源'),false,'SOC 包里没有连接，不出接入源行')
 assert.equal(text(render({})).some(line=>line.includes('设成了自动化')),false)
})

test('来源与版本：来源、版本、使用条件、现在可做、还需你提供、会请求的权限与「添加只是加入」的提醒都在这一个折叠里',()=>{
 const html=render({})
 const fold=html.slice(html.indexOf('<details'))
 assert.equal((html.match(/<details/g)??[]).length,1,'只有一个页级折叠')
 assert.doesNotMatch(html,/<details[^>]*open/)
 for(const value of ['来源与版本','Teloa','v1.0.0','需要配置','现在可做','还需你提供','会请求的权限','添加只是加入，不等于已经能用',entry.solution.capabilities.needs[0]['zh-CN'],entry.solution.capabilities.permissions[0]['zh-CN'],entry.compatibility.conditions[0]['zh-CN'],'问题反馈'])
  assert.ok(fold.includes(value),'折叠里找不到：'+value)
})

test('读取中与读取失败：只给一句白话说明（失败时带重试），不出「添加后你会得到」空标题',()=>{
 const loading=text(render({pkg:{status:'loading'}}))
 assert.ok(loading.includes('正在读取这个方案带来的内容…'))
 assert.equal(loading.includes('添加后你会得到'),false)
 const failed=render({pkg:{status:'failed'}})
 assert.match(failed,/role="alert"[^>]*>暂时读不到这个方案带来的内容/)
 assert.match(failed,/>重试<\/button>/)
 assert.equal(text(failed).includes('添加后你会得到'),false)
 assert.ok(text(failed).includes('来源与版本'),'读不到七行时来源与版本照常可看')
})

test('已添加：主按钮变成「已添加」且不可点，旁边给「查看」；添加中禁用；暂不支持时不给添加按钮只写原因',()=>{
 const added=render({item:item({addedContentId:'22222222-2222-4222-8222-222222222222'})})
 assert.match(added,/disabled=""[^>]*>已添加/)
 assert.match(added,/>查看<\/button>/)
 assert.doesNotMatch(added,/>添加方案/)
 assert.match(render({busy:'teloa.cn-workspace'}),/disabled=""[^>]*>正在添加…/)
 const unsupported=render({item:item({},{...entry,compatibility:{...entry.compatibility,status:'unsupported',conditions:[{'zh-CN':'这个方案暂不支持当前版本。',en:'Not supported yet.'}]}})})
 assert.doesNotMatch(unsupported,/>添加方案/)
 assert.match(unsupported,/这个方案暂不支持当前版本。/)
 assert.match(render({error:'添加失败：网络中断'}),/role="alert"[^>]*>添加失败：网络中断/)
})

test('英文界面：标题、一句话与七行名字都取英文',()=>{
 const lines=text(render({},'en'))
 for(const value of ['China workplace collaboration','What you’ll get after adding',"AI employees",'Connections','Read','Feishu read-only connection (group messages and docs)','Source & version'])assert.ok(lines.includes(value),value)
})

// 设计约束）：主按钮照原型写「添加到我的团队」并合成一步——在官方页里先加到本机，再就地展开与本机页同一个团队确认步骤；
// 另有「先问问它适不适合我」，以官方方案包内容为依据发起问答。
const team=(patch:Record<string,unknown>={})=>({loaded:false,links:null,panel:null,addToTeam:()=>{},...patch})
test('接上团队步骤后：主按钮写「添加到我的团队」，不再出现「添加方案」；已加进团队时写「已在我的团队里」且不可点',()=>{
 const html=render({team:team()})
 assert.match(html,/class="[^"]*primaryAction[^"]*"[^>]*>添加到我的团队/)
 assert.doesNotMatch(html,/添加方案/)
 // 是否已在团队按方案包清单判断，不依赖本机是否已读回这份内容；已在团队时给本机页同一个「看看它带进来什么 · 空间」入口
 const loaded=render({team:team({loaded:true,links:createElement('button',{type:'button'},'看看它带进来什么 · 协同')})})
 assert.match(loaded,/disabled=""[^>]*>已在我的团队里/)
 assert.match(loaded,/>看看它带进来什么 · 协同<\/button>/)
 assert.doesNotMatch(loaded,/>查看<\/button>/)
 // 已加到本机但还没进团队：仍是「添加到我的团队」，不是「已添加」
 const stored=render({item:item({addedContentId:'22222222-2222-4222-8222-222222222222'}),team:team()})
 assert.match(stored,/primaryAction[^"]*"[^>]*>添加到我的团队/)
 assert.doesNotMatch(stored,/>已添加</)
})

test('团队确认步骤就地展开：七行让位给确认步骤，主按钮标明已展开，页面不跳走',()=>{
 const html=render({team:team({panel:createElement('section',{'aria-label':'团队确认步骤'},'确认步骤')})})
 assert.match(html,/aria-label="团队确认步骤"/)
 assert.match(html,/aria-expanded="true"[^>]*>添加到我的团队|添加到我的团队[\s\S]*aria-expanded="true"/)
 assert.equal(text(html).includes('添加后你会得到'),false)
 assert.ok(text(html).includes('中国企业办公协同'))
})

test('「先问问它适不适合我」：给了问答入口才显示；方案包没读到时不可点',()=>{
 assert.doesNotMatch(render({}),/先问问它适不适合我/)
 assert.match(render({ask:{busy:false,run:()=>{}}}),/<button type="button"[^>]*>(<svg[\s\S]*?<\/svg>)?先问问它适不适合我/)
 assert.match(render({ask:{busy:false,run:()=>{}},pkg:{status:'loading'}}),/disabled=""[^>]*>(<svg[\s\S]*?<\/svg>)?先问问它适不适合我/)
 const order=text(render({team:team(),ask:{busy:false,run:()=>{}}}))
 assert.ok(order.indexOf('添加到我的团队')<order.indexOf('先问问它适不适合我'),'问答入口在主按钮之后')
})
