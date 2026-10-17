import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir,mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readPlatformRoute,createPlatformModelAccess,preparePlatformLaunch,platformProviderIds} from '../src/platform-model-connection.ts'

const signal=()=>new AbortController().signal
const settings=(overrides:Record<string,unknown>={})=>({describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers:{
 'teloa-platform-responses':{api:'openai-responses',apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',baseURL:'https://models.example.test/v1',models:[{id:'platform-gpt',contextWindow:4096,maxTokens:128}]},
 'teloa-platform-messages':{api:'anthropic-messages',apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',baseURL:'https://models.example.test/anthropic',models:[{id:'platform-claude',contextWindow:4096,maxTokens:128}]},
 ...overrides,
}}}]})
const credentials=(value='platform-model-token')=>({resolve:async()=>({value,source:'file' as const})})

test('平台三引擎配置只取原生模型路由和同一凭据引用',()=>{
 assert.equal(readPlatformRoute(settings(),'codex').model,'platform-gpt')
 assert.equal(readPlatformRoute(settings(),'claude-code').model,'platform-claude')
 assert.deepEqual(platformProviderIds,['teloa-platform-responses','teloa-platform-messages','teloa-platform-completions'])
 assert.equal(readPlatformRoute(settings(),'codex').credentialRef,readPlatformRoute(settings(),'claude-code').credentialRef)
})
test('未知模型、供应商个人密钥引用、含凭据地址或缺协议均拒绝',()=>{
 assert.throws(()=>readPlatformRoute(settings(),'codex','unlisted'),/平台模型/)
 for(const patch of [{apiKeyEnv:'OPENAI_API_KEY'},{baseURL:'https://user:secret@models.example.test/v1'},{api:'openai-completions'},{baseURL:'http://models.example.test/v1'}]){
  const original=(settings().describe()[0]!.value.providers)['teloa-platform-responses']
  assert.throws(()=>readPlatformRoute(settings({'teloa-platform-responses':{...original,...patch}}),'codex'),/平台模型/)
 }
})
test('平台 Token 缺失或轮换不回退个人凭据；令牌不进入公开路由事实',async()=>{
 let value:string|undefined='first-platform-token'
 const access=createPlatformModelAccess({settings:settings(),credentials:{resolve:async ref=>{assert.equal(ref,'TELOA_PLATFORM_MODEL_TOKEN');return value?{value,source:'file'}:undefined}}})
 const lease=await access.acquire('codex',signal())
 assert.ok(!JSON.stringify(lease.route).includes(value!))
 value='second-platform-token'
 await assert.rejects(lease.assertCurrent(),/平台模型/)
 value=undefined
 await assert.rejects(access.acquire('codex',signal()),/平台模型/)
})
test('连接或模型在异步核对期间改变，旧凭据不能启动引擎',async()=>{
 let endpoint='https://models.example.test/v1'
 const store={describe:()=>{const row=settings().describe()[0]!;row.value.providers['teloa-platform-responses'].baseURL=endpoint;return [row]}}
 const access=createPlatformModelAccess({settings:store,credentials:{resolve:async()=>{endpoint='https://other.example.test/v1';return {value:'platform-token',source:'file'}}}})
 await assert.rejects(access.acquire('codex',signal()),/平台模型/)
})
test('原生配置文件不写 Token，两个引擎的认证目录独立且可释放',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-platform-launch-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const access=createPlatformModelAccess({settings:settings(),credentials:credentials()})
 const codex=await preparePlatformLaunch(await access.acquire('codex',signal()),root,signal())
 const claude=await preparePlatformLaunch(await access.acquire('claude-code',signal()),root,signal())
 assert.notEqual(codex.env.HOME,claude.env.HOME)
 const config=await readFile(join(codex.env.CODEX_HOME!,'config.toml'),'utf8')
 assert.match(config,/wire_api = "responses"/);assert.match(config,/requires_openai_auth = false/)
 assert.ok(!config.includes('platform-model-token'))
 assert.equal(codex.env.TELOA_PLATFORM_MODEL_TOKEN,claude.env.ANTHROPIC_AUTH_TOKEN)
 assert.equal(claude.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,'1')
 assert.equal(claude.env.ANTHROPIC_API_KEY,undefined)
 await codex.dispose();await claude.dispose();await codex.dispose()
 assert.deepEqual(await readdir(root),[])
})
