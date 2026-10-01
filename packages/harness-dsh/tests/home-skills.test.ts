import test from 'node:test'
import assert from 'node:assert/strict'
import {readHomeSkills} from '../src/home-skills.ts'
import type {SkillSummary} from '@deepseek-ai/dsh-skill'
test('首页只读取默认目录元数据，拒绝客户端路径与会话输入',async()=>{
 let reads=0
 const row={name:'test-skill',description:'目录说明',source:'project',provider:'filesystem',invocation:{userInvocable:true,modelInvocable:true}} satisfies SkillSummary
 const list=async()=>{reads++;return [{...row,content:'正文不应暴露'}]}
 for(const payload of [null,[],{cwd:'/other'},{sessionId:'other'}])await assert.rejects(()=>readHomeSkills(payload,list),/不接受/)
 assert.equal(reads,0)
 assert.deepEqual(await readHomeSkills({},list),[{name:row.name,description:row.description,source:row.source,provider:row.provider,userInvocable:true,modelInvocable:true}])
 assert.equal(reads,1)
})
