import assert from 'node:assert/strict'
import test from 'node:test'
import {detailDensityCopy,isLongDetailText,longTextChars,longTextLines,quietTerminalStatus} from '../src/client/detail-density-copy.ts'

test('详情分层文案三语定稿：简体、繁体、英文各有独立文字，其余语言回退英文',()=>{
 const keys=['goalExpand','goalCollapse','properties','planMore','planMoreAria'] as const
 for(const key of keys){
  const zh=detailDensityCopy('zh-CN',key),hant=detailDensityCopy('zh-Hant',key),en=detailDensityCopy('en',key)
  assert.ok(zh&&hant&&en,key)
  assert.notEqual(zh,en,key)
  assert.equal(detailDensityCopy('ja',key),en,'未定稿语言回退英文：'+key)
 }
 assert.equal(detailDensityCopy('zh-Hant','goalExpand'),'展開全文')
 assert.equal(detailDensityCopy('zh','planMore'),'更多信息')
})

test('长目标判定只看长度与行数；短目标不出现展开按钮',()=>{
 assert.equal(isLongDetailText('核对本周资料'),false)
 assert.equal(isLongDetailText('字'.repeat(longTextChars)),false)
 assert.equal(isLongDetailText('字'.repeat(longTextChars+1)),true)
 assert.equal(isLongDetailText(Array.from({length:longTextLines},(_,i)=>'第'+i+'行').join('\n')),false)
 assert.equal(isLongDetailText(Array.from({length:longTextLines+1},(_,i)=>'第'+i+'行').join('\n')),true)
})

test('只有无待办、无执行控件、无服务端关注的取消或完成任务才收起状态卡；审批、失败、等待输入照常突出',()=>{
 const base={needs:[] as string[],hasControl:false,hasAttention:false}
 assert.equal(quietTerminalStatus({...base,state:'cancelled'}),true)
 assert.equal(quietTerminalStatus({...base,state:'completed'}),true)
 for(const state of ['ready','running','paused','blocked'])assert.equal(quietTerminalStatus({...base,state}),false,state)
 assert.equal(quietTerminalStatus({...base,state:'completed',needs:['review']}),false,'待复核不收起')
 assert.equal(quietTerminalStatus({...base,state:'cancelled',needs:['approval']}),false,'待审批不收起')
 assert.equal(quietTerminalStatus({...base,state:'completed',hasAttention:true}),false,'执行失败等服务端关注不收起')
 assert.equal(quietTerminalStatus({...base,state:'cancelled',hasControl:true}),false,'运行面仍有控件时不收起')
})
