import {createHash} from 'node:crypto'
import {inspectBusinessImportWorkbookParts,parseBusinessImportSheetParts} from '@teloa/backend'
import {WorkError,readBusinessImportSourceV2,readBusinessImportWorkbookV2,readBusinessImportTableV2,type BusinessImportXlsxPort} from '@teloa/contract'
import {readBusinessImportArchive} from './business-import-archive.ts'

function snapshot(bytes:Uint8Array,signal?:AbortSignal):Uint8Array {
 signal?.throwIfAborted()
 if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>2*1024*1024)throw new WorkError('teloa/invalid-input','表格文件的压缩结构、路径或大小不受支持，请检查后重新导入。')
 // 首次异步读取前固定原附件；Buffer.slice() 会共享内存，不能用于此处。
 return new Uint8Array(bytes)
}

export function createBusinessImportXlsxPort():BusinessImportXlsxPort {
 return {
  async inspectWorkbook(bytes,signal){
   const input=snapshot(bytes,signal),fileHash=createHash('sha256').update(input).digest('hex')
   const parts=await readBusinessImportArchive(input,signal)
   const inspected=await inspectBusinessImportWorkbookParts(parts,signal)
   const result=readBusinessImportWorkbookV2({format:'teloa.business-import-workbook/v2',fileHash,bytes:input.byteLength,sheets:inspected.sheets,policy:inspected.policy})
   signal?.throwIfAborted();return result
  },
  async parseSheet(bytes,source,signal){
   const input=snapshot(bytes,signal),selected=readBusinessImportSourceV2(source)
   const parts=await readBusinessImportArchive(input,signal)
   const result=readBusinessImportTableV2(await parseBusinessImportSheetParts(parts,selected,signal))
   signal?.throwIfAborted();return result
  },
 }
}
