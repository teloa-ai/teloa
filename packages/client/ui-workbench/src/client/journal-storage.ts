import type {RecoveryJournal} from './recovery-error.ts'

/** 只用到读写删三个方法，便于单测与受限浏览器环境替换。 */
type WebStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>

// 既有键名形状：`teloa.<业务>/v<n>`，安全动作那八条多一段命令名。本模块只是把它们从
// 标签页私有存储搬到同源共享存储，一个新键都不开，所以键名规范要在这里就卡住。
const journalKey=/^teloa\.[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*\/v\d+$/

/**
 * 未决请求日志（request journal）的存储层。
 *
 * 为什么从 `sessionStorage` 换成同源共享存储：`sessionStorage` 是标签页私有的，关掉标签页
 * 那条"上一次到底发出去没有"的记录就没了（验收报告第六节已知边界 1）——而这正是未决请求
 * 唯一的价值所在，它必须活得比一次页面生命更长。换成 `localStorage` 之后同源的每个标签页
 * 读到同一个 `requestId`：重放落在服务端按 `requestId` 的幂等面上（`SecurityRequestJournal.reserve`
 * 与各业务表的天然唯一键），不会造出第二条请求；而在换之前，两个标签页各有一份私有存储，
 * 同一个意图会拿到两个不同的 `requestId`，那才是真的会多一条。
 *
 * 读写都直达存储、模块内不留副本：另一个标签页刚改完，本标签页下一次 `read()` 就看得到。
 */
export function createJournalStorage(key:string,storage:WebStorage|undefined):RecoveryJournal{
 if(!journalKey.test(key))throw Error('未决请求日志键名不合规范：'+key)
 return {
  read:()=>storage?.getItem(key)??null,
  write:value=>storage?.setItem(key,value),
  clear:()=>storage?.removeItem(key),
 }
}
