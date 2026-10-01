import {createPublicKey,verify} from 'node:crypto'

/**
 * 在线市场索引的 Ed25519 验签（规格 2026-09-25 §4.1）。
 * 签名覆盖 `index.json` 的完整字节；公钥为 SPKI PEM 文本，随应用发行内置。
 * 任何异常（公钥格式错误、算法不是 Ed25519、签名长度不对）都返回 false，不抛出。
 */
export function verifyMarketIndex(bytes:Uint8Array,signature:Uint8Array,publicKey:string):boolean{
 try{
  const key=createPublicKey(publicKey)
  if(key.asymmetricKeyType!=='ed25519')return false
  return verify(null,bytes,key,signature)
 }catch{return false}
}
