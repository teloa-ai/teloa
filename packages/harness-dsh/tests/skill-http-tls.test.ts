import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

test('真实凭据加密存储、DSH 工具守卫与钉住 HTTPS 调用贯通；证书校验保持开启',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-skill-tls-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 // 只信任此子进程临时 CA，不改系统钥匙串、不关闭 TLS 验证。
 await writeFile(join(dir,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=api.skill.test\n[ext]\nsubjectAltName=DNS:api.skill.test\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n')
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(dir,'openssl.cnf'),'-keyout',join(dir,'server.key'),'-out',join(dir,'server.crt')],{encoding:'utf8'})
 assert.equal(cert.status,0,'无法生成临时测试证书：'+cert.stderr)
 const runner=fileURLToPath(new URL('./fixtures/skill-http-tls-runner.ts',import.meta.url))
 const result=spawnSync(process.execPath,[runner,dir],{encoding:'utf8',timeout:30_000,env:{...process.env,TELOA_USAGE_STATS:'off',NODE_EXTRA_CA_CERTS:join(dir,'server.crt')}})
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout)
 assert.match(result.stdout,/skill-http-tls: passed/)
})
