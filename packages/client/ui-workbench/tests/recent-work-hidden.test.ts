import test from 'node:test'
import assert from 'node:assert/strict'
import {createRecentWorkHiddenStore} from '../src/client/recent-work-hidden.ts'

test('隐藏名单使用版本化本机存储，写入后原样读回且不重复',()=>{
  const values=new Map<string,string>()
  const storage={
    getItem:(key:string)=>values.get(key)??null,
    setItem:(key:string,value:string)=>{values.set(key,value)},
    removeItem:(key:string)=>{values.delete(key)},
  }
  const store=createRecentWorkHiddenStore(storage)
  assert.deepEqual(store.read(),[])
  store.hide('sess-1')
  assert.deepEqual(store.read(),['sess-1'])
  store.hide('sess-1')
  assert.deepEqual(store.read(),['sess-1'],'重复隐藏同一条不产生重复项')
  store.hide('sess-2')
  assert.deepEqual(store.read(),['sess-1','sess-2'])
  assert.ok(values.get('teloa.recent-work-hidden.v1'),'必须写入独立于执行位置偏好的存储键')
})

test('读取拒绝畸形数据，不让损坏的本机记录抛出或污染名单',()=>{
  const values=new Map<string,string>()
  const storage={
    getItem:(key:string)=>values.get(key)??null,
    setItem:(key:string,value:string)=>{values.set(key,value)},
    removeItem:(key:string)=>{values.delete(key)},
  }
  const store=createRecentWorkHiddenStore(storage)
  values.set('teloa.recent-work-hidden.v1','not json')
  assert.deepEqual(store.read(),[])
  values.set('teloa.recent-work-hidden.v1','{"not":"an array"}')
  assert.deepEqual(store.read(),[])
  values.set('teloa.recent-work-hidden.v1',JSON.stringify(['sess-1',42,'',null]))
  assert.deepEqual(store.read(),['sess-1'],'只保留合法的字符串 id')
})

test('没有可用存储时安全回退为不持久隐藏，不抛出',()=>{
  const store=createRecentWorkHiddenStore(undefined)
  assert.deepEqual(store.read(),[])
  assert.doesNotThrow(()=>store.hide('sess-1'))
  assert.deepEqual(store.read(),[])
})

test('隐藏名单只是本地展示过滤，不提供归档或删除原始会话的能力',()=>{
  const values=new Map<string,string>()
  const storage={
    getItem:(key:string)=>values.get(key)??null,
    setItem:(key:string,value:string)=>{values.set(key,value)},
    removeItem:(key:string)=>{values.delete(key)},
  }
  const store=createRecentWorkHiddenStore(storage)
  assert.deepEqual(Object.keys(store).sort(),['hide','read'],'只暴露 read/hide，没有归档或删除等破坏性操作')
})
