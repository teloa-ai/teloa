import {WorkError} from '@teloa/contract'

/** 版本：本阶段只交付个人版；企业版条目只写不做，因此这里只有 `personal` 一个取值。 */
export type Edition='personal'

/**
 * 读取版本配置：环境变量 `TELOA_EDITION` 缺省即个人版。
 * 任何其它取值都在宿主装配时直接失败，不做静默降级——版本判定今后来自桌面 App 的许可状态，
 * 现在就允许一个读不懂的取值悄悄落到个人版，会把将来的许可错误伪装成正常启动。
 */
export function readEdition(env:Record<string,string|undefined>=process.env):Edition{
 const value=env.TELOA_EDITION
 if(value===undefined||value==='personal')return 'personal'
 throw new WorkError('teloa/invalid-input','TELOA_EDITION 只接受 personal（当前为 '+value+'）；专业版 / 企业版尚未交付。')
}
