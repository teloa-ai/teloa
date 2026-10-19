import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {registerGroupMentionTool} from '../src/group-mention-tool.ts'

test('群内提及只接受self并绑定原运行，非群、过期发言权、伪造owner和断谱系均拒绝',async()=>{
 let tool:any,pre:any,context:{canPost:boolean;nativeRequestId:string}|undefined={canPost:true,nativeRequestId:'original-request'},calls:unknown[]=[],failDeclaration=false
 const ctx={agents:{get:()=>undefined},tools:{register:(value:unknown)=>{tool=value}},on:(event:string,handler:unknown)=>{if(event==='tools/pre-execute')pre=handler;return()=>{}}} as unknown as Context
 registerGroupMentionTool(ctx,{context:async id=>{calls.push(['read',id]);return context},declare:async(id,request)=>{if(failDeclaration)throw Error('private storage token');calls.push(['declare',id,request])}})
 const exec={agent:{session:{id:'original-session',header:{},snapshotEvents:()=>[]}},signal:new AbortController().signal}
 assert.equal((await pre({name:tool.name,arguments:{target:'self'},...exec},async()=>({kind:'allow'}))).kind,'allow')
 const receipt=JSON.parse(await tool.execute({target:'self'},exec))
 assert.equal(receipt.mentionSelf,true,'复核按 mentionSelf 识别真实提醒回执')
 assert.match(receipt.notice,/最后一条回复作为正式交付/,'回执提示完整成果须在最后一条回复中给出')
 assert.deepEqual(calls.at(-1),['declare','original-session','original-request'])
 const declarations=calls.filter(call=>Array.isArray(call)&&call[0]==='declare').length
 for(const args of [{target:'Max'},{target:'self',owner:'other'},{target:'self',groupId:'other'},{target:'self',name:'Max'},{}])await assert.rejects(tool.execute(args,exec),(error:any)=>['INVALID_ARGS','teloa/invalid-input'].includes(error.code))
 assert.equal(calls.filter(call=>Array.isArray(call)&&call[0]==='declare').length,declarations)
 failDeclaration=true
 await assert.rejects(tool.execute({target:'self'},exec),(error:any)=>error.code==='teloa/dependency-unavailable'&&!error.message.includes('private'))
 failDeclaration=false
 context={canPost:false,nativeRequestId:'original-request'}
 await assert.rejects(tool.execute({target:'self'},exec),{code:'teloa/forbidden'})
 context=undefined
 await assert.rejects(tool.execute({target:'self'},exec),{code:'teloa/forbidden'})
 await assert.rejects(tool.execute({target:'self'},{...exec,agent:{session:{id:'child',header:{origin:'subagent',parentSession:'missing'},snapshotEvents:()=>[]}}}),{code:'teloa/forbidden'})
})
