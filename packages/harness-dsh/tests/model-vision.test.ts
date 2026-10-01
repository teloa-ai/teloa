import test from 'node:test'
import assert from 'node:assert/strict'
import {readModelVision,visionAllowsImages} from '../src/model-vision.ts'

test('三态各有一条正例：声明含 image 为支持，声明不含 image 为不支持，字段缺失为查不到',()=>{
 assert.equal(readModelVision({provider:'p',id:'m',name:'m',inputModalities:['text','image']}),'supported')
 assert.equal(readModelVision({provider:'p',id:'m',name:'m',inputModalities:['text']}),'unsupported')
 assert.equal(readModelVision({provider:'p',id:'m',name:'m'}),'unknown')
})

test('能力源抛错时按查不到处理，不折成不支持',async()=>{
 const broken=async()=>{throw Error('探针：能力源不可用')}
 const vision=readModelVision(await broken().catch(()=>undefined))
 assert.equal(vision,'unknown')
 // 折成 unsupported 会让有视觉的模型也被打成无视觉；这条断言守的就是三条路不合并。
 assert.notEqual(vision,'unsupported')
})

test('读不成形的值一律查不到，不猜成支持也不猜成不支持',()=>{
 for(const value of [undefined,null,'supported',42,[],{inputModalities:null},{inputModalities:'image'}])
  assert.equal(readModelVision(value),'unknown')
})

test('只有支持才允许发图',()=>{
 assert.equal(visionAllowsImages('supported'),true)
 assert.equal(visionAllowsImages('unsupported'),false)
 assert.equal(visionAllowsImages('unknown'),false)
})
