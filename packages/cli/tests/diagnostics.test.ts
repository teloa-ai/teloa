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

test('JSON 日志遮蔽嵌套敏感字段，保留普通值与因果身份',()=>{
 const runId='814779ca-2ea0-4f3c-9b25-720bb19e6678'
 const input={runId,requestId:'request-114',attempt:2,ok:false,items:[
  {access_token:'synthetic-access-value',refreshToken:'synthetic-refresh-value',count:3},
  {nested:{api_key:'synthetic-api-value',password:'synthetic-password-value'},sessionId:'session-114'},
 ],headers:{Authorization:'Bearer synthetic-header',Cookie:'synthetic-cookie','Set-Cookie':'synthetic-set-cookie'},safe:['relative/file.txt',null,true]}
 const output=diagnostics.redactLog('INFO '+JSON.stringify(input))
 assert.equal(output.startsWith('INFO '),true)
 assert.deepEqual(JSON.parse(output.slice(5)),{...input,items:[
  {access_token:'[redacted]',refreshToken:'[redacted]',count:3},
  {nested:{api_key:'[redacted]',password:'[redacted]'},sessionId:'session-114'},
 ],headers:{Authorization:'[redacted]',Cookie:'[redacted]','Set-Cookie':'[redacted]'}})
})

test('JSON 敏感值的转义、容器与标量均完整遮蔽，不截断相邻字段',()=>{
 const input=String.raw`{"api\u005fkey":"synthetic\"quote\\slash\nline","safe":"双引号\"与反斜线\\","token":["synthetic-array",{"value":"synthetic-nested"}],"secret":{"value":"synthetic-object"},"password":12345,"ok":true,"runId":"run-114"}`
 assert.deepEqual(JSON.parse(diagnostics.redactLog(input)),{api_key:'[redacted]',safe:'双引号"与反斜线\\',token:'[redacted]',secret:'[redacted]',password:'[redacted]',ok:true,runId:'run-114'})
 const fragment='  "access_token": "synthetic-fragment-value", "attempt": 4'
 assert.equal(diagnostics.redactLog(fragment),'  "access_token": "[redacted]", "attempt": 4')
 assert.equal(diagnostics.redactLog('{"access_token":"synthetic-unclosed-value'),'{"access_token":"[redacted]"')
})

test('JSON 字段随 UTF-8 字节分片并与 stderr 交错时仍保持完整脱敏',()=>{
 const input=JSON.stringify({access_token:'合成值"与\\转义',nested:[{apiKey:'synthetic-chunked-value'}],runId:'run-114',count:5})+'\n'
 const output:string[]=[],capture=new diagnostics.RuntimeOutput((line:string)=>output.push(line),()=>{})
 const bytes=Buffer.from(input)
 for(let index=0;index<bytes.length;index++){
  capture.write('stdout',bytes.subarray(index,index+1))
  if(index===17)capture.write('stderr','ordinary warning\n')
 }
 capture.end()
 assert.equal(output.length,2)
 assert.equal(output[0],'ordinary warning\n')
 assert.deepEqual(JSON.parse(output[1]!),{access_token:'[redacted]',nested:[{apiKey:'[redacted]'}],runId:'run-114',count:5})
})

test('过长 JSON 日志整行省略，下一行的敏感字段仍脱敏',()=>{
 const output:string[]=[],lines=new diagnostics.LogLines((line:string)=>output.push(line))
 lines.write('{"padding":"'+'a'.repeat(65536))
 lines.write('","access_token":"synthetic-long-line-value"}\n')
 lines.write('{"access_token":"synthetic-next-line-value","count":1}')
 lines.end()
 assert.equal(output.length,2)
 assert.equal(output[0],'[过长日志行已省略]\n')
 assert.deepEqual(JSON.parse(output[1]!),{access_token:'[redacted]',count:1})
})
