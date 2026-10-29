import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const inspection=await import('../src/business-share-inspection.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-share-inspection.ts');throw error})
const encode=(value:string)=>new TextEncoder().encode(value)
const token='gh'+'p_'+'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'
const input=(text='{"description":"业务方法"}',purpose='分享核实方法')=>({files:[{path:'teloa.json',bytes:encode(text)}],purpose})
test('实际字节与用途绑定稳定摘要；重排文件不影响，单字节或说明变化失效',async()=>{
 assert.equal(typeof inspection.inspectBusinessShareContent,'function')
 const first=await inspection.inspectBusinessShareContent(input())
 assert.equal(first.fileList[0]?.digest,createHash('sha256').update(input().files[0]!.bytes).digest('hex'))
 assert.deepEqual(await inspection.inspectBusinessShareContent(input()),first)
 await inspection.assertBusinessShareInspection(input(),first.digest)
 await assert.rejects(inspection.assertBusinessShareInspection(input('{"description":"业务方式"}'),first.digest))
 await assert.rejects(inspection.assertBusinessShareInspection(input(undefined,'另一用途'),first.digest))
 const two={...input(),files:[...input().files,{path:'objects/a.json',bytes:encode('{}')}]}
 assert.equal((await inspection.inspectBusinessShareContent(two)).digest,(await inspection.inspectBusinessShareContent({...two,files:[...two.files].reverse()})).digest)
})
test('合法声明字符串、用途、URL与JSON转义中的凭据均阻止；位置不含值',async()=>{
 for(const value of [input(JSON.stringify({description:token})),input(undefined,token),input(JSON.stringify({url:'https://person:short@example.com/data'})),input('{"description":"'+token.replace('ghp','\\u0067hp')+'"}')]){
  const found=await inspection.inspectBusinessShareContent(value)
  assert.ok(found.findings.length>0);assert.ok(!JSON.stringify(found).includes(token))
  await assert.rejects(inspection.assertBusinessShareInspection(value,found.digest))
 }
})
test('拒绝重复路径、穿越、非法UTF8；普通地址与哈希不误报',async()=>{
 for(const files of [[{path:'../x',bytes:encode('{}')}],[{path:'x',bytes:new Uint8Array([255])}],[{path:'x',bytes:encode('{}')},{path:'x',bytes:encode('{}')}]] )await assert.rejects(inspection.inspectBusinessShareContent({files,purpose:'分享方法'}))
 assert.deepEqual((await inspection.inspectBusinessShareContent(input(JSON.stringify({url:'https://example.com/data',hash:'a'.repeat(64)})))).findings,[])
})
test('显式二进制模式允许PNG附件，全部原始字节与用途仍进入稳定摘要',async()=>{
 const bytes=new Uint8Array([137,80,78,71,13,10,26,10,255,0]),value={...input(),files:[...input().files,{path:'assets/figure.png',bytes}]}
 const checked=await inspection.inspectBusinessShareContent(value,{allowBinaryAssets:true})
 assert.deepEqual(checked.findings,[]);assert.equal(checked.fileList.find(row=>row.path==='assets/figure.png')!.digest,createHash('sha256').update(bytes).digest('hex'))
 assert.equal((await inspection.inspectBusinessShareContent({...value,files:[...value.files].reverse()},{allowBinaryAssets:true})).digest,checked.digest)
 await inspection.assertBusinessShareInspection(value,checked.digest,{allowBinaryAssets:true})
 const changed={...value,files:[value.files[0]!,{path:'assets/figure.png',bytes:new Uint8Array([...bytes,1])}]}
 await assert.rejects(inspection.assertBusinessShareInspection(changed,checked.digest,{allowBinaryAssets:true}),/变化/)
 await assert.rejects(inspection.inspectBusinessShareContent(value));await assert.rejects(inspection.assertBusinessShareInspection(value,checked.digest))
 assert.equal((await inspection.inspectBusinessShareContent(input(),{allowBinaryAssets:true})).digest,(await inspection.inspectBusinessShareContent(input())).digest)
})
test('二进制尾部的ASCII密钥和URL账号仍检出，输出不披露命中值',async()=>{
 for(const text of [token,'https://person:short@example.com/data']){
  const value={files:[{path:'assets/figure.png',bytes:new Uint8Array([137,80,78,71,255,0,...encode('\n'+text+'\n')])}],purpose:'完整业务附件'}
  const checked=await inspection.inspectBusinessShareContent(value,{allowBinaryAssets:true})
  assert.ok(checked.findings.length>0);assert.ok(!JSON.stringify(checked).includes(text))
  await assert.rejects(inspection.assertBusinessShareInspection(value,checked.digest,{allowBinaryAssets:true}),/凭据/)
 }
})
