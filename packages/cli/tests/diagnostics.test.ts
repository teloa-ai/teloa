import assert from 'node:assert/strict'
import test from 'node:test'
const diagnostics=await import('../src/diagnostics.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
test('日志脱敏覆盖数据库、Cookie、令牌和分片',()=>{
 assert.equal(typeof diagnostics.redactLog,'function','缺少日志脱敏')
 assert.equal(diagnostics.redactLog('Authorization: Bearer test-secret'),'Authorization: [redacted]')
 assert.equal(diagnostics.redactLog('postgresql://u:test-secret@localhost/teloa'),'[database URL]')
 const output:string[]=[];const lines=new diagnostics.LogLines((line:string)=>output.push(line))
 lines.write('dsh web: http://127.0.0.1:1234/?to');lines.write('ken=test-secret\nCookie: auth=another-secret\n');lines.end()
 assert.doesNotMatch(output.join('\n'),/test-secret|another-secret/)
})
test('stdout 与 stderr 交错分片不会切断另一条流的认证行',()=>{
 assert.equal(typeof diagnostics.RuntimeOutput,'function')
 const output:string[]=[],observed:string[]=[]
 const capture=new diagnostics.RuntimeOutput((line:string)=>output.push(line),(line:string)=>observed.push(line))
 capture.write('stdout','dsh web: http://127.0.0.1:1234/?token=')
 capture.write('stderr','warning from native addon\n')
 capture.write('stdout','private-token-fragment\n')
 capture.end()
 assert.doesNotMatch(output.join(''),/private-token-fragment/)
 assert.ok(observed.some(line=>line.includes('?token=private-token-fragment')))
})

test('运行日志脱敏覆盖常见密钥前缀与私钥块',()=>{
 const token='gh'+'p_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
 const out=diagnostics.redactLog('x '+token+' AKIA'+'ABCDEFGHIJKLMNOP -----BEGIN '+'RSA PRIVATE KEY-----\nzz\n-----END RSA PRIVATE KEY-----')
 assert.ok(!out.includes(token));assert.ok(!out.includes('AKIAABCD'));assert.ok(!out.includes('zz'))
})
