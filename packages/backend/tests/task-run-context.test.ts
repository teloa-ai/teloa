import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {runKnowledgeCatalog,runSkillCatalog,readRunKnowledgeSegment,loadRunSkill,searchRunKnowledge} from '../src/work/task-run-context.ts'
import type {RunKnowledge} from '../src/work/task-run-knowledge.ts'
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const knowledge=(title:string,text:string):RunKnowledge=>({id:randomUUID(),version:2,title,text,sourceId:'source_'+randomUUID(),sourceVersion:sha(text),scopeIds:['general']})
const identity=(item:RunKnowledge)=>({resourceId:item.id,resourceVersion:item.version,sourceVersion:item.sourceVersion})

test('资源目录有界，仅保留名称、用途和固定版本，不包含正文、文件清单或磁盘路径',()=>{
 const docs=Array.from({length:16},(_,i)=>knowledge('Guide '+i,'# Guide\nPurpose '+i+'\n\n'+'body-'.repeat(1750)))
 const skills=Array.from({length:10},(_,i)=>({name:'method-'+i,description:'When needed '+i,provider:'native',source:'project',content:'secret-method-'.repeat(220),sha256:sha('secret-method-'.repeat(220)),resourceBase:{kind:'directory' as const,path:'/private/method'}}))
 const catalog=JSON.stringify({knowledge:runKnowledgeCatalog(docs),skills:runSkillCatalog(skills)}),full=JSON.stringify({knowledge:docs,skills})
 assert.equal(runKnowledgeCatalog(docs).length,16);assert.equal(runSkillCatalog(skills).length,10)
 assert.ok(catalog.length<full.length*0.1)
 assert.doesNotMatch(catalog,/body-|secret-method|\/private|"content"|"text"/)
 assert.equal(runKnowledgeCatalog([knowledge('long','用途'.repeat(10000))])[0]!.purpose.length,160)
})

test('分段读取固定身份，完整续读 Unicode、CRLF 和相邻内容，无静默截断',()=>{
 const item=knowledge('指南','# 第一节\r\n'+'😀 line\r\n'.repeat(800)+'# 相邻节\r后续内容')
 let offset=0,combined=''
 do{
  const part=readRunKnowledgeSegment([item],{...identity(item),offset,length:399})
  assert.ok(part.excerpt.length<=400);assert.equal(Buffer.from(part.excerpt,'utf8').toString('utf8'),part.excerpt)
  combined+=part.excerpt
  if(part.nextOffset===null)break
  assert.ok(part.nextOffset>offset);offset=part.nextOffset
 }while(true)
 assert.equal(combined,item.text.replace(/\r\n?/g,'\n'))
 const aligned=knowledge('Unicode','😀'+'x'.repeat(5000))
 assert.equal(readRunKnowledgeSegment([aligned],{...identity(aligned),offset:1,length:4000}).excerpt.length,4000)
 assert.match(readRunKnowledgeSegment([item],{...identity(item),offset:combined.indexOf('# 相邻节')}).excerpt,/后续内容/)
 for(const bad of [{resourceId:randomUUID()},{resourceVersion:3},{sourceVersion:'0'.repeat(64)},{offset:-1},{length:4001},{offset:1.5},{runId:randomUUID()}])assert.throws(()=>readRunKnowledgeSegment([item],{...identity(item),...bad}))
})

test('Skill 必须属于本次绑定且摘要相符；只返回选中方法，正文逐字保留',()=>{
 const content='# Method\n完整规则 {{literal}}',skill={name:'research',description:'研究方法',provider:'native',source:'project',content,sha256:sha(content)}
 assert.equal(loadRunSkill([skill],{name:skill.name,sha256:skill.sha256}).content,content)
 for(const args of [{name:'other',sha256:skill.sha256},{name:skill.name,sha256:'f'.repeat(64)},{name:skill.name,sha256:skill.sha256,owner:'other'}])assert.throws(()=>loadRunSkill([skill],args))
})

test('没有索引也能查询固定正文；旧新版、无关资料、空许可和有界结果保持隔离',()=>{
 const a=knowledge('Identity','# Identity\nAAD PIM elevation requires approval.\n\n'+'AAD review\n'.repeat(100)),b=knowledge('Network','# Network\nFirewall routing only.')
 const first=searchRunKnowledge([a,b],{query:'AAD PIM',limit:2})
 assert.equal(first.coverage.searched.length,2);assert.equal(first.results.length,2);assert.ok(first.results.every(hit=>hit.resourceId===a.id))
 const foreign={...first,results:first.results.map(hit=>({...hit,resourceVersion:3,excerpt:'NEW VERSION SECRET'}))}
 const result=searchRunKnowledge([a,b],{query:'AAD',limit:1},foreign)
 assert.equal(result.results[0]!.resourceVersion,2);assert.doesNotMatch(JSON.stringify(result),/NEW VERSION/)
 assert.equal(searchRunKnowledge([],{query:'AAD'},first).results.length,0)
 assert.equal(searchRunKnowledge([a,b],{query:'absent-token'}).results.length,0)
 const chinese=knowledge('报销','# 报销\n部门负责人需要审批后再交财务。')
 assert.equal(searchRunKnowledge([chinese],{query:'报销审批流程'}).results.length,1)
})
