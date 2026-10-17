import assert from 'node:assert/strict'
import test from 'node:test'
import {industryTeamSeed,matchingIndustryTeam,findIndustryTeam} from '../src/client/industry-team.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {GroupSnapshot} from '../src/client/group-api.ts'
const load={id:'load-original',status:'active',contentId:'content-original',contentHash:'a'.repeat(64),mappingHash:'b'.repeat(64),templateTitle:'Marketing',space:{scope:'general'},items:[{kind:'role',instanceId:'lead-item',status:'pending-adapter'},{kind:'role',instanceId:'writer-item',status:'pending-adapter'},{kind:'role',instanceId:'desk-item',status:'pending-adapter'}],relations:[{kind:'role-coordination',from:'lead-item',to:'writer-item'},{kind:'role-coordination',from:'lead-item',to:'desk-item'}]} as IndustryLoadRecord
const roles=[{itemInstanceId:'lead-item',roleId:'lead',state:'paused'},{itemInstanceId:'writer-item',roleId:'writer',state:'paused'},{itemInstanceId:'desk-item',roleId:'desk',state:'paused'}]
const seed=industryTeamSeed(load,roles)!
const snapshot={group:{id:'group-original',name:'Marketing',scope:'general',archived:false,source:seed.source,coordinatorRoleId:'lead'},members:[{roleId:null},{roleId:'lead'},{roleId:'writer'},{roleId:'desk'}]} as GroupSnapshot

test('原三位暂停员工与协调关系进入创建草稿，原source身份不可从同名模板猜测',()=>{
 assert.deepEqual(seed,{name:'Marketing',scope:'general',memberRoleIds:['lead','writer','desk'],coordinatorRoleId:'lead',source:{kind:'industry-load',loadId:load.id,contentId:load.contentId,contentHash:load.contentHash,mappingHash:load.mappingHash}})
 assert.equal(industryTeamSeed(load,roles.slice(1)),undefined)
 assert.equal(industryTeamSeed(load,[...roles,{...roles[0]!}]),undefined)
 assert.equal(industryTeamSeed(load,roles.map(role=>role.roleId==='lead'?{...role,state:'retired'}:role)),undefined)
 const none=industryTeamSeed({...load,relations:[]},roles)!
 assert.equal(none.coordinatorRoleId,undefined);assert.equal(none.memberRoleIds.length,3)
 assert.equal(industryTeamSeed({...load,status:'unloaded'},roles),undefined)
})

test('刷新恢复只接受同固定来源、完整成员及原协调者的真实群；不以同名或其他source覆盖',async()=>{
 assert.equal(matchingIndustryTeam(snapshot,seed),true)
 for(const group of [{...snapshot.group,archived:true},{...snapshot.group,coordinatorRoleId:'writer'},{...snapshot.group,source:{...seed.source,contentId:'other'}},{...snapshot.group,source:{...seed.source,mappingHash:'c'.repeat(64)}}])assert.equal(matchingIndustryTeam({...snapshot,group},seed),false)
 assert.equal(matchingIndustryTeam({...snapshot,members:snapshot.members.slice(1)},seed),true,'self 由正式 GroupApi decoder 独立保证，不算员工')
 assert.equal(matchingIndustryTeam({...snapshot,members:snapshot.members.slice(0,3)},seed),false)
 let gets=0
 const api={list:async()=>({items:[{...snapshot.group,source:{...seed.source,contentId:'other'}},snapshot.group]}),get:async(id:string)=>{gets++;assert.equal(id,snapshot.group.id);return snapshot}}
 assert.equal((await findIndustryTeam(api as never,seed))?.group.id,snapshot.group.id);assert.equal(gets,1)
 assert.equal(await findIndustryTeam({...api,list:async()=>({items:[{...snapshot.group,source:undefined}]})} as never,seed),undefined)
 await assert.rejects(findIndustryTeam({...api,list:async()=>({items:[snapshot.group,snapshot.group]})} as never,seed),/ambiguous/)
 await assert.rejects(findIndustryTeam({...api,get:async()=>({...snapshot,members:snapshot.members.slice(0,3)})} as never,seed),/changed/)
})

test('升级团队只沿精确 carriedFrom 复用原暂停岗位，当前实例优先；歧义和当前失败不回退',()=>{
 const upgraded={...load,id:'successor-load',contentId:'successor-content',mappingHash:'c'.repeat(64),items:load.items.map(item=>({...item,instanceId:'new-'+item.instanceId,carriedFrom:item.instanceId})),relations:load.relations.map(link=>({...link,from:'new-'+link.from,to:'new-'+link.to}))}
 const original=roles.map(role=>({...role,loadId:load.id}))
 assert.deepEqual(industryTeamSeed(upgraded,original)?.memberRoleIds,['lead','writer','desk'])
 assert.equal(industryTeamSeed(upgraded,original)?.source.loadId,'successor-load')
 assert.equal(industryTeamSeed(upgraded,original)?.coordinatorRoleId,'lead')
 assert.equal(industryTeamSeed(upgraded,[...original,{...original[0]!}]),undefined)
 assert.equal(industryTeamSeed(upgraded,[...original,{loadId:upgraded.id,itemInstanceId:'new-lead-item',state:'failed'}]),undefined,'当前实例失败不能借旧 active/paused 行绕过')
 assert.equal(industryTeamSeed(upgraded,[...original,{loadId:'unrelated',itemInstanceId:'new-lead-item',state:'paused',roleId:'other'}]),undefined)
 assert.equal(industryTeamSeed(upgraded,[...original,{loadId:upgraded.id,itemInstanceId:'new-lead-item',state:'paused',roleId:'new-lead'}])?.coordinatorRoleId,'new-lead')
 assert.equal(industryTeamSeed(upgraded,[{loadId:'unrelated',itemInstanceId:'unrelated',roleId:'same-name-lead',state:'active'},...original.slice(1)]),undefined)
})
