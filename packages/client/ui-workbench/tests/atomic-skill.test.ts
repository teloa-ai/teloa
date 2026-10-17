import test from 'node:test'
import assert from 'node:assert/strict'
import * as atomic from '../src/client/atomic-skill.ts'
const {readAtomicSkill}=atomic
import type { IndustryFileInput } from '../src/client/industry-directory.ts'

const bytes=(text:string)=>new TextEncoder().encode(text)
const input=(path:string,text:string):IndustryFileInput=>({path,size:bytes(text).byteLength,read:async()=>bytes(text)})
const metadata={id:'skill-report',title:'报告撰写',version:'0.1.0',categories:['writing','review']}

test('读取单一目录下的 SKILL.md 与附件，并将完整元数据和文件摘要固定为内容身份',async()=>{
 const base=[input('report/SKILL.md','# 报告\n\n按证据写作。'),input('report/examples/outline.md','示例')]
 const skill=await readAtomicSkill(base,metadata)
 assert.equal(skill.entryPath,'report/SKILL.md')
 assert.equal(skill.text,'# 报告\n\n按证据写作。')
 assert.deepEqual(skill.files.map(file=>file.path),['report/SKILL.md','report/examples/outline.md'])
 assert.match(skill.hash,/^[a-f0-9]{64}$/)
 const changedFile=await readAtomicSkill([...base,input('report/scripts/check.js','export {}')],metadata)
 const changedMetadata=await readAtomicSkill(base,{...metadata,title:'报告校对'})
 assert.notEqual(changedFile.hash,skill.hash)
 assert.notEqual(changedMetadata.hash,skill.hash)
})

test('拒绝不确定入口、无效文本和无效原子元数据',async()=>{
 const root=[input('skill/SKILL.md','正文')]
 await assert.rejects(()=>readAtomicSkill([],metadata),/SKILL\.md/)
 await assert.rejects(()=>readAtomicSkill([...root,input('other/SKILL.md','另一份')],metadata),/SKILL\.md|目录/)
 await assert.rejects(()=>readAtomicSkill([input('skill/SKILL.md','')],metadata),/不能为空/)
 await assert.rejects(()=>readAtomicSkill(root,{...metadata,id:'bad/id'}),/标识/)
 await assert.rejects(()=>readAtomicSkill(root,{...metadata,version:'latest'}),/版本/)
 await assert.rejects(()=>readAtomicSkill(root,{...metadata,categories:['writing','writing']}),/分类/)
 const invalid=new Uint8Array([0xff])
 await assert.rejects(()=>readAtomicSkill([{path:'skill/SKILL.md',size:1,read:async()=>invalid}],metadata),/UTF-8/)
 await assert.rejects(()=>readAtomicSkill([input('../SKILL.md','正文')],metadata),/路径/)
})

test('分类可为空，且无效元数据不会读取目录文件',async()=>{
 const uncategorized=await readAtomicSkill([input('skill/SKILL.md','正文')],{...metadata,categories:[]})
 assert.deepEqual(uncategorized.categories,[])
 let reads=0
 const unread:IndustryFileInput={path:'skill/SKILL.md',size:2,read:async()=>{reads++;return bytes('正文')}}
 await assert.rejects(()=>readAtomicSkill([unread],{...metadata,id:'bad/id'}),/标识/)
 assert.equal(reads,0)
})

test('独立 Skill 可附着标题本地化元数据但不改写标题或正文',async()=>{
 const localized={title:{original:'报告撰写',defaultLocale:'en',locales:{en:'Report writing','zh-Hant':'報告撰寫','zh-TW':{fallback:'zh-Hant' as const}}}}
 const skill=await readAtomicSkill([input('skill/SKILL.md','作者正文')],{...metadata,localized})
 assert.deepEqual(skill.localized,localized)
 assert.equal(skill.title,'报告撰写');assert.equal(skill.text,'作者正文')
 await assert.rejects(()=>readAtomicSkill([input('skill/SKILL.md','作者正文')],{...metadata,localized:{title:{...localized.title,original:'另一标题'}}}),/稳定原文/)
})


test('目录静态元数据只带入标准名称，原文件与锁定内容不改变',async()=>{
 const text='---\r\nname: "import-review"\r\ndescription: 核对提供的资料。\r\n---\r\n原始正文 🐿️\r\n'
 const files=[input('review/SKILL.md',text),input('review/scripts/check.js','throw Error("must not run")')]
 assert.equal(typeof atomic.suggestAtomicSkillMetadata,'function','标准SKILL目录应能静态带入名称')
 assert.deepEqual(await atomic.suggestAtomicSkillMetadata(files),{id:'import-review',title:'import-review'})
 const content=await readAtomicSkill(files,{id:'import-review',title:'import-review',version:'1.0.0',categories:[]})
 assert.equal(content.text,text);assert.deepEqual(content.files.find(file=>file.path.endsWith('SKILL.md'))?.bytes,bytes(text))
 assert.equal(await atomic.suggestAtomicSkillMetadata([input('review/SKILL.md','# 原有无frontmatter技能')]),undefined,'旧无元数据目录仍由用户明确填写')
 assert.equal(await atomic.suggestAtomicSkillMetadata([input('review/SKILL.md','---\nname: [invalid]\n---\n正文')]),undefined,'不猜测不支持的元数据值')
 await assert.rejects(()=>atomic.suggestAtomicSkillMetadata([input('a/SKILL.md','正文'),input('b/SKILL.md','正文')]),/SKILL\.md|目录/)
})

test('元数据校验错误标明实际字段，界面据此展开对应输入',()=>{
 const base={id:'ok',title:'ok',version:'1.0.0',categories:[]}
 const cases:readonly (readonly [Partial<atomic.AtomicSkillMetadata>,atomic.AtomicSkillMetadataField])[]=[[{id:'bad id'},'id'],[{id:''},'id'],[{title:' '},'title'],[{version:'abc'},'version'],[{version:''},'version'],[{categories:['a','a']},'categories'],[{categories:['']},'categories']]
 for(const [patch,field] of cases){
  assert.throws(()=>atomic.validateAtomicSkillMetadata({...base,...patch}),(error:unknown)=>error instanceof atomic.AtomicSkillMetadataError&&error.field===field,JSON.stringify(patch))
 }
 assert.throws(()=>atomic.validateAtomicSkillMetadata({...base,localized:{title:{original:'另一标题',defaultLocale:'en',locales:{en:'Other'}}}}),(error:unknown)=>error instanceof atomic.AtomicSkillMetadataError&&error.field==='title')
})
