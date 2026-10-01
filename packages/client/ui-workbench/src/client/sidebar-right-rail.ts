import type {ISidebarRight,TabId} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {TeloaTabKind,TeloaTabParams} from './sidebar-right-tabs.js'
import type {WorkbenchDetailTarget} from './workbench-detail-target.js'

/** Teloa 真正用到的右栏控制面：开页签、读活动页签、关页签。 */
export type RailFace=Pick<ISidebarRight,'active'|'openTab'|'close'>

/**
 * 详情目标的身份。页签与页内详情是同一份内容的两种承载，用同一把钥匙对上号。
 *
 * 按固定字段顺序拼，不用 `JSON.stringify`：同一个目标经过 store 写回、经过持久化解析重建之后，
 * 字段书写顺序可能不同，序列化字符串就会对不上，页签与详情从此互不相认。
 * 版本号不进钥匙——同一个任务的不同版本仍是同一个对象，不该算两个页签。
 */
export function railTargetKey(target:WorkbenchDetailTarget|null):string{
  if(!target)return ''
  // 用 NUL 作分隔并写成显式转义：业务范围标签是 1～80 字的自由文本，空格、冒号、斜杠都可能出现在
  // 字段值里，拿它们当分隔就会把「范围 A + 栏目 B」和「范围 A B」拼成同一把钥匙。
  const join=(...parts:readonly string[])=>parts.join('\u0000')
  if(target.kind==='conversation-object'){
    if(target.objectKind==='business')
      return join(target.kind,'business',target.sessionId,target.target.scope,target.target.section,target.target.id??'',target.target.objectType??'')
    return join(target.kind,target.objectKind,target.sessionId,target.id)
  }
  if(target.kind==='artifact'){
    // 成果来源的判别字段按 ArtifactSourceRef：analysis 还带 scope，object 还带 scope 与 objectType，
    // 少拼一个就会让同一个 id 的不同来源共用一把钥匙。
    const source=target.source
    return join(target.kind,source.kind,source.id,'scope' in source?source.scope:'','objectType' in source?source.objectType:'',target.sessionId??'',target.artifactId??'')
  }
  return join(target.kind,target.view,target.id,target.source.kind)
}

/**
 * 原生右栏页签与页内详情之间的记账。
 *
 * 存在的理由是 DSH 的四条事实：
 * 1. `openTab({replaceTab})` 先跑被替换页签的关闭钩子、再提交新页签（`sidebar-right/lib/client.js:1386`），
 *    所以关闭钩子里读到的“当前详情”已经是新的——不比对身份就会把刚写好的详情抹掉；
 * 2. `openTab(): void` 不回传新页签的 id，而 `active()` 读的是**上一次提交**渲染出来的快照
 *    （`client.js:928,988` 的 bind 发生在事件处理器返回之后），所以开完页签当场是取不到新 id 的——
 *    真实 id 只能由挂载起来的座位用 `useTabInfo()` 回报（`bindTab`）；
 * 3. service face 每次取都可能抛（插件未装、未就绪、开页被拒），所以一律重新取 + try/catch；
 * 4. tab id 由**每个会话自己的计数器**铸造（`client.js:346`），跨会话必然重号，而 `replaceTab`
 *    指到本会话没有的 id 时 `findTabPane` 直接抛（`dockkit/lib/index.js:114`）。
 *
 * 三个页类型都是 `multiple:false`，一个 kind 在一个 pane 里至多一个页签，
 * 所以记账按 kind 而不是按 tab id：开页签当场拿不到 id，kind 却是当场就知道的。
 * 又因为第 4 条，账本还得按会话分开：一个会话一本，切页签不清、切会话天然隔离。
 *
 * **页签是真源**：`release` 与 `closeCurrent` 只认这本按 (会话, kind) 记的账，不再与"页内详情此刻
 * 指着谁"比对。页内详情是单值的，会话往返、或详情落到右栏接不住的页类型上时它就指不回来了，
 * 拿它当判据会让还在条上的页签变成死控件（正文"关闭"关不掉、收起也空转）。
 *
 * 这里只做记账与调用，不碰 React，也不碰 store：`release` 只回答“该不该收页内详情”。
 * @param face - 取右栏控制面；每次调用都重新取，取不到或抛了都算右栏不可用。
 * @param mine - 判断一个页签的 kind 是不是 Teloa 自己的；只有确认是自己的页签才允许被 replaceTab 顶掉。
 */
export function createRailTabs(face:()=>RailFace|undefined,mine:(kind:string)=>boolean){
  /** 一本按 kind 记的账，每个会话一本。 */
  type Book<V>=Map<string,Map<string,V>>
  /** 会话 → kind → 这个页签此刻承载的详情身份。 */
  const targets:Book<string>=new Map()
  /** 会话 → kind → 座位回报的真实 tab id。 */
  const ids:Book<TabId>=new Map()
  /**
   * 正在 `openTab` 里换页签。`replaceTab` 先跑被替换页签的关闭钩子、再提交新页签，
   * 这一刻的 `release` 说的是"旧页签走了"，不是"用户要收详情"——必须清账但答 false。
   */
  let replacing=false
  let restored=false
  /** 记一笔；这个会话还没有账本就当场建一本（只在写入时建，读不到就是读不到，不留空壳）。 */
  const put=<V,>(book:Book<V>,session:string,kind:string,value:V)=>{
    const page=book.get(session)
    if(page)page.set(kind,value)
    else book.set(session,new Map([[kind,value]]))
  }
  /** 销掉这个会话名下某个 kind 的账。 */
  const drop=(session:string,kind:string)=>{targets.get(session)?.delete(kind);ids.get(session)?.delete(kind)}
  /** 整本作废：这个会话的记账已经不可信（认不出是自己的页签、或 id 已经失效）。 */
  const forget=(session:string)=>{targets.delete(session);ids.delete(session)}
  const withFace=<T,>(work:(rail:RailFace)=>T):T|undefined=>{
    try{
      const rail=face()
      return rail?work(rail):undefined
    }catch{return undefined}
  }
  /**
   * 活动页签正好就是这个 id 时，它的真实 kind 说了算：不是 Teloa 的就别去顶。
   * `active()` 只反映上一次提交，也只认得活动页签，所以它只能证伪、不能证真——
   * 证不了伪的那些交给 `open` 的自愈兜底。
   */
  const foreign=(rail:RailFace,tabId:TabId):boolean=>{
    let active
    try{active=rail.active()}catch{return false}
    return active!==undefined&&active.id===tabId&&!mine(active.kind)
  }
  function open(session:string,kind:TeloaTabKind,params:TeloaTabParams[TeloaTabKind],target:WorkbenchDetailTarget){
    const key=railTargetKey(target)
    withFace(rail=>{
      // 不允许两个 Teloa 页签并存：本会话已有的那个让位，不论它此刻是不是活动页签。
      // state.detail 是单值的，两个页签并存就意味着其中一个永远指不回页内详情。
      // 同 kind 再开一次时 DSH 走「揭示既有页签」那条路（`multiple:false` 在目标 pane 内去重）：
      // 不跑关闭钩子，也不换 tab id，所以那一支不能把 id 抹掉。
      // 判"本会话已有 Teloa 页签"要问 targets（open() 当场写的真源账本），不能问 ids：
      // ids 只在座位挂载后才会回报，页签开进折叠/非活动 pane、正文从未挂载时 ids 拿不到号，
      // 但 targets 上那笔账依然是真的——拿 ids 当判据会让这一刻的 open() 完全看不见旧页签。
      const existingKind=[...(targets.get(session)?.keys()??[])][0]
      let replaced:readonly [string,TabId]|undefined
      if(existingKind!==undefined){
        const tabId=ids.get(session)?.get(existingKind)
        // 只顶确认是自己的页签：记的 kind 得是 Teloa 的，活动页签正好是它时真实 kind 也得是，
        // 而且必须真的取得到号——取不到号就没法 replaceTab，先把这一笔旧账 drop 掉，
        // 接受一次并存（记账仍只按 kind 单笔，drop 之后立刻会被下面新写的一笔顶上）。
        if(tabId!==undefined&&mine(existingKind)&&!foreign(rail,tabId))replaced=[existingKind,tabId]
        else drop(session,existingKind)
      }
      try{
        replacing=replaced!==undefined
        rail.openTab(kind,{params,...(replaced===undefined?{}:{replaceTab:replaced[1]})})
      }catch(error){
        // 带着 replaceTab 抛，多半是这个 id 已经不在本会话的布局里（`findTabPane` 对未知 id 直接抛）。
        // 不自愈的话这笔死账永不清除，此后每次开页签都失败，而页内第三栏又被 railServes 抑制，
        // 用户点一行什么都不出现。清账后不带 replaceTab 重开一次；再失败就照旧退回错误显示。
        replacing=false
        if(replaced===undefined)throw error
        forget(session)
        rail.openTab(kind,{params})
        put(targets,session,kind,key)
        return
      }finally{replacing=false}
      if(replaced!==undefined&&replaced[0]!==kind)drop(session,replaced[0])
      put(targets,session,kind,key)
    })
  }
  return {
    withFace,
    /** 右栏此刻可用吗；取不到或抛了都算不可用。 */
    available:()=>withFace(()=>true)===true,
    /** 记账里认得的页签数；给了会话就只数这一本。仅供测试与诊断。 */
    size:(session?:string)=>session===undefined
      ?[...targets.values()].reduce((sum,page)=>sum+page.size,0)
      :targets.get(session)?.size??0,
    open,
    /**
     * 座位挂载时回报自己所在会话与自己的 tab id：`openTab` 不回传 id，`active()` 又只反映上一次提交，
     * 唯一知道真实 id 的就是画出来的那个座位自己；而 id 只在它自己的会话里唯一。
     *
     * **座位卸载不注销**：DockKit 每个 pane 只挂载活动页签的正文（`dockkit/lib/index.js:2718`），
     * 用户点一下终端页签，Teloa 座位就卸载了，可页签还好端端地留在条上——这时把 id 抹掉，
     * 之后「收起对象详情」就查不到 id 静默空转，页签再也收不回来。
     * 登记只在被新的 bind 顶替、或 `release(session,kind)` 时清除；对已失效的 id 调 `close` 是安全的
     * （`closeIn` 先查 `layout.tabs[tabId]`，不存在直接 return）。
     */
    bindTab(session:string,kind:string,tabId:TabId):void{put(ids,session,kind,tabId)},
    /**
     * 刷新后由内容插件自己重开一次页签：DSH 的布局与页签全是内存态，Teloa 这边 state.detail 已落盘。
     * 只重开一次，之后用户自己的开关不被覆盖。
     * @returns 是否真的重开了页签。
     */
    restoreOnce(session:string,request:{kind:TeloaTabKind;params:TeloaTabParams[TeloaTabKind];target:WorkbenchDetailTarget}|null):boolean{
      if(restored)return false
      // 只有真的重开过才算用掉这一次机会：这一次没有可恢复的目标，就什么也没恢复，
      // 不该把名额记掉。同 kind 再开一次走 DSH 的「揭示既有页签」，也不会顶掉用户自己开的那个。
      if(!request)return false
      open(session,request.kind,request.params,request.target)
      restored=true
      return true
    },
    /**
     * 关闭钩子：这个会话里这个页类型的页签在账上，就该把页内详情一起收掉——页签是真源。
     * 只有 `replaceTab` 途中那一次例外：那时旧页签是被新页签挤走的，不是用户要收详情。
     * @param session - 关闭钩子给的会话身份；别的会话关页签不该动这边的详情。
     * @param kind - 关闭钩子给的 `tab.kind`。
     * @returns 调用方是否应当 `closeDetail()`。
     */
    release(session:string,kind:string):boolean{
      const known=targets.get(session)?.has(kind)===true
      drop(session,kind)
      return known&&!replacing
    },
    /**
     * 收起这个会话名下所有 Teloa 页签；账上没有、或座位还没回报 id 就什么都不做，不去动别人的页签。
     * 正常情况下同时至多一笔账，但 `open()` 取不到号时会短暂接受一次并存（见上），
     * 这里把该会话名下全部 kind 都关掉，让账本能从并存里自愈，不留下收不掉的死账。
     */
    closeCurrent(session:string){
      for(const kind of [...(targets.get(session)?.keys()??[])]){
        const tabId=ids.get(session)?.get(kind)
        drop(session,kind)
        if(tabId!==undefined)withFace(rail=>rail.close(tabId))
      }
    },
  }
}

export type RailTabs=ReturnType<typeof createRailTabs>
