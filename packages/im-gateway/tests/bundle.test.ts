import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,access} from 'node:fs/promises'
import {createRequire} from 'node:module'

const root=new URL('../../../',import.meta.url)
const pkgRoot=new URL('../',import.meta.url)
const read=(path:string,base:URL=root)=>readFile(new URL(path,base),'utf8')

test('im-gateway 自带组合补丁：只插入 teloa-im-gateway 一行，不带 disabled',async()=>{
 const manifest=JSON.parse(await read('package.json',pkgRoot)) as {dsh:unknown;exports:Record<string,string>}
 assert.deepEqual(manifest.dsh,{bundle:{patch:'./cordis.patch.yml'}})
 assert.equal(manifest.exports['./cordis.patch.yml'],'./cordis.patch.yml')
 const {parse}=createRequire(new URL('packages/harness-dsh/package.json',root))('yaml') as {parse:(text:string)=>unknown}
 assert.deepEqual(parse(await read('cordis.patch.yml',pkgRoot)),[{insert:[{id:'teloa-im-gateway',name:'@teloa/im-gateway'}]}])
})

test('@teloa/bundle 不再默认加载 IM 通道',async()=>{
 assert.doesNotMatch(await read('packages/bundle/cordis.patch.yml'),/teloa-im-gateway|@teloa\/im-gateway/)
 const manifest=JSON.parse(await read('packages/bundle/package.json')) as {dependencies:Record<string,string>}
 assert.equal(manifest.dependencies['@teloa/im-gateway'],undefined)
})

test('im-gateway package.json：@deepseek-ai/* 钉 0.2.1-alpha.1（cordis 4.0.5-alpha.1）；四处依赖字段与根 lock 均不含 larksuiteoapi（M7）',async()=>{
 const manifest=JSON.parse(await read('package.json',pkgRoot)) as Record<string,Record<string,string>|string>
 assert.equal(manifest.name,'@teloa/im-gateway')
 assert.equal((manifest.engines as Record<string,string>).dsh,'0.2.1-alpha.1')
 const fields=['dependencies','devDependencies','optionalDependencies','peerDependencies']
 for(const field of fields){
  const deps=(manifest[field] as Record<string,string>|undefined)??{}
  assert.ok(!('@larksuiteoapi/node-sdk' in deps),field+' 不得含 @larksuiteoapi/node-sdk')
  for(const [name,version] of Object.entries(deps)){
   if(name==='@deepseek-ai/cordis')assert.equal(version,'4.0.5-alpha.1',name)
   else if(name.startsWith('@deepseek-ai/'))assert.equal(version,'0.2.1-alpha.1',name)
  }
 }
 const deps=manifest.dependencies as Record<string,string>
 for(const name of ['@deepseek-ai/dsh-credentials','@deepseek-ai/dsh-user-approval','@deepseek-ai/dsh-user-questions','@deepseek-ai/dsh-api-session-controller','@deepseek-ai/dsh-session','@teloa/contract','@teloa/harness-dsh'])assert.ok(name in deps,name)
 assert.doesNotMatch(await read('pnpm-lock.yaml'),/larksuiteoapi/)
})

test('MIT 出处：LICENSE 副本含版权行、provenance 含 commit、搬运文件首两行含出处头',async()=>{
 assert.match(await read('licenses/dsh-im-gateway.LICENSE',pkgRoot),/Copyright \(c\) 2026 zhuiyueya/)
 const provenance=await read('provenance/dsh-im-gateway.md')
 assert.match(provenance,/c907dd5/)
 assert.match(provenance,/zhuiyueya\/dsh-im-gateway/)
 assert.match(await read('THIRD_PARTY_NOTICES.md'),/dsh-im-gateway/)
 assert.match(await read('THIRD_PARTY_NOTICES.md',pkgRoot),/dsh-im-gateway/)
 // 搬运清单与 provenance 逐文件表一致；Teloa 自有文件（如 channels/feishu-sdk.ts）不带出处头。
 for(const path of ['src/channels/telegram.ts','src/channels/slack.ts','src/channels/feishu.ts','src/core/split.ts','src/core/format.ts','src/instance-lock.ts']){
  const url=new URL(path,pkgRoot)
  assert.ok(await access(url).then(()=>true,()=>false),path+' 应已搬入')
  const head=(await readFile(url,'utf8')).split('\n').slice(0,2).join('\n')
  assert.match(head,/源自 dsh-im-gateway/,path)
  assert.match(head,/c907dd5/,path)
 }
})

test('插件入口：name、inject 与 apply 形态；不使用 ready 事件（C1）',async()=>{
 const source=await read('src/index.ts',pkgRoot)
 assert.match(source,/export const name='teloa-im-gateway'/)
 assert.match(source,/export const inject=\['teloaWork','credentials','sessionController','sessions'\] as const/)
 assert.match(source,/export function apply\(ctx:Context,options:ImGatewayOptions=\{\}\):void/)
 assert.doesNotMatch(source,/on\('ready'/)
 const plugin=await import('../src/index.ts')
 assert.equal(plugin.name,'teloa-im-gateway')
 assert.deepEqual([...plugin.inject],['teloaWork','credentials','sessionController','sessions'])
 // 装载行为（装载即启动、dispose 释放）见 plugin-lifecycle.test.ts。
})
