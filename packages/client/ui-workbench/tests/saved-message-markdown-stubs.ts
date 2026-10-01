import * as React from 'react'

/**
 * 群协作页手搓渲染器（不走真实 reconciler，组件当普通函数调用）共用的三块桩；
 * 7 个测试文件一起用，不要各自复制。
 *
 * 背景：SavedMessage 正文改由 `@deepseek-ai/dsh-client-ui-primitives` 的 MarkdownText 渲染，
 * 并为其 labels 引用稳定性用了 useMemo。那个包是 DSH 平台模块（tsdown 预设 neverBundle，
 * 运行时由宿主 `__ModuleLoader__` 注入），它自带的 katex.min.css / anser / shiki / mdast-util-*
 * 一串依赖只在宿主里有，仓内 Node 下 import 会当场炸掉整个测试文件，所以只能给桩。
 */

/** 真 React.useMemo 没有 dispatcher 时直接抛错；这里按 deps 逐项 Object.is 比对的最小版本，槽位与 useState/useRef 共用。 */
export function testUseMemo(slots:unknown[],nextSlot:()=>number){
 return (compute:()=>unknown,deps:readonly unknown[]):unknown=>{
  const index=nextSlot(),previous=slots[index] as {value:unknown;deps:readonly unknown[]}|undefined
  if(previous&&deps.length===previous.deps.length&&deps.every((value,depIndex)=>Object.is(value,previous.deps[depIndex])))return previous.value
  const value=compute()
  slots[index]={value,deps}
  return value
 }
}

/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的透传桩：MarkdownText 原样吐 text，只保证模块能加载、正文可读。
 * 真实 GFM 解析不归这些测试验；group-routing-view.test.ts 另有一个认 `**加粗**` 与 `- 列表` 的最小复刻专门验接线。
 */
export const markdownPrimitivesStub={MarkdownText:({text}:{text:string})=>text}

/** 读一棵元素树的文本；函数组件（如 MarkdownText）把正文放在 text prop 而非 children 里，需调用穿透，与各文件 expand() 一致。 */
export const contentOf=(node:React.ReactNode):string=>{
 if(Array.isArray(node))return node.map(contentOf).join('')
 if(React.isValidElement<Record<string,any>>(node)){
  if(typeof node.type==='function')return contentOf((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return contentOf((node.props as {children?:React.ReactNode}).children)
 }
 return typeof node==='string'||typeof node==='number'?String(node):''
}
