import {readFileSync} from 'node:fs'
/**
 * 应用拉取在线市场索引（https://market.teloa.ai/index.json）的开关与内置公钥。
 *
 * 开关（沿用使用统计 usage-stats.ts 的排除逻辑）：
 * - TELOA_MARKET_REMOTE=off 明确关闭；CI=true、TELOA_BROWSER_ACCEPTANCE=1（验收）、NODE_ENV=development 一律关闭；
 * - 宿主缺省关闭（default-off），只有 TELOA_MARKET_REMOTE=on 才拉取；市场三期的 npm runtimeEnvironment 与容器发行入口显式设置 on，源码启动与测试缺省不变。
 */
export type MarketRemoteExclusionReason='env-off'|'ci'|'acceptance'|'dev'|'default-off'

export function detectMarketRemoteExclusion(env:NodeJS.ProcessEnv=process.env):MarketRemoteExclusionReason|undefined{
 if(env.TELOA_MARKET_REMOTE==='off')return 'env-off'
 if(env.CI==='true')return 'ci'
 if(env.TELOA_BROWSER_ACCEPTANCE==='1')return 'acceptance'
 if(env.NODE_ENV==='development')return 'dev'
 if(env.TELOA_MARKET_REMOTE!=='on')return 'default-off'
 return undefined
}

/**
 * 市场索引 Ed25519 验签公钥（SPKI PEM）。
 * 生产公钥（2026-09-25 生成）。生产私钥只放 teloa-ai/marketplace 的 GitHub Actions Secret
 * （TELOA_MARKET_SIGNING_KEY）与本人离线备份；本机副本在 .runtime/teloa/market-signing/production/（不入库）。
 * 开发密钥仍在 .runtime/teloa/market-signing/ 根目录，仅供本机调试，check:market-index --production 会拒绝它。
 */
export const MARKET_INDEX_PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFSp1Bn9wO8fC2tD17aQouchH4lHOJnTUKkk7xi2xMKM=
-----END PUBLIC KEY-----
`

/** 本机应用版本，供 v2 在线索引按 compatibility.teloa 过滤。 */
export const TELOA_APP_VERSION:string=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version
