import test from 'node:test'
import assert from 'node:assert/strict'
import {OLLAMA_DEFAULT_ADDRESS,OLLAMA_MIN_VERSION,OLLAMA_ROUTE_KEY,OLLAMA_CREDENTIAL_REF} from '@teloa/contract'
import {readOllamaAddress,isRefusedAddress} from '../src/ollama-address.ts'
import {OllamaClient} from '../src/ollama-client.ts'

test('地址：缺省与回环判本机；外部主机不判本机；拒绝路径/账号/查询/坏端口/拒绝网段',()=>{
 assert.deepEqual(readOllamaAddress('http://127.0.0.1:11434'),{baseURL:'http://127.0.0.1:11434',host:'127.0.0.1',port:11434,local:true})
 assert.equal(readOllamaAddress('http://localhost:11434/').local,true)
 assert.equal(readOllamaAddress('http://[::1]:11434').local,true)
 assert.equal(readOllamaAddress('https://ollama.lan:443').local,false)
 assert.equal(readOllamaAddress('http://10.0.0.8:11434').local,false)
 for(const bad of ['ftp://127.0.0.1:1','http://user:pw@127.0.0.1:11434','http://127.0.0.1:11434/v1','http://127.0.0.1:11434?x=1','http://127.0.0.1:0','http://169.254.169.254:80','http://0.0.0.0:11434','http://[fe80::1]:11434','http://-bad.host:1','not a url'])
  assert.throws(()=>readOllamaAddress(bad),/teloa\/invalid-input|地址/,bad)
 assert.equal(isRefusedAddress('169.254.10.1'),true);assert.equal(isRefusedAddress('fe80::abcd'),true);assert.equal(isRefusedAddress('224.0.0.1'),true);assert.equal(isRefusedAddress('192.168.1.5'),false)
})
test('地址：缺省端口补齐；IPv6 字面量保留方括号；常量固定',()=>{
 assert.deepEqual(readOllamaAddress('https://ollama.lan'),{baseURL:'https://ollama.lan:443',host:'ollama.lan',port:443,local:false})
 assert.deepEqual(readOllamaAddress('http://[::1]:11434'),{baseURL:'http://[::1]:11434',host:'::1',port:11434,local:true})
 assert.deepEqual(readOllamaAddress(OLLAMA_DEFAULT_ADDRESS),{baseURL:'http://127.0.0.1:11434',host:'127.0.0.1',port:11434,local:true})
 assert.equal(isRefusedAddress('::'),true);assert.equal(isRefusedAddress('255.255.255.255'),true);assert.equal(isRefusedAddress('ff02::1'),true);assert.equal(isRefusedAddress('not-an-ip'),true);assert.equal(isRefusedAddress('::1'),false)
 assert.throws(()=>readOllamaAddress('http://127.0.0.1:11434#frag'),/地址/)
 assert.throws(()=>readOllamaAddress('http://'+'a'.repeat(260)+':1'),/地址/)
 assert.throws(()=>readOllamaAddress(11434),/地址/)
 assert.equal(OLLAMA_MIN_VERSION,'0.6.0');assert.equal(OLLAMA_ROUTE_KEY,'ollama');assert.equal(OLLAMA_CREDENTIAL_REF,'OLLAMA_API_KEY')
})
test('地址：IPv4 映射 IPv6（点分/十六进制/全展开）与云元数据地址一律拒绝；首尾空白拒绝',()=>{
 for(const bad of ['http://[::ffff:a9fe:a9fe]:80','http://[::ffff:169.254.169.254]:80','http://[::ffff:0:0]:80','http://[0:0:0:0:0:ffff:a9fe:a9fe]:80','http://[fd00:ec2::254]:80','http://100.100.100.200:80','http://[::ffff:100.100.100.200]:80','http://[::ffff:e000:1]:80','http://[::ffff:ffff:ffff]:80','http://127.0.0.1:11434 ',' http://127.0.0.1:11434','http://127.0.0.1:11434\n'])
  assert.throws(()=>readOllamaAddress(bad),/地址/,bad)
 for(const ip of ['::ffff:a9fe:a9fe','::ffff:0:0','fd00:ec2::254','100.100.100.200','::ffff:255.255.255.255','224.0.0.1','239.255.255.250','240.0.0.1','fe80::1%en0','::ffff:xyz','1:2:3:4:5:6:7:8:9'])
  assert.equal(isRefusedAddress(ip),true,ip)
 for(const ip of ['::1','::ffff:7f00:1','::ffff:10.0.0.8','2001:db8::1','fd12::1','fd00:ec2::255','64:ff9b::a00:8','2002:a00:8::1','10.0.0.1','100.100.100.201','100.64.0.1','223.255.255.255'])
  assert.equal(isRefusedAddress(ip),false,ip)
 assert.equal(readOllamaAddress('http://[::ffff:10.0.0.8]:11434').local,false)
})
test('客户端构造复核实际连接地址，不信任调用方提供的 host 或 local',()=>{
 assert.throws(()=>new OllamaClient({baseURL:'http://169.254.169.254',host:'127.0.0.1',local:true}),/地址/)
 assert.throws(()=>new OllamaClient({baseURL:'http://[::ffff:a9fe:a9fe]',host:'127.0.0.1',local:true}),/地址/)
})
