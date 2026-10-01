import {realpathSync} from 'node:fs'
import {basename,dirname,resolve,sep} from 'node:path'

/**
 * 取“最长已存在祖先的真实路径”再拼回尚未创建的尾段。
 * 运行目录可能还没建出来，不能直接对整段取 realpath；而宿主的 Skill provider 返回的是
 * realpath 规范路径，祖先带软链（如 macOS 的 /var）时不规范化会让受管 Skill 全被判成他源。
 */
export function canonicalizePath(path:string):string{
  const absolute=resolve(path),tail:string[]=[]
  let current=absolute
  for(;;){
    // 祖先不可读或不存在都继续上溯；解析不到任何真实祖先时退回原路径，保持此前不抛错的行为。
    try{return resolve(realpathSync(current),...tail)}catch{}
    const parent=dirname(current)
    if(parent===current)return absolute
    tail.unshift(basename(current))
    current=parent
  }
}

/** 宿主内传入只读启动快照（`launch-env.ts` 的 securityEnv）；缺省读 process.env 只给脚本与测试用。 */
type PathEnv=Readonly<Record<string,string|undefined>>
export function resolveTeloaRuntime(projectRoot:string,env:PathEnv=process.env):string{
  const configured=env.TELOA_RUNTIME_ROOT?.trim()
  return canonicalizePath(configured?configured:resolve(projectRoot,'.runtime/teloa'))
}

/**
 * 默认工作区收敛到运行目录下的专用目录，而不是仓库根。
 * 会话的沙箱写范围与原生终端的初始目录都取这个工作区：落在仓库根时，
 * 已认证会话可直接写 packages/、config/、.runtime/ 与 .git。
 */
export function resolveTeloaWorkspaceRoot(projectRoot:string,env:PathEnv=process.env):string{
  const configured=env.TELOA_WORKSPACE_ROOT?.trim()
  return canonicalizePath(configured?configured:resolve(resolveTeloaRuntime(projectRoot,env),'workspace'))
}

/** `child` 是否严格位于 `parent` 之下（同一路径不算）。两侧都应当已是规范路径。 */
function within(parent:string,child:string):boolean{
  return child.startsWith(parent.endsWith(sep)?parent:parent+sep)
}

/**
 * 工作区能否用于本仓库的会话。工作区同时是会话的沙箱写范围与原生终端的初始目录，判据：
 * - 等于仓库根，或是仓库根的祖先 → 拒绝。一次已认证会话就能改写整个仓库。
 * - 位于仓库内 → 只允许 `<仓库>/.runtime/` **之下**（正式的 `.runtime/teloa/workspace`
 *   与验收的 `.runtime/teloa-e2e-<后缀>/workspace` 都在其中）。`packages/`、`config/` 这类源码
 *   目录一律拒绝——落在它们上面，沙箱与终端就直接写在本程序自己的代码上。
 *   `.runtime` 目录本身也拒绝：它下面还有数据库口令与全部会话日志。
 * - 位于仓库之外 → 允许。那是用户自己的目录，本程序不该替他决定。
 * 两侧都按规范路径比较：登记里的工作区路径是 realpath，仓库根不一定是。
 */
export function workspaceRefusedForRepository(workspacePath:string,repositoryRoot:string):boolean{
  const workspace=canonicalizePath(workspacePath),repository=canonicalizePath(repositoryRoot)
  if(workspace===repository||within(workspace,repository))return true
  if(!within(repository,workspace))return false
  return !within(resolve(repository,'.runtime'),workspace)
}

export function resolveTeloaDshHome(projectRoot:string):string{
  const configured=process.env.DSH_HOME?.trim()
  return configured?resolve(configured):resolve(projectRoot,'.runtime/dsh')
}

export function resolveTeloaDshProfile(env:PathEnv=process.env):string{
  return env.TELOA_DSH_PROFILE?.trim()||'teloa'
}
