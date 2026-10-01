import {isIndustryManifest} from './industry-manifest.ts'
import type { MarketItem } from './market-preview.ts'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/lib/zip-core-custom.js'
import { INDUSTRY_TOTAL_LIMIT, readIndustryDirectory } from './industry-directory.ts'

/** 导出原始模板内容，不混入空间实例或已选公共引用的其他来源文件。 */
export async function exportIndustryArchive(item:MarketItem):Promise<{bytes:Uint8Array;name:string}>{
 const content=item.packageContent
 if(!isIndustryManifest(item.manifest)||!content)throw Error('请先读取完整行业模板内容。')
 const snapshot=structuredClone(content.files)
 const checked=await readIndustryDirectory(snapshot.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),content.manifestPath,item.title)
 if(checked.packageContent!.hash!==(content.baseHash||content.hash))throw Error('模板内容已变化，请重新读取后再导出。')
 const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false,useCompressionStream:true,level:6})
 let bytes:Uint8Array
 try{
  for(const file of snapshot)await writer.add(file.path,new Uint8ArrayReader(file.bytes))
  bytes=await writer.close()
 }catch(error){throw Error('模板 ZIP 导出失败：'+(error instanceof Error?error.message:'无法生成压缩文件。'))}
 if(bytes.length>INDUSTRY_TOTAL_LIMIT)throw Error('生成的 ZIP 超出 20 MiB 导入限制，请缩小模板目录后重试。')
 return {bytes,name:checked.manifest!.id+'-'+checked.manifest!.version+'.zip'}
}
