import test from 'node:test'
import assert from 'node:assert/strict'
import {focusFirstDirectoryFilterControl,handleDirectoryFilterEscape,restoreDirectoryFilterFocus} from '../src/client/directory-filter-popover.ts'

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
