import type {GithubSourceReceipt} from './github-source-api.js'
import type {IndustryDiscovery} from './industry-directory.js'

export type GithubSourcePreview={repository:string;requestedRef:string;commit:string;archiveHash:string;totalBytes:number;files:Array<{path:string;hash:string;bytes:number}>;discovery:IndustryDiscovery[]}

/** 从宿主已固定的字节发现行业清单；不访问网络，也不产生市场或安装记录。 */
export function githubSourcePreview(receipt:GithubSourceReceipt,discovery:IndustryDiscovery[]=[]):GithubSourcePreview{
 return {
  repository:receipt.provenance.owner+'/'+receipt.provenance.repo,
  requestedRef:receipt.provenance.requestedRef,
  commit:receipt.provenance.resolvedCommit,
  archiveHash:receipt.provenance.archiveHash,
  totalBytes:receipt.files.reduce((sum,file)=>sum+file.bytes.byteLength,0),
  files:receipt.files.map(file=>({path:file.path,hash:file.hash,bytes:file.bytes.byteLength})),
  discovery,
 }
}
