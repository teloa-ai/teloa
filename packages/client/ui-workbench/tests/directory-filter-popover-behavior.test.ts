import test from 'node:test'
import assert from 'node:assert/strict'
import {directoryFilterPosition,focusFirstDirectoryFilterControl,handleDirectoryFilterEscape,restoreDirectoryFilterFocus} from '../src/client/directory-filter-popover.ts'

test('打开筛选后将焦点送入首个可操作控件',()=>{
  let focused=0
  const control={focus:()=>{focused++}}
  const panel={querySelector:()=>control}
  assert.equal(focusFirstDirectoryFilterControl(panel),true)
  assert.equal(focused,1)
})

test('Escape 关闭筛选、阻止继续传播并把焦点还给触发按钮',async()=>{
  const calls:string[]=[]
  const event={key:'Escape',preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop')}
  const trigger={focus:()=>calls.push('focus')}
  assert.equal(handleDirectoryFilterEscape(event,()=>calls.push('close')),true)
  restoreDirectoryFilterFocus(trigger)
  await Promise.resolve()
  assert.deepEqual(calls,['prevent','stop','close','focus'])
})

test('其他按键不关闭筛选',()=>{
  let closed=false
  assert.equal(handleDirectoryFilterEscape({key:'Enter',preventDefault(){},stopPropagation(){}},()=>{closed=true}),false)
  assert.equal(closed,false)
})

test('目录菜单优先下方、贴近入口，触及窗口右边时不横溢',()=>{
  assert.deepEqual(directoryFilterPosition({right:1000,top:40,bottom:72},244,180,900,700),{left:648,top:78,maxHeight:180})
})

test('窗口底部菜单向上翻转，长内容按可用空间滚动',()=>{
  const position=directoryFilterPosition({right:320,top:240,bottom:272},244,560,900,300)
  assert.deepEqual(position,{left:76,top:8,maxHeight:226})
})

test('缩小窗口或滚动后入口移出视口，菜单仍受视口边界约束',()=>{
  for(const anchor of [{right:100,top:900,bottom:932},{right:100,top:-80,bottom:-48}]){
    const box=directoryFilterPosition(anchor,244,400,900,300)
    assert.ok(box.left>=8&&box.left+244<=892)
    assert.ok(box.top>=8&&box.top+box.maxHeight<=292)
  }
})
