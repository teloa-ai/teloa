import {BlockList,isIP} from 'node:net'
import {WorkError,readOllamaAddress as parseOllamaAddress} from '@teloa/contract'

/**
 * 拒绝名单（规格 §8 + 审查 M-2）：未指定地址、广播、链路本地/云元数据（169.254/16、AWS IMDS IPv6 fd00:ec2::254、
 * 阿里云 100.100.100.200）、多播与 224/3 保留段、IPv6 链路本地与多播。按网段判定，不做前缀字符串比对。
 */
const refused=new BlockList()
refused.addAddress('0.0.0.0');refused.addAddress('255.255.255.255');refused.addAddress('100.100.100.200')
refused.addSubnet('169.254.0.0',16);refused.addSubnet('224.0.0.0',3)
refused.addAddress('::','ipv6');refused.addAddress('fd00:ec2::254','ipv6')
refused.addSubnet('fe80::',10,'ipv6');refused.addSubnet('ff00::',8,'ipv6')
export function isRefusedAddress(ip:string):boolean{
 const kind=isIP(ip)
 // Node 原生网段判定同时处理 IPv4 映射 IPv6（点分、十六进制、全展开），不自行实现 IPv6 解码。
 return kind===0||refused.check(ip,kind===4?'ipv4':'ipv6')
}

/** 宿主边界必须使用本读取器；浏览器契约只解析 URL，不承担网络授权。 */
export function readOllamaAddress(value:unknown):ReturnType<typeof parseOllamaAddress>{
 const address=parseOllamaAddress(value)
 if(isIP(address.host)&&isRefusedAddress(address.host))throw new WorkError('teloa/invalid-input','Ollama 地址落在不允许的网段。')
 return address
}
