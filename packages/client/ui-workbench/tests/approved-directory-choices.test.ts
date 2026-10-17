import test from 'node:test'
import assert from 'node:assert/strict'
import {sortRoster} from '../src/client/team-roster-grouping.ts'
import {planGoalDraft} from '../src/client/continuous-persistence.ts'
import type {PlanFields} from '../src/client/continuous-preview.ts'
import {settingsEntryGroup} from '../src/client/settings-navigation.ts'

test('名录按显示姓名或岗位排序，跨业务身份只出现一次，不改写输入',()=>{
 const sort=sortRoster
 const a={id:'a',name:'Employee 10',duty:'销售',scopes:['general','SOC']},b={id:'b',name:'Employee 2',duty:'分析'},twin={id:'t',name:'我',duty:'协调'}
 const input=[a,twin,b,a],name=(row:{id:string;name:string})=>row.id==='t'?'Employee 1':row.name
 assert.deepEqual(sort(input,'name','en',name).map(row=>row.id),['t','b','a'])
 assert.deepEqual(sort(input,'duty','zh-CN',name).map(row=>row.id),['b','a','t'])
 assert.deepEqual(input,[a,twin,b,a])
 assert.equal(sort(input,'name','en',name)[2],a)
})

test('自然语言入口只准备目标草稿，已有时间、负责人和权限不被重写',()=>{
 const prepare=planGoalDraft
 const fields:PlanFields={title:'旧标题',goal:'旧目标',scope:'SOC',roleId:'a',dataScope:'原资料范围',delivery:'原交付方式',notificationPolicy:'silent',trigger:{kind:'schedule',cadence:'weekly',time:'18:30',timezone:'UTC',weekday:3}}
 const next=prepare('  整理客户反馈\n遇到紧急情况告诉我  ',fields)
 assert.ok(next,'非空目标必须生成计划草稿')
 assert.equal(next.goal,'整理客户反馈\n遇到紧急情况告诉我')
 assert.equal(next.title,'整理客户反馈')
 assert.deepEqual({...next,title:fields.title,goal:fields.goal},fields)
 assert.equal(prepare('   ',fields),null)
 const longGoal=prepare('x'.repeat(130),fields)
 assert.ok(longGoal,'长目标必须生成计划草稿')
 assert.equal(longGoal.title.length,120)
 assert.equal('enabled' in next,false)
 assert.equal('authorized' in next,false)
})

test('设置按用户目的分组，原生和未知插件入口保持可达',()=>{
 const group=settingsEntryGroup
 assert.equal(group('general'),'preferences')
 for(const id of ['models','teloa-local-models','teloa-credential-store','teloa-voice-service'])assert.equal(group(id),'models')
 for(const id of ['teloa-workspaces','teloa-native-panels','teloa-im-channels'])assert.equal(group(id),'connections')
 for(const id of ['teloa-auto-dream','agent-presets'])assert.equal(group(id),'work')
 assert.equal(group('plugins'),'advanced')
 assert.equal(group('new-third-party-setting'),'advanced')
 assert.equal(group('teloa-about'),'about')
})
