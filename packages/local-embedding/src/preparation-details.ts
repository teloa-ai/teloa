import {readRetrievalPreparationDetails,type RetrievalPreparationDetails} from '@teloa/contract'
import {assetDownloadReserveBytes,variantFiles,type AssetsManifest,type EmbeddingVariant} from './assets.ts'
import assetsManifest from '../runtime/assets.json' with {type:'json'}
import recipe from '../runtime/onnxruntime.json' with {type:'json'}

/** 容量与许可来自固定工件；运行时解包及内存仅为估算，不能冒充可用磁盘或设备实测。 */
export function retrievalPreparationDetails(variant:EmbeddingVariant,modelDirectory:string,runtimeDirectory:string):RetrievalPreparationDetails{
 const manifest=assetsManifest as AssetsManifest,files=variantFiles(manifest,variant)
 return readRetrievalPreparationDetails({
  modelName:assetsManifest.model.name,license:assetsManifest.model.upstream.license,upstreamRepo:assetsManifest.model.upstream.repo,conversionRepo:assetsManifest.model.onnx.repo,
  modelDirectory,runtimeDirectory,
  files:files.map(file=>({path:file.path,source:new URL(file.url).hostname,bytes:file.bytes,sha256:file.sha256,shared:file.variant==='shared'})),
  runtime:{...recipe,source:'registry.npmjs.org',unpackedBytesEstimate:300_000_000},
  reserveBytes:assetDownloadReserveBytes,memoryBytesEstimate:[3*1024**3,4*1024**3],
  // 确认卡的两种下载来源：官方主机与各镜像改写后的主机，都来自固定 assets.json。
  downloadSources:[{id:'official',host:manifest.allowedHosts[0]},...manifest.mirrors.map(mirror=>({id:mirror.id,host:Object.values(mirror.hostMap)[0]}))],
 })
}
