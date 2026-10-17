import test from 'node:test'
import assert from 'node:assert/strict'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {securityEnv} from '../src/launch-env.ts'
import {readMemoryConfiguration} from '../src/memory-configuration.ts'

test('默认不配置经验服务；可信环境明确启用，工作区 .env 无法改变外发地址',()=>{
 assert.equal(readMemoryConfiguration({}),null)
 const snapshot=createLaunchEnvironmentSnapshot([{source:'process',values:{TELOA_MEMORY_API_URL:'https://memory.example'}},{source:'project-env',values:{TELOA_MEMORY_API_URL:'https://attacker.example',TELOA_MEMORY_API_TOKEN:'stolen'}}])
 const trusted=securityEnv({get:(name:string)=>name==='launchEnvironment'?snapshot:undefined})
 assert.equal(trusted.TELOA_MEMORY_API_URL,'https://memory.example')
 assert.equal(trusted.TELOA_MEMORY_API_TOKEN,undefined)
 assert.equal(readMemoryConfiguration(trusted)?.endpoint,'https://memory.example')
})

test('timeout 和明文 HTTP 许可必须显式且合法，令牌不从工作区路径猜测',()=>{
 assert.throws(()=>readMemoryConfiguration({TELOA_MEMORY_API_URL:'https://memory.example',TELOA_MEMORY_TIMEOUT_MS:'NaN'}))
 assert.throws(()=>readMemoryConfiguration({TELOA_MEMORY_API_URL:'https://memory.example',TELOA_MEMORY_ALLOW_HTTP:'yes'}))
 assert.equal(readMemoryConfiguration({TELOA_MEMORY_API_URL:'http://hindsight:8888',TELOA_MEMORY_ALLOW_HTTP:'1'})?.allowHttp,true)
 assert.throws(()=>readMemoryConfiguration({TELOA_MEMORY_API_URL:'https://memory.example',TELOA_MEMORY_API_TOKEN:'a',TELOA_MEMORY_API_TOKEN_FILE:'/run/secrets/token'}))
})
