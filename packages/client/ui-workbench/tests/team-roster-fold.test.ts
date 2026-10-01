import assert from 'node:assert/strict'
import test from 'node:test'
import {ROSTER_FOLD_LIMIT, ROSTER_FOLD_MAX_CHARS, readRosterFold, rosterFoldToggle, rosterSectionOpen, writeRosterFold, type RosterFoldState} from '../src/client/team-roster-fold.ts'

const empty:RosterFoldState={toggled:[]}
const open=(overrides:Partial<Parameters<typeof rosterSectionOpen>[0]>)=>rosterSectionOpen({sectionId:'general',members:3,searching:false,focused:false,fold:empty,...overrides})

test('成员数 ≤6 默认展开，>6 默认折叠',()=>{
  assert.equal(open({members:ROSTER_FOLD_LIMIT}),true)
  assert.equal(open({members:ROSTER_FOLD_LIMIT+1}),false)
})

test('手动切换后覆盖默认，两个方向都要',()=>{
  const toggledOn=rosterFoldToggle(empty,'general')
  // 默认展开（members<=6）的分区，切换一次后应变成折叠。
  assert.equal(open({members:3,fold:toggledOn}),false)
  // 默认折叠（members>6）的分区，切换一次后应变成展开。
  assert.equal(open({members:10,fold:toggledOn}),true)
})

test('searching===true 时无视记忆恒展开',()=>{
  const toggledOn=rosterFoldToggle(empty,'general')
  assert.equal(open({members:10,fold:toggledOn,searching:false}),true)
  assert.equal(open({members:3,fold:toggledOn,searching:true}),true)
  assert.equal(open({members:10,fold:empty,searching:true}),true)
})

test('尚未消费的跳转聚焦可展开已折叠分区',()=>{
  assert.equal(open({members:10,fold:empty,focused:true}),true)
  const toggledOn=rosterFoldToggle(empty,'general')
  assert.equal(open({members:3,fold:toggledOn,focused:true}),true)
})

test('聚焦消费后可手动折起，再次从业务跳转又能展开',()=>{
  // 跳转时将默认折叠的大分区展开并记住，消费聚焦信号后尊重手动选择。
  const expanded=rosterFoldToggle(empty,'general')
  assert.equal(open({members:10,fold:expanded,focused:false}),true)
  const collapsed=rosterFoldToggle(expanded,'general')
  assert.equal(open({members:10,fold:collapsed,focused:false}),false)
  assert.equal(open({members:10,fold:collapsed,focused:true}),true)
})

test('readRosterFold 对 undefined、空串、含非法字符的串都回 {toggled:[]}',()=>{
  assert.deepEqual(readRosterFold(undefined),{toggled:[]})
  assert.deepEqual(readRosterFold(''),{toggled:[]})
  assert.deepEqual(readRosterFold('general\x1fSOC'),{toggled:['general','SOC']})
  assert.deepEqual(readRosterFold('general\x1f\x07bad'),{toggled:[]})
  assert.deepEqual(readRosterFold('\x00'),{toggled:[]})
})

test('rosterFoldToggle 把最近切换的挪到串尾',()=>{
  let fold=rosterFoldToggle(empty,'a')
  fold=rosterFoldToggle(fold,'b')
  assert.deepEqual(fold.toggled,['a','b'])
  // 再次切换 a：先移除（取消切换），不在尾部。
  fold=rosterFoldToggle(fold,'a')
  assert.deepEqual(fold.toggled,['b'])
  // 三次切换 a：重新加入，回到串尾。
  fold=rosterFoldToggle(fold,'a')
  assert.deepEqual(fold.toggled,['b','a'])
})

test('rosterFoldToggle 跳过含分隔符的范围标识，不写入记忆',()=>{
  const bad='general\x1fSOC'
  assert.deepEqual(rosterFoldToggle(empty,bad),empty)
})

test('writeRosterFold 串超 240 字时从串头丢起，保留最近的',()=>{
  let fold:RosterFoldState={toggled:[]}
  const ids=Array.from({length:40},(_,index)=>'scope-'+index)
  for(const id of ids)fold=rosterFoldToggle(fold,id)
  const written=writeRosterFold(fold,{status:'all',kind:'all'})
  assert.ok(written.length<=ROSTER_FOLD_MAX_CHARS)
  const parts=written.split('\x1f')
  // 最近切换的（数组末尾）必须保留。
  assert.ok(parts.includes(ids.at(-1)!))
  assert.ok(!parts.includes(ids[0]!))
  assert.deepEqual(readRosterFold(written).toggled,parts)
})

test('writeRosterFold 在 siblings 已经很大时整体返回空串',()=>{
  const fold=rosterFoldToggle(empty,'general')
  const hugeSiblings={status:'x'.repeat(9000),kind:'y'.repeat(9000)}
  assert.equal(writeRosterFold(fold,hugeSiblings),'')
})

test('writeRosterFold 正常情况下原样序列化',()=>{
  let fold=rosterFoldToggle(empty,'general')
  fold=rosterFoldToggle(fold,'SOC')
  assert.equal(writeRosterFold(fold,{status:'all',kind:'all'}),'general\x1fSOC')
})
