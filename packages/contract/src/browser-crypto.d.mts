/** 优先使用原生 Web Crypto，在非安全 HTTP 上使用相同的 SHA-256 算法。 */
export function sha256Digest(data:ArrayBuffer|ArrayBufferView):Promise<ArrayBuffer>
