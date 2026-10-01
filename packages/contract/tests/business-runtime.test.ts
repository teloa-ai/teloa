import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import * as contract from '../src/index.ts'

test('运行状态区分受管正版本与固定 legacy 状态，拒绝越界与额外字段',()=>{
 const managed={scope:'SOC',managed:true,syncEnabled:false,revision:1}
 const legacy={scope:'AppSec',managed:false,syncEnabled:true,revision:0}
 assert.deepEqual(contract.readBusinessRuntimeState(managed),managed)
 assert.deepEqual(contract.readBusinessRuntimeState(legacy),legacy)
 for(const value of [
  {...managed,scope:'general'},{...managed,scope:'bad scope'},{...managed,managed:'true'},
  {...managed,syncEnabled:1},{...managed,revision:0},{...managed,revision:1.5},
  {...managed,revision:Number.MAX_SAFE_INTEGER+1},{...managed,extra:true},
  {...legacy,syncEnabled:false},{...legacy,revision:1},{scope:'SOC'},null,
 ])assert.throws(()=>contract.readBusinessRuntimeState(value),{code:'teloa/invalid-input'})
})

test('运行启停入参严格键集与 UUID、范围、布尔、乐观版本',()=>{
 const input={scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID().toUpperCase()}
 assert.deepEqual(contract.readBusinessRuntimeSetSyncInput(input),{...input,requestId:input.requestId.toLowerCase()})
 for(const value of [
  {...input,scope:'general'},{...input,scope:'业务'},{...input,requestId:'not-uuid'},
  {...input,enabled:'true'},{...input,expectedRevision:0},{...input,expectedRevision:-1},
  {...input,expectedRevision:1.5},{...input,expectedRevision:Infinity},
  {...input,extra:true},{scope:'SOC'},null,
 ])assert.throws(()=>contract.readBusinessRuntimeSetSyncInput(value),{code:'teloa/invalid-input'})
})
