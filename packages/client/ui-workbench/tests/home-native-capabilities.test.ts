import assert from 'node:assert/strict'
import test from 'node:test'
import {insertHomeCapabilities} from '../src/client/home-native-capabilities.ts'

test('资料直接插入现有富草稿，保留正文与附件且重试不重复引用',async()=>{
 let state:any={draft:'已有正文',draftRev:1,phase:'plain',attachmentIds:['image-1'],occurrences:[]}
 const listeners=new Set<()=>void>(),selection={resources:[{id:'11111111-1111-4111-8111-111111111111',title:'依据',version:1}],skills:[]}
 const port:any={state:{getSnapshot:()=>state,subscribe:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn)}},reference:({reference,span}:any)=>{assert.equal(span.draftRev,state.draftRev);state={...state,draftRev:state.draftRev+1,occurrences:[...state.occurrences,reference]};listeners.forEach(fn=>fn());return true},text:()=>{throw Error('不应写正文')},verify:async()=>{}}
 await insertHomeCapabilities(selection,port)
 await insertHomeCapabilities(selection,port)
 assert.equal(state.draft,'已有正文');assert.deepEqual(state.attachmentIds,['image-1']);assert.equal(state.occurrences.length,1)
})

test('异步核验期间改写草稿时不插入选项',async()=>{
 let state:any={draft:'原草稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]},writes=0
 await assert.rejects(insertHomeCapabilities({resources:[],skills:[{name:'skill-a',provider:'p',source:'s'}]},{state:{getSnapshot:()=>state,subscribe:()=>()=>{}},verify:async()=>{state={...state,draft:'新草稿',draftRev:2}},text:()=>{writes++;return true},reference:()=>true}),/变化/)
 assert.equal(writes,0)
})
