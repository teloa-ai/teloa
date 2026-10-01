import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {Context,Exporter,Message} from '@deepseek-ai/cordis'
import {registerTeloaLogFile} from '../src/teloa-log.ts'

/** 内部写入是"注册即返回、落盘异步串行"的，测试只能轮询等它跑完，不能假设同步已写入。 */
async function waitFor(check:()=>Promise<string|undefined>):Promise<string>{
 for(let i=0;i<60;i++){
  const result=await check().catch(()=>undefined)
  if(result!==undefined)return result
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 throw new Error('等待落盘超时')
}

const fakeMessage=(over:Partial<Message>):Message=>({sn:1,ts:Date.now(),name:'teloa-harness-dsh',type:'warn',level:2,args:['单元测试行'],...over})

async function registerAgainstTempFile(fileName='harness.log'):Promise<{dir:string;file:string;exporter:Exporter}> {
 const dir=await mkdtemp(join(tmpdir(),'teloa-log-'))
 const file=join(dir,fileName)
 let captured:Exporter|undefined
 const fakeCtx={logger:{exporter:(exporter:Exporter)=>{captured=exporter}}} as unknown as Context
 registerTeloaLogFile(fakeCtx,file)
 assert.ok(captured,'registerTeloaLogFile 必须调用 ctx.logger.exporter 注册导出器')
 return {dir,file,exporter:captured}
}

test('注册的导出器口径显式给出 levels，且 default 覆盖到 warn',async t=>{
 const {dir,exporter}=await registerAgainstTempFile()
 t.after(()=>rm(dir,{recursive:true,force:true}))
 assert.equal(exporter.levels?.default,2)
})

test('导出一条 warn 后文件新增一行合法 JSON 且含 text',async t=>{
 const {dir,file,exporter}=await registerAgainstTempFile()
 t.after(()=>rm(dir,{recursive:true,force:true}))
 exporter.export(fakeMessage({type:'warn',args:['Teloa 群内路由未完成：%s','teloa/dependency-unavailable']}))
 const content=await waitFor(async()=>{const text=await readFile(file,'utf8');return text.trim().length>0?text:undefined})
 const lines=content.trim().split('\n')
 assert.equal(lines.length,1)
 const parsed=JSON.parse(lines[0]??"")
 assert.equal(parsed.level,'warn')
 assert.equal(parsed.name,'teloa-harness-dsh')
 assert.equal(parsed.text,'Teloa 群内路由未完成：teloa/dependency-unavailable')
 assert.equal(typeof parsed.at,'string')
 assert.ok(!Number.isNaN(Date.parse(parsed.at)))
})

test('只落本插件：其他插件的 info 与 warn 都被丢弃',async t=>{
 const {dir,file,exporter}=await registerAgainstTempFile()
 t.after(()=>rm(dir,{recursive:true,force:true}))
 exporter.export(fakeMessage({type:'info',name:'teloa-harness-dsh',level:1,args:['Teloa 既有群补签默认授权：%d 条',3]}))
 exporter.export(fakeMessage({type:'warn',name:'teloa-harness-dsh',level:2,args:['Teloa 群内路由未完成。']}))
 exporter.export(fakeMessage({type:'info',name:'some-other-plugin',level:1,args:['与本插件无关的 info']}))
 exporter.export(fakeMessage({type:'warn',name:'some-other-plugin',level:2,args:['与本插件无关的 warn']}))
 exporter.export(fakeMessage({type:'error',name:'some-other-plugin',level:0,args:['与本插件无关的 error']}))
 const content=await waitFor(async()=>{const text=await readFile(file,'utf8');return text.trim().length>0?text:undefined})
 // 给"不该出现的那几行"一点时间也不会晚到——等一轮之后再读一次确认稳定。
 await new Promise(resolve=>setTimeout(resolve,30))
 const finalContent=await readFile(file,'utf8')
 const lines=finalContent.trim().split('\n')
 assert.equal(lines.length,2)
 assert.deepEqual(lines.map(line=>JSON.parse(line).name),['teloa-harness-dsh','teloa-harness-dsh'])
 assert.deepEqual(lines.map(line=>JSON.parse(line).level),['info','warn'])
 for(const text of ['与本插件无关的 info','与本插件无关的 warn','与本插件无关的 error'])assert.ok(!finalContent.includes(text),text+' 不该落盘')
 assert.ok(!content.includes('与本插件无关的 info'))
})

test('目标目录不存在时写入失败但不抛出',async t=>{
 const {dir,exporter}=await registerAgainstTempFile('missing-subdir/harness.log')
 t.after(()=>rm(dir,{recursive:true,force:true}))
 assert.doesNotThrow(()=>exporter.export(fakeMessage({args:['探针：目录不存在']})))
 // 内部串行写入链是异步的：等它跑完并被 catch 静默掉，确认没有变成未处理的 rejection。
 await new Promise(resolve=>setTimeout(resolve,50))
})

test('文件超过 5MiB 时先转存为 .1 再新开，只留一份旧的',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-log-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const file=join(dir,'harness.log')
 const oversized=5*1024*1024+1
 await writeFile(file,'x'.repeat(oversized))
 let captured:Exporter|undefined
 const fakeCtx={logger:{exporter:(exporter:Exporter)=>{captured=exporter}}} as unknown as Context
 registerTeloaLogFile(fakeCtx,file)
 captured!.export(fakeMessage({args:['触发轮转']}))
 await waitFor(async()=>{const text=await readFile(file,'utf8').catch(()=>'');return text.includes('触发轮转')?text:undefined})
 const rotated=await readFile(file+'.1','utf8')
 assert.equal(rotated.length,oversized)
 const current=await readFile(file,'utf8')
 assert.equal(current.trim().split('\n').length,1)
})
