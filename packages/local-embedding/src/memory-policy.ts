import type {OrtSessionOptions} from './inference.ts'

/** 8 GiB 及以下的机器（M1/M2 Mac mini 8 GB 一档，未实机验证）按短空闲释放（检索规格 §3.2；批大小已由第一性原理复核落地规格 §13 修订为批 4 不分内存）。 */
const smallMemoryBytes=8*1024**3
/**
 * 发行默认微批 4，不分机器内存（内存评估 设计约束）：M5 Pro 48 GiB 实测 fp32 批 4 对批 8，
 * 1 MB 建索引峰值 RSS 3.00→2.60 GB、吞吐 10.04→9.50 块/秒（约 −5%），仍在 fp32 自身 3.2 GB 门槛内。
 * 测量见 design specification。
 */
const defaultBatchSize=4
type Env=Readonly<Record<string,string|undefined>>
const acceptance=(env:Env)=>env.TELOA_LOCAL_EMBEDDING_ACCEPTANCE==='1'

/**
 * 子进程微批大小（发行默认 4）与按注入的 `os.totalmem()` 给出的空闲释放时限。
 * 仅在 `TELOA_LOCAL_EMBEDDING_ACCEPTANCE=1` 下，`TELOA_LOCAL_EMBEDDING_BATCH=4|8` 覆盖批大小（内存评估 重测）；其他取值与发行宿主不受影响。
 */
export function memoryPolicy(totalmem:number,env:Env={}):{batchSize:number;idleTimeoutMs:number}{
 const policy={batchSize:defaultBatchSize,idleTimeoutMs:totalmem<=smallMemoryBytes?120_000:300_000}
 const batch=env.TELOA_LOCAL_EMBEDDING_BATCH
 return acceptance(env)&&(batch==='4'||batch==='8')?{...policy,batchSize:Number(batch)}:policy
}

/**
 * ORT 会话选项：取 `assets.json` 该变体的值（缺省空对象）。仅在 `TELOA_LOCAL_EMBEDDING_ACCEPTANCE=1` 下，
 * `TELOA_LOCAL_EMBEDDING_ORT_ARENA=off` 覆盖为关闭 CPU 内存 arena 与内存复用规划（内存评估 重测）。
 */
export function ortSessionOptions(variantOptions:OrtSessionOptions|undefined,env:Env={}):OrtSessionOptions{
 return acceptance(env)&&env.TELOA_LOCAL_EMBEDDING_ORT_ARENA==='off'?{enableCpuMemArena:false,enableMemPattern:false}:{...variantOptions}
}
