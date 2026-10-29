import test from 'node:test'
import assert from 'node:assert/strict'
import {isResourceAdoptionInput,type ResourceAdoptionInput} from '../src/resource-adoption.ts'
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`
const input:ResourceAdoptionInput={requestId:id(1),targetScope:'business-soc-1',resources:[{id:id(2),version:1,sourceVersion:'a'.repeat(64)}]}
test('业务资料采用只接受请求身份、单个目标业务及最多30个固定版本；拒绝正文和主体注入',()=>{
 assert.equal(isResourceAdoptionInput(input),true)
 assert.equal(isResourceAdoptionInput({...input,resources:Array.from({length:30},(_,n)=>({...input.resources[0]!,id:id(n+2)}))}),true)
 for(const value of [{...input,ownerId:'other'},{...input,markdown:'forged'},{...input,scopeIds:['soc']},{...input,targetScope:'general'},{...input,targetScope:''},{...input,resources:[]},{...input,resources:[input.resources[0],input.resources[0]]},{...input,resources:[{...input.resources[0],version:0}]},{...input,resources:[{...input.resources[0],sourceVersion:'bad'}]},{...input,resources:Array.from({length:31},(_,n)=>({...input.resources[0],id:id(n+2)}))}])assert.equal(isResourceAdoptionInput(value),false)
})
