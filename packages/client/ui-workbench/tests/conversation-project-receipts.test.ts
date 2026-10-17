import test from 'node:test'
import assert from 'node:assert/strict'
import {conversationProjectReceipt} from '../src/client/conversation-project-receipts.ts'
const id='11111111-1111-4111-8111-111111111111',now='2026-10-12T00:00:00.000Z'
const project={id,ownerId:'local:teloa-owner',version:2,scope:'general',title:'发布准备',goal:'收齐发布材料',dueDate:null,state:'archived',links:[],references:[],createdAt:now,updatedAt:now}
const receipt={schema:'teloa.project-result/v1',sessionId:'original-session',operation:'teloa_projects_change',project,projectId:id,projectVersion:2,projectTitle:project.title,scope:'general'}

test('可信项目回执返回原项目入口及业务范围，归档仍可打开，展示只使用标题',()=>{
 assert.deepEqual(conversationProjectReceipt(receipt,'original-session'),{kind:'project',id,title:project.title,revision:'2:'+now+':archived',scope:'general'})
})

test('不接受外本人、其他会话、伪造摘要、缺失来源和未知操作的项目回执',()=>{
 for(const value of [{...receipt,sessionId:'other'},{...receipt,sessionId:undefined},{...receipt,project:{...project,ownerId:'other'}},{...receipt,projectTitle:'伪造标题'},{...receipt,projectVersion:3},{...receipt,scope:'SOC'},{...receipt,projectId:'22222222-2222-4222-8222-222222222222'},{...receipt,operation:'teloa_projects_execute'},{...receipt,schema:'teloa.project-candidates/v1'}])assert.equal(conversationProjectReceipt(value,'original-session'),undefined)
})
