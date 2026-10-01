import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto'

/** 凭据文档加密信封（规格 §3.1）：AAD 只含格式、fileId、keyId，不含路径，恢复到新目录仍可解。 */
export const envelopeFormat='teloa.credentials/v1'
export type Envelope={format:typeof envelopeFormat;fileId:string;keyId:string;nonce:string;ciphertext:string;tag:string}
export type EnvelopeFailure='format'|'key-mismatch'|'auth-failed'
export class EnvelopeError extends Error{
 readonly reason:EnvelopeFailure
 constructor(reason:EnvelopeFailure){super(`credentials envelope ${reason}`);this.name='EnvelopeError';this.reason=reason}
}
export function keyIdOf(masterKey:Uint8Array):string{return createHash('sha256').update('teloa-credentials-key-id\0').update(masterKey).digest('hex').slice(0,16)}
function dataKey(masterKey:Uint8Array,fileId:string,keyId:string):Buffer{return Buffer.from(hkdfSync('sha256',masterKey,Buffer.from(fileId,'utf8'),Buffer.from(`${envelopeFormat}/${keyId}`,'utf8'),32))}
function aad(fileId:string,keyId:string):Buffer{return Buffer.from(`${envelopeFormat}\n${fileId}\n${keyId}`,'utf8')}
const b64=/^[A-Za-z0-9+/]*={0,2}$/
/** GCM 固定 12 字节 nonce、16 字节认证标签；不限定标签长度时截断标签也能通过校验。 */
const nonceBytes=12,tagBytes=16
const gcm={authTagLength:tagBytes}
function assertKey(masterKey:Uint8Array):void{if(masterKey.length!==32)throw new RangeError('credentials master key must be 32 bytes')}

export function seal(masterKey:Uint8Array,fileId:string,plaintext:string):string{
 assertKey(masterKey)
 const keyId=keyIdOf(masterKey),nonce=randomBytes(nonceBytes),cipher=createCipheriv('aes-256-gcm',dataKey(masterKey,fileId,keyId),nonce,gcm)
 cipher.setAAD(aad(fileId,keyId))
 const ciphertext=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()])
 const envelope:Envelope={format:envelopeFormat,fileId,keyId,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')}
 return JSON.stringify(envelope)+'\n'
}

export function readHeader(text:string):Envelope{
 let row:unknown
 try{row=JSON.parse(text)}catch{throw new EnvelopeError('format')}
 if(typeof row!=='object'||row===null||Array.isArray(row))throw new EnvelopeError('format')
 const {format,fileId,keyId,nonce,ciphertext,tag}=row as Record<string,unknown>
 if(format!==envelopeFormat||typeof fileId!=='string'||!/^[0-9a-f-]{36}$/.test(fileId)||typeof keyId!=='string'||!/^[0-9a-f]{16}$/.test(keyId)
  ||typeof nonce!=='string'||!b64.test(nonce)||typeof ciphertext!=='string'||!b64.test(ciphertext)||typeof tag!=='string'||!b64.test(tag)
  ||Buffer.from(nonce,'base64').length!==nonceBytes||Buffer.from(tag,'base64').length!==tagBytes)throw new EnvelopeError('format')
 return {format,fileId,keyId,nonce,ciphertext,tag}
}

export function open(masterKey:Uint8Array,text:string):{fileId:string;keyId:string;plaintext:string}{
 assertKey(masterKey)
 const envelope=readHeader(text)
 if(keyIdOf(masterKey)!==envelope.keyId)throw new EnvelopeError('key-mismatch')
 try{
  const decipher=createDecipheriv('aes-256-gcm',dataKey(masterKey,envelope.fileId,envelope.keyId),Buffer.from(envelope.nonce,'base64'),gcm)
  decipher.setAAD(aad(envelope.fileId,envelope.keyId))
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'))
  const plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8')
  return {fileId:envelope.fileId,keyId:envelope.keyId,plaintext}
 }catch{throw new EnvelopeError('auth-failed')}
}
