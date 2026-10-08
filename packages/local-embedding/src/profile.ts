import {createHash} from 'node:crypto'
import {embeddingDimensions} from './pooling.ts'
import {variantFiles,type AssetVariant,type AssetsManifest} from './assets.ts'

/** 市场目录条目（契约语法；功能验证 落目录 JSON）。 */
export const embeddingCatalogId='teloa.model.qwen3-embedding-0-6b'
export const embeddingCatalogVersion='1.0.0'

/** 规格 §4.4 的配置摘要字段；分块器版本与参数由索引表的 `chunker` 列单独绑定。 */
export type EmbeddingProfile={
 catalogId:string;catalogVersion:string;variant:AssetVariant
 /** 该变体全部 ONNX 文件（含外部数据）的 sha256，按 assets.json 顺序。 */
 onnxSha256:string[];tokenizerSha256:string
 dimensions:1024;pooling:'last-token';normalize:'l2';maxTokens:number
 /** 精确字串（`Query:` 后无空格）。 */
 queryInstruction:string;documentPrefix:string
}

export function embeddingProfile(assets:AssetsManifest,variant:AssetVariant):EmbeddingProfile{
 const files=variantFiles(assets,variant)
 const tokenizer=files.find(file=>file.path==='tokenizer.json')
 if(!tokenizer)throw new Error('工件清单缺少 tokenizer.json。')
 const profile=assets.profile
 return {catalogId:embeddingCatalogId,catalogVersion:embeddingCatalogVersion,variant,
  onnxSha256:files.filter(file=>/\.onnx(?:_data)?$/.test(file.path)).map(file=>file.sha256),tokenizerSha256:tokenizer.sha256,
  dimensions:profile.dimensions as 1024,pooling:profile.pooling as 'last-token',normalize:profile.normalize as 'l2',maxTokens:profile.maxTokens,
  queryInstruction:profile.queryInstruction,documentPrefix:profile.documentPrefix}
}

const canonical=(value:unknown):string=>{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}'
 return JSON.stringify(value)
}

/** 对规范化 JSON（键排序）做 sha256：字段顺序无关，任一字段变化即为新索引版本。 */
export function profileHash(profile:EmbeddingProfile):string{
 if(profile.dimensions!==embeddingDimensions||profile.pooling!=='last-token'||profile.normalize!=='l2')throw new Error('嵌入配置偏离固定取值（1024 维、last-token、L2）。')
 return embeddingConfigurationHash(profile)
}

/** 各提供器共用稳定摘要算法，模型原生维度与存储适配由各自配置显式绑定。 */
export function embeddingConfigurationHash(profile:unknown):string{
 return createHash('sha256').update(canonical(profile)).digest('hex')
}
