import test from 'node:test'
import assert from 'node:assert/strict'
import {groupTaskAssignees,savedMemberLabel,visibleSavedGroups} from '../src/client/saved-collaboration-state.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

const zh=((key:string)=>({'collaboration.message.self':'我','collaboration.message.selfRole':'本人','presentation.collaboration.formerRole':'历史岗位','presentation.collaboration.digitalEmployee':'AI 员工','role.state.active':'在岗','role.state.paused':'已暂停','role.state.retired':'已退役'}[key]??key)) as TeloaTranslate
const en=((key:string,params?:Readonly<Record<string,string|number>>)=>{
 const template={'collaboration.message.self':'Me','collaboration.message.selfRole':'You','presentation.collaboration.formerRole':'Former role','presentation.collaboration.digitalEmployee':'Digital employee','role.state.active':'Active','role.state.paused':'New tasks paused','role.state.retired':'Retired','presentation.collaboration.memberState':'{kind} · {state}'}[key]??key
 return template.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??`{${name}}`))
}) as TeloaTranslate

const at='2026-09-12T00:00:00.000Z'
const group=(id:string,changes:Partial<{name:string;scope:string;announcement:string;pinned:boolean;archived:boolean}>={})=>({id,ownerId:'self',version:1,name:'调查协作',scope:'SOC',announcement:'核对证据',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at,updatedAt:at,...changes})

test('已保存群目录只从服务端群记录筛选，不把示例或错误读取降级为空目录',()=>{
 const kept=group('11111111-1111-4111-8111-111111111111'),archived=group('22222222-2222-4222-8222-222222222222',{archived:true,name:'历史调查'}),other=group('33333333-3333-4333-8333-333333333333',{scope:'AppSec',name:'代码审计'})
 assert.deepEqual(visibleSavedGroups([kept,archived,other],'','SOC',false).map(item=>item.id),[kept.id])
 assert.deepEqual(visibleSavedGroups([kept,archived,other],'历史','all',true).map(item=>item.id),[archived.id])
})

test('已保存成员以服务端成员快照为准，未知岗位保留历史身份而不猜测当前岗位',()=>{
 const groupId='11111111-1111-4111-8111-111111111111',roleId='33333333-3333-4333-8333-333333333333'
 assert.deepEqual(savedMemberLabel(zh,{groupId,roleId:null,createdAt:at},[]),{name:'我',detail:'本人'})
 assert.deepEqual(savedMemberLabel(en,{groupId,roleId,createdAt:at},[]),{name:'Former role',detail:roleId})
})

test('已保存成员的动态岗位名保留原文，只翻译系统状态',()=>{
 const groupId='11111111-1111-4111-8111-111111111111',roleId='33333333-3333-4333-8333-333333333333'
 const role={id:roleId,name:'SOC 夜班',kind:'employee' as const,scopes:['SOC' as const],state:'paused' as const,version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
 assert.deepEqual(savedMemberLabel(en,{groupId,roleId,createdAt:at},[role]),{name:'SOC 夜班',detail:'Digital employee · New tasks paused'})
})

test('建群任务的负责人候选只留在岗数字员工，分身与历史成员都不列出',()=>{
 const groupId='11111111-1111-4111-8111-111111111111'
 const base={scopes:['SOC' as const],version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
 const employee={...base,id:'44444444-4444-4444-8444-444444444444',name:'SOC 研判员',kind:'employee' as const,state:'active' as const}
 const paused={...base,id:'55555555-5555-4555-8555-555555555555',name:'夜班研判员',kind:'employee' as const,state:'paused' as const}
 const twin={...base,id:'66666666-6666-4666-8666-666666666666',name:'我的分身',kind:'twin' as const,state:'active' as const}
 const members=[{groupId,roleId:null,createdAt:at},{groupId,roleId:employee.id,createdAt:at},{groupId,roleId:paused.id,createdAt:at},{groupId,roleId:twin.id,createdAt:at},{groupId,roleId:'77777777-7777-4777-8777-777777777777',createdAt:at}]
 assert.deepEqual(groupTaskAssignees(members,[employee,paused,twin],'SOC').map(role=>role.id),[employee.id])
})

test('建群任务的负责人候选按群业务范围过滤：不支持该范围的在岗同事也不列出',()=>{
 const groupId='11111111-1111-4111-8111-111111111111'
 const base={version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
 const socEmployee={...base,id:'44444444-4444-4444-8444-444444444444',name:'SOC 研判员',kind:'employee' as const,state:'active' as const,scopes:['SOC' as const]}
 const appsecEmployee={...base,id:'55555555-5555-4555-8555-555555555555',name:'审计岗',kind:'employee' as const,state:'active' as const,scopes:['AppSec' as const]}
 const members=[{groupId,roleId:null,createdAt:at},{groupId,roleId:socEmployee.id,createdAt:at},{groupId,roleId:appsecEmployee.id,createdAt:at}]
 assert.deepEqual(groupTaskAssignees(members,[socEmployee,appsecEmployee],'SOC').map(role=>role.id),[socEmployee.id])
})

// 2026-09-21 用户裁定：通用工作（general）对所有在岗正式同事开放，业务范围仍按岗位声明严格过滤（契约 roleSupportsScope）。
test('建群任务在通用工作范围下不按岗位业务声明过滤：任意在岗正式同事都是候选',()=>{
 const groupId='11111111-1111-4111-8111-111111111111'
 const base={version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
 const socEmployee={...base,id:'44444444-4444-4444-8444-444444444444',name:'SOC 研判员',kind:'employee' as const,state:'active' as const,scopes:['SOC' as const]}
 const members=[{groupId,roleId:null,createdAt:at},{groupId,roleId:socEmployee.id,createdAt:at}]
 assert.deepEqual(groupTaskAssignees(members,[socEmployee],'general').map(role=>role.id),[socEmployee.id])
})
