import test from 'node:test'
import assert from 'node:assert/strict'
import { readIndustryDirectory } from '../src/client/industry-directory.ts'
import { inspectIndustryContent } from '../src/client/industry-content.ts'
import { prepareIndustryReferenceCandidates, referenceCandidates, resolveIndustryReferences } from '../src/client/industry-reference.ts'
import {readAtomicSkill} from '../src/client/atomic-skill.ts'
import {atomicSkillItem} from '../src/client/atomic-market.ts'
import {marketResourceIndex} from '../src/client/market-resource-index.ts'
const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
async function item(local:boolean,body='公共手册',version='1.0.0'){
 const manifest={format:'teloa.business-package/v2',id:local?'provider':'consumer',title:local?'公共内容':'业务模板',version:'1.0.0',domain:'general',description:'复用知识',resources:[{id:local?'handbook':'guide',kind:'knowledge',title:'手册',version,required:true,source:local?{kind:'local',path:'guide.md'}:{kind:'public',id:'handbook',version}}],relations:[],entrypoints:[]}
 return readIndustryDirectory([file('teloa.json',JSON.stringify(manifest)),...(local?[file('guide.md',body)]:[])],'teloa.json','模板')
}
test('明确选择同身份与版本的实际内容，固定引用快照和新内容摘要',async()=>{
 const provider=await item(true),consumer=await item(false)
 const candidate=referenceCandidates(consumer,[provider],'guide')[0]!
 const resolved=await resolveIndustryReferences(consumer,[provider],[candidate])
 assert.notEqual(resolved.id,consumer.id)
 assert.notEqual(resolved.packageContent?.hash,consumer.packageContent?.hash)
 assert.ok(resolved.manifest?.format==='teloa.business-package/v2'&&resolved.packageContent)
 const row=inspectIndustryContent(resolved.manifest,resolved.packageContent)[0]
 assert.equal(row?.state,'parsed')
 if(row?.definition?.kind==='knowledge')assert.equal(row.definition.text,'公共手册')
 assert.equal(consumer.packageContent?.resources[0]?.state,'unresolved')
 const snapshot=resolved.packageContent.resolved?.[0]
 assert.deepEqual(snapshot?.sourceFiles.map(file=>file.path),['guide.md'])
 provider.packageContent?.files.find(file=>file.path==='guide.md')?.bytes.fill(0)
 assert.equal(new TextDecoder().decode(snapshot?.sourceFiles[0]?.bytes),'公共手册')
})
test('多来源只列候选，不自动选择；不同版本不匹配，过期摘要拒绝',async()=>{
 const first=await item(true),second=await item(true,'另一内容'),wrong=await item(true,'旧版本','2.0.0'),consumer=await item(false)
 const candidates=referenceCandidates(consumer,[first,second,wrong],'guide')
 assert.equal(candidates.length,2)
 assert.equal((await resolveIndustryReferences(consumer,[first],[])).packageContent?.resources[0]?.state,'unresolved')
 await assert.rejects(()=>resolveIndustryReferences(consumer,[first],[{...candidates[0]!,sourceHash:'changed'}]),/来源|变化/)
 await assert.rejects(()=>resolveIndustryReferences(consumer,[first],[candidates[0]!,candidates[0]!]),/重复/)
})
test('独立Skill可明确供行业引用，固定正文和附件且不伪造原生安装',async()=>{
 const skill=atomicSkillItem(await readAtomicSkill([file('report/SKILL.md','# 报告方法'),file('report/reference.md','附属资料')],{id:'report-writing',title:'报告方法',version:'1.0.0',categories:['写作']}))
 const manifest={format:'teloa.business-package/v2',id:'skill-consumer',title:'研究行业',version:'1.0.0',domain:'general',description:'研究',resources:[{id:'report',kind:'skill',title:'报告撰写',version:'1.0.0',required:true,source:{kind:'public',id:'report-writing',version:'1.0.0'}}],relations:[],entrypoints:['report']}
 const consumer=await readIndustryDirectory([file('teloa.json',JSON.stringify(manifest))],'teloa.json','研究')
 assert.equal(referenceCandidates(consumer,[skill],'report').length,0)
 const stored={...skill,contentStorage:{contentId:'11111111-1111-4111-8111-111111111111',createdAt:'2026-09-11T00:00:00Z',loaded:true}}
 const candidates=referenceCandidates(consumer,[stored],'report')
 assert.equal(candidates.length,1)
 assert.equal(candidates[0]?.sourceContentId,stored.contentStorage.contentId)
 await assert.rejects(()=>resolveIndustryReferences(consumer,[stored],[{...candidates[0]!,sourceContentId:'22222222-2222-4222-8222-222222222222'}]),/来源|变化/)
 const result=await resolveIndustryReferences(consumer,[stored],candidates)
 const resolved=result.packageContent!.resolved![0]!
 assert.equal(resolved.inspection.state,'pending')
 assert.equal(resolved.inspection.definition?.kind,'skill')
 assert.equal(resolved.sourceFiles.length,2)
 const entry=marketResourceIndex([stored,result]).find(row=>row.itemId===stored.id)!
 assert.equal(entry.uses[0]!.templateId,result.id)
 stored.atomicSkill!.files[0]!.bytes.fill(0)
 assert.equal(new TextDecoder().decode(resolved.sourceFiles[0]!.bytes),'# 报告方法')
 assert.equal(consumer.packageContent!.resources[0]!.state,'unresolved')
})
test('行业模板引用预览会先读取本人固定Skill摘要，内置演示不冒充真实候选',async()=>{
 const skill=atomicSkillItem(await readAtomicSkill([file('report/SKILL.md','# 报告方法')],{id:'report-writing',title:'报告方法',version:'1.0.0',categories:['写作']}))
 const stored={...skill,contentStorage:{contentId:'11111111-1111-4111-8111-111111111111',createdAt:'2026-09-11T00:00:00Z',loaded:true}}
 const {atomicSkill:_,...storedSummary}=stored
 const summary={...storedSummary,contentStorage:{...stored.contentStorage,loaded:false}}
 const manifest={format:'teloa.business-package/v2',id:'skill-consumer',title:'研究行业',version:'1.0.0',domain:'general',description:'研究',resources:[{id:'report',kind:'skill',title:'报告撰写',version:'1.0.0',required:true,source:{kind:'public',id:'report-writing',version:'1.0.0'}}],relations:[],entrypoints:['report']}
 const consumer=await readIndustryDirectory([file('teloa.json',JSON.stringify(manifest))],'teloa.json','研究')
 const hydrated:string[]=[]
 const items=await prepareIndustryReferenceCandidates(consumer,[summary,skill],async item=>{hydrated.push(item.contentStorage!.contentId);return stored})
 assert.deepEqual(hydrated,[stored.contentStorage.contentId])
 assert.equal(referenceCandidates(consumer,items,'report').length,1)
 const unsupported=await item(false)
 await assert.rejects(()=>prepareIndustryReferenceCandidates(unsupported,[summary],async()=>stored),/只支持公共技能/)
})
