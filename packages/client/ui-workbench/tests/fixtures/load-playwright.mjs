// 浏览器用例的 Playwright 只从本工作树解析（不借其他工作树或主目录的依赖）：
// 只使用仓库根依赖；TELOA_TEST_PLAYWRIGHT 可改包名。
import {readdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const worktree=new URL('../../../../../',import.meta.url)
export function loadPlaywright(){
 const name=process.env.TELOA_TEST_PLAYWRIGHT??'playwright'
 for(const base of ['package.json']){try{return createRequire(new URL(base,worktree))(name)}catch{}}
 const store=fileURLToPath(new URL('node_modules/.pnpm/',worktree))
 const installed=readdirSync(store).find(entry=>entry.startsWith('playwright@'))
 if(!installed)throw Error('当前工作树未安装 Playwright：先运行 npm install --no-save --ignore-scripts playwright@1.63.0')
 return createRequire(new URL(`node_modules/.pnpm/${installed}/node_modules/playwright/package.json`,worktree))('playwright')
}
/** 只用无界面浏览器；默认驱动本机或 CI 跑者自带的 Chrome，PLAYWRIGHT_CHANNEL 可改。 */
export const launchOptions=()=>({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true})
