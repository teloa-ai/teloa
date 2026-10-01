import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'

registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})

const {pageCreateAtomicSkillContent,readPageCreateAtomicSkillBody}=await import('../src/client/page-create-skill-content.ts')
const base64=(text:string)=>Buffer.from(text,'utf8').toString('base64')

test('会话 Skill 草案在确认时恢复为既有原子导入输入，并重新固定文件摘要',async()=>{
 const body={id:'meeting-followup',title:'会议待办整理',version:'1.0.0',categories:['productivity'],files:[
  // 1d9abe2 起草案读取器会核对 SKILL.md frontmatter：name 须与草案 id 相同且满足 DSH 的 isSkillName 规则。
  {path:'meeting-followup/SKILL.md',base64:base64('---\nname: meeting-followup\ndescription: 整理会议记录为待办。\n---\n\n# 会议待办\n\n整理会议记录。')},
  {path:'meeting-followup/references/style.md',base64:base64('使用简洁中文。')},
 ]}
 assert.deepEqual(readPageCreateAtomicSkillBody(body),body)
 const content=await pageCreateAtomicSkillContent(body)
 assert.equal(content.id,'meeting-followup')
 assert.equal(content.entryPath,'meeting-followup/SKILL.md')
 assert.equal(content.files.length,2)
 assert.match(content.hash,/^[0-9a-f]{64}$/)
 assert.equal(content.text,'---\nname: meeting-followup\ndescription: 整理会议记录为待办。\n---\n\n# 会议待办\n\n整理会议记录。')
})

test('会话 Skill 草案即使在确认前被篡改，也不能绕过入口目录与 Base64 校验',async()=>{
 await assert.rejects(pageCreateAtomicSkillContent({id:'meeting-followup',title:'会议待办整理',version:'1.0.0',categories:[],files:[{path:'../SKILL.md',base64:base64('x')}]}))
 await assert.rejects(pageCreateAtomicSkillContent({id:'meeting-followup',title:'会议待办整理',version:'1.0.0',categories:[],files:[{path:'meeting-followup/SKILL.md',base64:'bad'}]}))
})
