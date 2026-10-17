import test from 'node:test'
import assert from 'node:assert/strict'
import {initialGroupPanel,readGroupPanelPreference,readGroupPanelViewport,writeGroupPanelPreference} from '../src/client/group-panel-preference.ts'

test('旧群开始面板恢复为工作概览，保留本群成员页签且不改原记录',()=>{
 const raw=JSON.stringify({schema:'teloa.group-panel/v1',kind:'start',tab:'members'})
 let written=0
 const storage={getItem:()=>raw,setItem:()=>written++,removeItem:()=>written++}
 assert.deepEqual(readGroupPanelPreference(storage,'original-group'),{schema:'teloa.group-panel/v1',kind:'overview',tab:'members'})
 assert.equal(written,0)
})

test('只接收已知面板和页签，旧格式、损坏和存储异常不影响群加载',()=>{
 let raw:string|null=null
 const storage={getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value},removeItem:()=>{raw=null}}
 for(const invalid of ['{','null',JSON.stringify({schema:'old',kind:'overview',tab:'work'}),JSON.stringify({schema:'teloa.group-panel/v1',kind:'settings',tab:'work'}),JSON.stringify({schema:'teloa.group-panel/v1',kind:'overview',tab:'unknown'})]){
  raw=invalid
  assert.equal(readGroupPanelPreference(storage,'group'),undefined)
 }
 writeGroupPanelPreference(storage,'group',{kind:'materials',tab:'work'})
 assert.deepEqual(readGroupPanelPreference(storage,'group'),{schema:'teloa.group-panel/v1',kind:'materials',tab:'work'})
 writeGroupPanelPreference(storage,'group',undefined)
 assert.equal(readGroupPanelPreference(storage,'group'),undefined)
 const unavailable={getItem:()=>{throw Error('denied')},setItem:()=>{throw Error('denied')},removeItem:()=>{throw Error('denied')}}
 assert.equal(readGroupPanelPreference(unavailable,'group'),undefined)
 assert.doesNotThrow(()=>writeGroupPanelPreference(unavailable,'group',{kind:'overview',tab:'members'}))
 assert.doesNotThrow(()=>writeGroupPanelPreference(unavailable,'group',undefined))
})

test('本人主动关闭与此前无偏好分开保存；旧偏好照常恢复',()=>{
 let raw:string|null=null
 const storage={getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value},removeItem:()=>{raw=null}}
 writeGroupPanelPreference(storage,'group',{kind:'closed',tab:'members'})
 assert.deepEqual(readGroupPanelPreference(storage,'group'),{schema:'teloa.group-panel/v1',kind:'closed',tab:'members'})
 assert.deepEqual(initialGroupPanel(readGroupPanelPreference(storage,'group'),'wide'),{open:false,kind:'overview',tab:'members'})
 assert.deepEqual(initialGroupPanel(undefined,'wide'),{open:true,kind:'overview',tab:'work'},'宽屏无偏好默认进入工作概览')
 assert.deepEqual(initialGroupPanel(undefined,'regular'),{open:false,kind:'overview',tab:'work'},'打开会挤掉目录的宽度不自动展开')
 assert.deepEqual(initialGroupPanel(undefined,'narrow'),{open:false,kind:'overview',tab:'work'})
 for(const kind of ['materials','members','overview'] as const){
  assert.deepEqual(initialGroupPanel({schema:'teloa.group-panel/v1',kind,tab:'work'},'regular'),{open:true,kind,tab:'work'},'已保存的选择优先于宽度默认')
  assert.deepEqual(initialGroupPanel({schema:'teloa.group-panel/v1',kind,tab:'work'},'narrow'),{open:false,kind,tab:'work'},'窄窗不自动盖住讨论，也不改写偏好')
 }
 raw=JSON.stringify({schema:'teloa.group-panel/v1',kind:'start',tab:'work'})
 assert.deepEqual(initialGroupPanel(readGroupPanelPreference(storage,'group'),'wide'),{open:true,kind:'overview',tab:'work'})
})

test('视口按群页断点判断，无窗口或查询异常按常规宽度处理',()=>{
 const view=(width:number)=>({matchMedia:(query:string)=>({matches:query.includes('min-width')?width>=Number(query.match(/\d+/)![0]):width<=Number(query.match(/\d+/)![0])})})
 assert.equal(readGroupPanelViewport(view(1600)),'wide')
 assert.equal(readGroupPanelViewport(view(1381)),'wide')
 assert.equal(readGroupPanelViewport(view(1380)),'regular')
 assert.equal(readGroupPanelViewport(view(963)),'regular')
 assert.equal(readGroupPanelViewport(view(740)),'narrow')
 assert.equal(readGroupPanelViewport(undefined),'regular')
 assert.equal(readGroupPanelViewport({matchMedia:()=>{throw Error('denied')}}),'regular')
})
