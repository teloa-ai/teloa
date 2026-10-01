import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

test('dsh-http-proxy 在 harness-dsh 与 DSH 启动器解析为同一实例（proxyRouteFor 的进程级策略才对得上）',()=>{
 const root=createRequire(fileURLToPath(new URL('../../../package.json',import.meta.url)))
 const launcher=realpathSync(root.resolve('@deepseek-ai/dsh/package.json'))
 const fromLauncher=realpathSync(createRequire(launcher).resolve('@deepseek-ai/dsh-http-proxy'))
 const fromHarness=realpathSync(createRequire(fileURLToPath(new URL('../package.json',import.meta.url))).resolve('@deepseek-ai/dsh-http-proxy'))
 assert.equal(fromHarness,fromLauncher)
})

test('代发出站按官方代理策略分流：proxied 经 CONNECT 代理桩成功、3xx 原样、identity 透传、错误不含代理账号；NO_PROXY 直连仍钉住',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-skill-proxy-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 // 只信任此子进程临时 CA，不改系统钥匙串、不关闭 TLS 验证。
 await writeFile(join(dir,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=api.skill.test\n[ext]\nsubjectAltName=DNS:api.skill.test,DNS:direct.skill.test\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n')
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(dir,'openssl.cnf'),'-keyout',join(dir,'server.key'),'-out',join(dir,'server.crt')],{encoding:'utf8'})
 assert.equal(cert.status,0,'无法生成临时测试证书：'+cert.stderr)
 const runner=fileURLToPath(new URL('./fixtures/skill-http-proxy-runner.ts',import.meta.url))
 // 清掉父进程可能带的代理变量：策略只由子进程内 installProxyFromEnvironment 装入。
 const env:Record<string,string|undefined>={...process.env,TELOA_USAGE_STATS:'off',NODE_EXTRA_CA_CERTS:join(dir,'server.crt')}
 for(const name of ['http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','no_proxy','NO_PROXY','all_proxy','ALL_PROXY'])delete env[name]
 const result=spawnSync(process.execPath,[runner,dir],{encoding:'utf8',timeout:30_000,env})
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout)
 assert.match(result.stdout,/skill-http-proxy: passed/)
})
