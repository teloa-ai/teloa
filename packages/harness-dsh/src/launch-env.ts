import type {Context} from '@deepseek-ai/cordis'
import {createLaunchEnvironmentSnapshot,launchEnvironmentOf,type LaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'

/**
 * 安全敏感环境变量只认启动时继承的进程环境（DSH 启动快照的 `process` 层）。
 * DSH 在加载任何插件之前，把启动目录（即工作区）的 `.env` 与 `$DSH_HOME/.env` 里「进程环境没有」的名字写进 `process.env`；
 * 工作区 `.env` 模型可写，克隆来的仓库也可能自带。让它们参与安全决策，就能改 OAuth 回调截获授权码、把安全动作请求与令牌
 * 引到别处、打开验收开关或放宽执行上限。快照在合入之前取得、此后不变。
 */
export type LaunchEnv=Readonly<Record<string,string|undefined>>

/** 只取快照 `process` 层里这些名字的值；`.env` 层（project-env、user-env）一律不认。 */
export function processLayerEnv(launch:LaunchEnvironmentSnapshot,names:readonly string[]):LaunchEnv{
 return Object.fromEntries(names.flatMap(name=>{const hit=launch.getFrom(name,['process']);return hit?[[name,hit.value]]:[]}))
}

/**
 * 全仓 `process.env.TELOA_*` 归类后的安全敏感名单（凭据档位与主密钥来源另见 `credentials/provider.ts` 的 keySourceEnv）。
 * 分类依据写在凭据存储加固一期 功能验证 报告；新增读取 TELOA_* 的安全相关开关须补进这里。
 */
export const securityEnvNames=[
 // 验收开关与只在验收环境生效的桩
 'TELOA_BROWSER_ACCEPTANCE','TELOA_ACCEPTANCE_MCP_OAUTH_URL','TELOA_IM_STUB_PORT',
 // 本地中文检索验收变体开关（只在 TELOA_BROWSER_ACCEPTANCE=1 下生效；工作区 .env 不得把发行变体切成 int8）
 'TELOA_LOCAL_EMBEDDING_ACCEPTANCE','TELOA_LOCAL_EMBEDDING_VARIANT',
 // 授权与外发目标
 'TELOA_OAUTH_PUBLIC_CALLBACK_URL','TELOA_SECURITY_ACTION_URL','TELOA_SECURITY_ACTION_TOKEN','TELOA_SECURITY_ACTION_TOKEN_FILE',
 // 统计与在线市场开关、统计上报地址、市场评价服务测试地址（会收到市场账号令牌）
 'TELOA_USAGE_STATS','TELOA_USAGE_STATS_ENDPOINT','TELOA_MARKET_REMOTE','TELOA_MARKET_API_ENDPOINT',
 // 运行目录、工作区、profile 与部署形态（决定数据库口令文件位置、沙箱写范围与数据库主机白名单）
 'TELOA_RUNTIME_ROOT','TELOA_WORKSPACE_ROOT','TELOA_DSH_PROFILE','TELOA_DEPLOYMENT',
 // 子 Agent 拆分上限（执行边界）
 'TELOA_SUBAGENT_MAX_DEPTH','TELOA_SUBAGENT_MAX_PER_RUN',
 // 版本：非 personal 值会让宿主装配失败（工作区 .env 可借它拒绝服务）
 'TELOA_EDITION',
] as const

/**
 * 宿主启动快照；宿主没有提供（测试替身、非产品组合）时按上游约定，以当前 `process.env` 作为唯一的 process 层。
 */
export function launchSnapshot(ctx:object):LaunchEnvironmentSnapshot{
 return typeof (ctx as {get?:unknown}).get==='function'?launchEnvironmentOf(ctx as Context):createLaunchEnvironmentSnapshot([{source:'process',values:process.env as Record<string,string>}])
}

/** 安全敏感 TELOA_* 的只读启动值。 */
export function securityEnv(ctx:object):LaunchEnv{
 return processLayerEnv(launchSnapshot(ctx),securityEnvNames)
}

/** 档位与主密钥来源变量（`credentials/provider.ts` 的 keySourceEnv 同样只认 process 层），一并纳入失效提醒。 */
const credentialEnvNames=['TELOA_CREDENTIALS_KEYRING','TELOA_CREDENTIALS_KEY_DIR','TELOA_CREDENTIALS_KEY_FILE','TELOA_CREDENTIALS_STORE','CREDENTIALS_DIRECTORY']

/**
 * 危险的非 TELOA 变量（关闭证书校验、注入 Node 参数、换 CA、改代理）。官方 DSH 已把它们列为 bootstrap 名：
 * 工作区 `.env` 里出现即拒绝启动（`dsh-app-boot` 的 isBootstrapOnly，按大写比较，小写代理名同样拒绝），`$DSH_HOME/.env`
 * 只放行代理四项（本人目录、不随仓库流转）。这里只作纵深：万一上游放宽，工作区层的值照样移除并提醒。
 */
export const dangerousProjectEnvNames=['NODE_TLS_REJECT_UNAUTHORIZED','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR',
 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']

/** 写在 `.env` 里、而启动环境没有的安全敏感变量：它们已不生效（危险的非 TELOA 变量只看工作区层）。 */
export function ignoredLaunchEnvNames(launch:LaunchEnvironmentSnapshot):string[]{
 const fromEnvFile=(name:string,layers:readonly ('project-env'|'user-env')[])=>!launch.getFrom(name,['process'])&&!!launch.getFrom(name,layers)
 return [...[...securityEnvNames,...credentialEnvNames].filter(name=>fromEnvFile(name,['project-env','user-env'])),...dangerousProjectEnvNames.filter(name=>fromEnvFile(name,['project-env']))]
}

/**
 * 宿主装配开头调用一次：把只来自 `.env` 层的这些名字从 `process.env` 移除（DSH 启动时已把它们合入），
 * 仍直接读 `process.env` 的代码（如 `readEdition()`、Node 自身、子进程继承）因此也看不到；再打一条只列变量名的提醒。
 */
export function warnIgnoredLaunchEnv(ctx:{logger:{warn:(format:string,...args:unknown[])=>void};get?:unknown}):void{
 const names=ignoredLaunchEnvNames(launchSnapshot(ctx))
 for(const name of names)delete process.env[name]
 if(names.length)ctx.logger.warn('以下安全相关变量写在 .env 中已不生效，请改在启动宿主的环境中设置：%s',names.join('、'))
}
