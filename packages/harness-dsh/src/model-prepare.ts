import {WorkError,modelCatalogIdPattern,taskInput} from '@teloa/contract'
import type {PullFacts} from './local-models.ts'

export function modelPrepareInput(args:unknown):{entryId:string;variant:number}{
 const row=taskInput(args,['entryId','variant'])
 if(typeof row.entryId!=='string'||!modelCatalogIdPattern.test(row.entryId))throw new WorkError('teloa/invalid-input','请指定官方目录中的本机模型条目。')
 if(row.variant!==undefined&&(!Number.isSafeInteger(row.variant)||Number(row.variant)<0||Number(row.variant)>5))throw new WorkError('teloa/invalid-input','模型变体必须是 0 到 5 的整数。')
 return {entryId:row.entryId,variant:row.variant===undefined?0:Number(row.variant)}
}

/** 事实仅来自目录及已配置的 Ollama；参数不能夹带地址或凭据。 */
export function pullCardFacts(facts:PullFacts,prior=''):string{
 const gib=(bytes:number)=>(bytes/2**30).toFixed(1)+' GiB'
 const disk=facts.local?(facts.diskFreeBytes===null?'暂时无法读取':gib(facts.diskFreeBytes)):'远程目标，无法核对'
 const license=facts.licenseTier==='commercial'?'可商用':'有限制'
 const restrictions=facts.restrictions.map(row=>row['zh-CN']).join('；')
 const fit={good:'适合',slow:'可能较慢',poor:'配置不足'}[facts.fit]
 const acknowledge=restrictions?'批准即表示已知悉以下许可限制：'+restrictions+'。':''
 return `${prior}${acknowledge}确认下载模型“${facts.title['zh-CN']}”（Ollama ${facts.name}，${facts.quant}）到 ${facts.local?'本机':'已配置的远程'} Ollama ${facts.baseURL}？体积约 ${gib(facts.sizeBytes)}，当前剩余磁盘：${disk}；目录摘要：${facts.catalogDigest??'未记录，下载后需显式接入'}；许可：${license} · ${facts.licenseName}（${facts.licenseURL}）${restrictions?'（'+restrictions+'）':''}；${facts.local?'本机硬件适配：'+fit:'远程硬件适配：无法核对'}。Ollama 将联网下载权重；接入时会加载模型并核验可用上下文，使用目标设备内存。进度与取消入口在 设置 · 本地模型。`
}
