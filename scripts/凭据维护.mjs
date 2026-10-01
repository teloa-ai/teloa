// 源码仓库宿主的凭据维护（规格 §3.5）：回滚前导出明文、主密钥丢失时重置。npm 安装用 `teloa credentials`。
// 轮换按用户裁定不对外提供，只保留为 maintenance 模块的内部能力。
import {dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const [action,...rest]=process.argv.slice(2)
if(!['export-plaintext','reset'].includes(action??'')){console.error('用法：node scripts/凭据维护.mjs <export-plaintext|reset> --confirm（先停宿主，先 pnpm build）');process.exit(2)}
if(!rest.includes('--confirm')){console.error('该操作需要 --confirm。');process.exit(2)}
const {runCredentialMaintenance}=await import(pathToFileURL(resolve(projectRoot,'packages/harness-dsh/lib/credentials/maintenance.js')).href)
// runCredentialMaintenance 先经 assertHostStopped 核对运行标记：宿主未停即报错退出，不动任何文件。
try{console.log(await runCredentialMaintenance(action,{dshHome:resolve(projectRoot,process.env.TELOA_DSH_HOME||'.runtime/dsh')}))}
catch(error){console.error(error instanceof Error?error.message:'凭据维护失败。');process.exit(1)}
