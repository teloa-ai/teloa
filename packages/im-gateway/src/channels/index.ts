import {WorkError,type ImChannelKind} from '@teloa/contract'
import type {AdapterDeps,ImChannelAdapter} from '../core/types.ts'
import {createFeishuAdapter} from './feishu.ts'
import type {FeishuSdk} from './feishu-sdk.ts'
import {createSlackAdapter} from './slack.ts'
import {assertStubAllowed,createStubAdapter} from './stub.ts'
import {createTelegramAdapter} from './telegram.ts'

/**
 * 按渠道种类构造适配器；飞书与 Lark 共用飞书适配器（按种类切换官方域名），须带 loadSdk（SDK 由受管安装提供，评审 M7）；stub 只在浏览器验收环境可构造。
 * `launchEnv`：宿主传入只读启动快照（@teloa/harness-dsh/launch-env），验收开关不认工作区 `.env`；不传时读 process.env（测试）。
 */
export function createAdapter(kind:ImChannelKind,deps:AdapterDeps&{loadSdk?:()=>Promise<FeishuSdk>;launchEnv?:NodeJS.ProcessEnv}):ImChannelAdapter{
 if(kind==='telegram')return createTelegramAdapter(deps)
 if(kind==='slack')return createSlackAdapter(deps)
 if(kind==='stub')return createStubAdapter({...deps,port:assertStubAllowed(deps.launchEnv??process.env)})
 const loadSdk=deps.loadSdk
 if(!loadSdk)throw new WorkError('teloa/dependency-unavailable','飞书 SDK 未安装，请重新保存渠道密钥。')
 return createFeishuAdapter({...deps,loadSdk,brand:kind})
}
