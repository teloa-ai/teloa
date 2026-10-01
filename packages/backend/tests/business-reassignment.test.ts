import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessReassignmentSnapshot} from '@teloa/contract'
import {Pool} from 'pg'
import {BusinessReassignmentService,reserveInputFromReassignment} from '../src/work/business-reassignment.ts'
import {ConversationWorkService} from '../src/work/conversation-work.ts'
import {BusinessConversationBindingService} from '../src/work/business-conversation-bindings.ts'
const old='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222',role='33333333-3333-4333-8333-333333333333',newRole='44444444-4444-4444-8444-444444444444'
const snapshot:BusinessReassignmentSnapshot={instruction:{requestId:next,sessionId:'new-daily',messageId:'new-message',messageSeq:12,sourceText:'本人改派',selection:{oldRequestId:old,newRoleId:newRole,expectedNewRoleVersion:2}},oldSessionId:'old-daily',scope:'SOC',oldContext:{version:1,roleId:role},newContext:{version:3,roleId:newRole},oldTarget:{roleId:role,roleVersion:1,name:'原同事'},oldRoleCurrent:{version:4,state:'retired'},newTarget:{roleId:newRole,roleVersion:2,name:'新同事'},responsibility:{version:5,roleId:role},title:'原标题',goal:'原目标',sourceText:'原资料正文',reference:{scope:'SOC',type:'alert',id:'fixed',version:7,snapshotHash:'a'.repeat(64)},snapshotHash:'b'.repeat(64)}
test('reserve uses new native identity and original materials without rewriting instruction',()=>{
 const before=structuredClone(snapshot),input=reserveInputFromReassignment(snapshot)
 assert.deepEqual(input,{requestId:next,sessionId:'new-daily',messageId:'new-message',messageSeq:12,kind:'task',scope:'SOC',title:'原标题',goal:'原目标',sourceText:'原资料正文',roleId:newRole,expectedRoleVersion:2,responsibility:{version:5,roleId:role},reference:snapshot.reference})
 assert.deepEqual(snapshot,before);assert.notEqual(input.sourceText,snapshot.instruction.sourceText)
})
test('absent original text and reference remain absent',()=>{
 const {sourceText,reference,...minimal}=snapshot,input=reserveInputFromReassignment(minimal)
 assert.equal(Object.hasOwn(input,'sourceText'),false);assert.equal(Object.hasOwn(input,'reference'),false)
})
test('unmanaged omits responsibility while managed empty preserves zero selection',()=>{
 assert.equal(Object.hasOwn(reserveInputFromReassignment({...snapshot,responsibility:null}),'responsibility'),false)
 assert.deepEqual(reserveInputFromReassignment({...snapshot,responsibility:{version:0,roleId:null}}).responsibility,{version:0,roleId:null})
})
test('internal receipt reader rejects invalid identity before database or native access',async()=>{
 const unavailable=async():Promise<never>=>{throw Error('纯输入验证不得读取数据库或宿主')},real=new Pool(),pool=new Proxy(real,{get(target,key){if(key==='connect'||key==='query')return unavailable;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
 const work=new ConversationWorkService(pool,()=>new Date().toISOString(),unavailable),bindings=new BusinessConversationBindingService(pool,{id:()=>old,now:()=>new Date().toISOString()},{drafts:{begin:unavailable,get:unavailable},conversations:{bySession:unavailable},contexts:work}),service=new BusinessReassignmentService(pool,()=>new Date().toISOString(),work,bindings)
 try{await assert.rejects(async()=>service.readReceiptForRequest('',next),{code:'teloa/forbidden'});await assert.rejects(async()=>service.readReceiptForRequest('本人','invalid-id'),{code:'teloa/invalid-input'})}finally{await real.end()}
})
