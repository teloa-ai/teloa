import test from 'node:test'
import assert from 'node:assert/strict'
import {reduceSkillUpgradeView,upgradeCandidates} from '../src/client/skill-upgrade-state.ts'
import type {SkillUpgradePreview} from '../src/client/skill-upgrade-api.ts'
import type {MarketItem} from '../src/client/market-preview.ts'
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
test('升级目标A→B→A按generation隔离，失败保留目标且可重试',()=>{
 let state=reduceSkillUpgradeView(undefined,{type:'target',contentId:a,generation:1})
 state=reduceSkillUpgradeView(state,{type:'target',contentId:b,generation:2})
 state=reduceSkillUpgradeView(state,{type:'target',contentId:a,generation:3})
 const preview={target:{source:{kind:'atomic',contentId:a}}} as SkillUpgradePreview
 assert.deepEqual(reduceSkillUpgradeView(state,{type:'result',generation:1,preview}),state)
 assert.deepEqual(reduceSkillUpgradeView(state,{type:'error',generation:2,error:'旧失败'}),state)
 state=reduceSkillUpgradeView(state,{type:'error',generation:3,error:'当前读取失败'})
 assert.equal(state.contentId,a);assert.equal(state.error,'当前读取失败')
 state=reduceSkillUpgradeView(state,{type:'target',contentId:a,generation:4})
 state=reduceSkillUpgradeView(state,{type:'result',generation:4,preview})
 assert.equal(state.preview,preview)
 state=reduceSkillUpgradeView(state,{type:'target',contentId:b,generation:5})
 assert.equal(state.preview,undefined)
})
test('候选仅来自真实保存原子Skill，以名称版本选择而非UUID输入',()=>{
 const row={id:'atomic-hash',kind:'skill',title:'复核Skill',version:'2.0.0',hash:'a'.repeat(64),source:{kind:'stored',contentId:a},contentStorage:{contentId:a,loaded:false,createdAt:'2026-09-12T00:00:00.000Z'}} as MarketItem
 const bad=[{...row,source:{kind:'builtin'}},{...row,kind:'bundle'},{...row,contentStorage:undefined},{...row,source:{kind:'stored',contentId:b}}] as MarketItem[]
 assert.deepEqual(upgradeCandidates([row,...bad],'复核'),[row])
 assert.deepEqual(upgradeCandidates([row],'2.0'),[row]);assert.deepEqual(upgradeCandidates([row],'无匹配'),[])
})
test('同一目标刷新失败保留先前成功预览并显式标错，重试不清目标',()=>{
 const preview={target:{source:{kind:'atomic',contentId:a}}} as SkillUpgradePreview
 let state=reduceSkillUpgradeView(undefined,{type:'target',contentId:a,generation:1})
 state=reduceSkillUpgradeView(state,{type:'result',generation:1,preview})
 state=reduceSkillUpgradeView(state,{type:'target',contentId:a,generation:2})
 state=reduceSkillUpgradeView(state,{type:'error',generation:2,error:'刷新不可用'})
 assert.equal(state.contentId,a);assert.equal(state.preview,preview);assert.equal(state.error,'刷新不可用')
})
