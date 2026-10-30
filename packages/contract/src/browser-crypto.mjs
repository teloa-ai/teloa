import {hash} from 'fast-sha256'

/** HTTP 页面没有 SubtleCrypto，内容指纹仍必须使用相同的 SHA-256 算法。 */
export async function sha256Digest(data){
 const source=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data)
 const bytes=Uint8Array.from(source),subtle=globalThis.crypto?.subtle
 if(typeof subtle?.digest==='function')return subtle.digest('SHA-256',bytes)
 return Uint8Array.from(hash(bytes)).buffer
}
