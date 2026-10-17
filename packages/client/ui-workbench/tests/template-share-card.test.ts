import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {buildSharePlan} from '../src/client/share-package-plan.ts'
import {buildEmployeeTemplate} from '../src/client/employee-template-share.ts'
import {TEMPLATE_SHARE_MESSAGE_KEYS,templateShareMessages,templateShareHongKongMessages} from '../src/client/i18n/locales/template-share.ts'

registerHooks({
 resolve:(specifier,context,next)=>/\.(module\.css|svg|webp|png)$/.test(specifier)?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>/\.(svg|webp|png)$/.test(url)?{format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}:url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
// 构建产物按运行时形状使用；用例只构造替身数据。
const {TemplateShareCard}:any=await import('../lib/types/client/TemplateShareCard.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const render=(node:unknown,locale:'zh-CN'|'zh-Hant'|'en'='zh-CN')=>renderToStaticMarkup(createElement(I18nProvider,{runtime:{t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})} as never},node as never))

const role=(id:string,name:string)=>({id,name,kind:'employee' as const,duty:'Verify sources.',dataScope:'Provided documents.',executionScope:'Confirm external writes.',skills:[],knowledge:[],scopes:['general'],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}})
const base={publisher:'Max',license:'MIT',plugins:[]}

test('模板卡按主体展示：员工、团队、单技能、连接与应用都能渲染，没有员工的包不解引用首位员工',()=>{
 const employee=render(createElement(TemplateShareCard,{pkg:buildEmployeeTemplate({...role('a','Researcher'),avatarKey:'security-analyst'}),status:'draft'},'x'))
 assert.ok(employee.includes('AI 员工')&&employee.includes('Researcher'))
 const team=render(createElement(TemplateShareCard,{pkg:buildSharePlan({...base,subject:'team',title:'Support team',roles:[role('a','Lead'),role('b','Agent')],coordinatorRoleId:'b',skills:[],connections:[]}),status:'preview'},'x'))
 assert.ok(team.includes('AI 团队')&&team.includes('员工 2'))
 const skill=render(createElement(TemplateShareCard,{pkg:buildSharePlan({...base,subject:'skill',roles:[],skills:[{name:'notes',title:'Notes',resourceId:'notes',version:'1.0.0',publicId:'notes'}],connections:[]}),status:'published'},'x'),'en')
 assert.ok(skill.includes('Skill 1')&&skill.includes('Notes')&&skill.includes('MIT'))
 const mcp=render(createElement(TemplateShareCard,{pkg:buildSharePlan({...base,subject:'mcp',roles:[],skills:[],connections:[{serverName:'notion',title:'Notion',tools:['search']}]}),status:'draft'},'x'),'zh-Hant')
 assert.ok(mcp.includes('連線')&&mcp.includes('Notion'))
})

test('分享词条三语齐全并带香港用词，其余语言沿统一回退',()=>{
 for(const key of TEMPLATE_SHARE_MESSAGE_KEYS)for(const locale of ['zh-CN','zh-Hant','en'] as const)assert.ok(templateShareMessages[locale][key]?.trim(),key+' '+locale)
 for(const key of ['templateShare.shareTeam','templateShare.submit','templateShare.attestation','templateShare.addAll','templateShare.result.failed','templateShare.subject.team'] as const)assert.ok(TEMPLATE_SHARE_MESSAGE_KEYS.includes(key),key)
 assert.equal(templateShareHongKongMessages['templateShare.subject.app'],'應用程式')
 assert.equal(translateMessage('ja','templateShare.shareTeam' as never),templateShareMessages.en['templateShare.shareTeam'])
})
