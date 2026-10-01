import test from 'node:test'
import assert from 'node:assert/strict'
import {createPublicKey} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {detectMarketRemoteExclusion,MARKET_INDEX_PUBLIC_KEY} from '../src/market-remote.ts'

test('在线市场索引默认关闭；TELOA_MARKET_REMOTE=on 才启用，CI / 验收 / 开发 / off 一律关闭',()=>{
 assert.equal(detectMarketRemoteExclusion({}),'default-off')
 assert.equal(detectMarketRemoteExclusion({TELOA_MARKET_REMOTE:'on'}),undefined)
 assert.equal(detectMarketRemoteExclusion({TELOA_MARKET_REMOTE:'off'}),'env-off')
 assert.equal(detectMarketRemoteExclusion({TELOA_MARKET_REMOTE:'on',CI:'true'}),'ci')
 assert.equal(detectMarketRemoteExclusion({TELOA_MARKET_REMOTE:'on',TELOA_BROWSER_ACCEPTANCE:'1'}),'acceptance')
 assert.equal(detectMarketRemoteExclusion({TELOA_MARKET_REMOTE:'on',NODE_ENV:'development'}),'dev')
 assert.equal(detectMarketRemoteExclusion({TELOA_MARKET_REMOTE:'yes'}),'default-off')
})

test('内置公钥是 Ed25519 SPKI 生产公钥，不是本机开发公钥；本机有生产副本时两者一致',async()=>{
 const key=createPublicKey(MARKET_INDEX_PUBLIC_KEY),der=key.export({type:'spki',format:'der'}) as Buffer
 assert.equal(key.asymmetricKeyType,'ed25519')
 const read=(path:string)=>readFile(new URL('../../../.runtime/teloa/market-signing/'+path,import.meta.url),'utf8').catch(()=>null)
 const development=await read('public.pem'),production=await read('production/public.pem')
 if(development)assert.equal(createPublicKey(development).export({type:'spki',format:'der'}).equals(der),false,'内置公钥不得是开发公钥')
 if(production)assert.equal(createPublicKey(production).export({type:'spki',format:'der'}).equals(der),true)
})
