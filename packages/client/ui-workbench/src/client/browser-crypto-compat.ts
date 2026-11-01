/** 为 HTTP 下的 Teloa 与原生 DSH 输入提供 UUID；随机源仍是浏览器的 CSPRNG。 */
export function installBrowserRandomUUID(provider:Crypto|undefined=globalThis.crypto):void{
 if(!provider||typeof provider.randomUUID==='function'||typeof provider.getRandomValues!=='function')return
 Object.defineProperty(provider,'randomUUID',{configurable:true,writable:true,value:()=>{
  const bytes=provider.getRandomValues(new Uint8Array(16))
  bytes[6]=(bytes[6]!&0x0f)|0x40
  bytes[8]=(bytes[8]!&0x3f)|0x80
  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
 }})
}

installBrowserRandomUUID()
