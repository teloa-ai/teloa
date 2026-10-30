import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {trustedHostArguments} from '../scripts/runtime/public-web-access.mjs'
import {launchRuntime,runtimeEnvironment} from '../scripts/runtime/profile.mjs'

test('公网信任地址只接受显式 authority，默认不增加任何远端',()=>{
 assert.deepEqual(trustedHostArguments(undefined),[]);assert.deepEqual(trustedHostArguments(' '),[])
 assert.deepEqual(trustedHostArguments('203.0.113.7:3100, app.example, [2001:db8::1]:3100,203.0.113.7:3100'),['--trusted-host','203.0.113.7:3100','--trusted-host','app.example','--trusted-host','[2001:db8::1]:3100'])
 for(const value of ['*','*.example','http://example.com','user:pass@example.com','example.com/path','example.com?token=x','example.com#x','example.com,','example.com:0','example.com:65536','example.com\\path','example.com\nother.example'])assert.throws(()=>trustedHostArguments(value),/TELOA_DSH_TRUSTED_HOSTS/)
})

test('固定 DSH 栅栏允许配置的公网 HTTP 同源请求，仍拒绝其他主机和跨站',async t=>{
 const require=createRequire(new URL('../packages/client/ui-workbench/package.json',import.meta.url))
 const {HostConnectionService}=await import(require.resolve('@deepseek-ai/dsh-client-connection')),{Context}=require('@deepseek-ai/cordis')
 const ctx=new Context();ctx.provide('webServer',{host:'127.0.0.1',protocol:'http:'})
 const host='203.0.113.7:3100',hosts=trustedHostArguments(host).filter((_,index)=>index%2===1)
 let authenticated=true
 const service=new HostConnectionService(ctx,hosts,{isAuthenticated:()=>authenticated,authenticateApi:()=>undefined})
 const request=(authority,origin,site)=>({headers:new Headers({host:authority,...(origin?{origin}:{}),...(site?{'sec-fetch-site':site}:{})})})
 assert.equal(service.requestRejection(request(host,'http://'+host,'same-origin')),undefined)
 assert.equal(service.requestRejection(request('127.0.0.1:3100','http://127.0.0.1:3100')),undefined)
 assert.equal(service.requestRejection(request('attacker.example','http://attacker.example')),403)
 assert.equal(service.requestRejection(request(host,'http://attacker.example')),403)
 assert.equal(service.requestRejection(request(host,'http://'+host,'cross-site')),403)
 assert.equal(service.requestRejection(request('203.0.113.7:3101','http://203.0.113.7:3101')),403)
 authenticated=false
 assert.equal(service.requestRejection(request(host,'http://'+host)),401)
})

test('发行入口保留公网配置，并传入原生参数，监听地址仍为回环',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-public-args-'));t.after(()=>rm(root,{recursive:true,force:true}))
 await mkdir(join(root,'scripts/runtime'),{recursive:true})
 await writeFile(join(root,'scripts/runtime/native-runtime-entry.mjs'),'console.log(JSON.stringify(process.argv.slice(2)))')
 const previous=process.env.TELOA_DSH_TRUSTED_HOSTS;process.env.TELOA_DSH_TRUSTED_HOSTS='203.0.113.7:3100'
 t.after(()=>{if(previous===undefined)delete process.env.TELOA_DSH_TRUSTED_HOSTS;else process.env.TELOA_DSH_TRUSTED_HOSTS=previous})
 const layout={programRoot:root,workspaceRoot:root,dshHome:join(root,'dsh'),runtimeRoot:join(root,'runtime'),profileName:'teloa-test'}
 assert.equal(runtimeEnvironment(layout).TELOA_DSH_TRUSTED_HOSTS,'203.0.113.7:3100')
 const child=launchRuntime(layout,{port:3100});let output='';child.stdout.on('data',chunk=>{output+=chunk})
 assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done)}),0)
 assert.deepEqual(JSON.parse(output),['--profile','teloa-test','--no-open','--host','127.0.0.1','--port','3100','--trusted-host','203.0.113.7:3100'])
})
