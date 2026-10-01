import assert from 'node:assert/strict'
import test from 'node:test'
const cli=await import('../src/bin.ts') as any
test('参数解析拒绝未知命令、无 TTY 缺值、密码 URL 和不明确版本',()=>{
 assert.equal(typeof cli.parseArguments,'function','缺少严格参数解析')
 for(const args of [['oops'],['up','--home'],['up','--port','no'],['up','--database-url','postgresql://secret'],['status','--workspace','/tmp'],['up','--port','3188','--port','3189']])assert.throws(()=>cli.parseArguments(args),/参数|命令|端口/)
 assert.deepEqual(cli.parseArguments(['up','--home','/tmp/中文 目录','--port','3188']),{command:'up',options:{home:'/tmp/中文 目录',port:'3188'}})
})
test('维护命令要求明确的新目标和确切升级版本',()=>{
 for(const args of [['backup'],['restore','--from','/tmp/backup'],['upgrade','--to','latest'],['upgrade','--to','https://example.test/code']])assert.throws(()=>cli.parseArguments(args),/参数|目标|版本/)
 assert.deepEqual(cli.parseArguments(['backup','--output','/tmp/new backup']),{command:'backup',options:{output:'/tmp/new backup'}})
 assert.deepEqual(cli.parseArguments(['restore','--from','/tmp/backup','--home','/tmp/new-home']),{command:'restore',options:{from:'/tmp/backup',home:'/tmp/new-home'}})
 assert.deepEqual(cli.parseArguments(['uninstall']),{command:'uninstall',options:{}})
})
test('凭据维护只对外开放 export-plaintext 与 reset，且必须 --confirm',()=>{
 for(const args of [['credentials'],['credentials','--action','rotate'],['credentials','--action','rotate','--confirm'],['credentials','--action','reset'],['credentials','--action','wipe','--confirm']])assert.throws(()=>cli.parseArguments(args),/--action|--confirm/)
 assert.deepEqual(cli.parseArguments(['credentials','--action','reset','--confirm']),{command:'credentials',options:{action:'reset',confirm:true}})
 assert.deepEqual(cli.parseArguments(['credentials','--action','export-plaintext','--confirm']),{command:'credentials',options:{action:'export-plaintext',confirm:true}})
})
