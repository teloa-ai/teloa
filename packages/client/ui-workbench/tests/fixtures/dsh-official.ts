import {readFileSync} from 'node:fs'

/** 这些用例钉住的官方 DSH 版本：与 ui-workbench package.json 的 engines.dsh 同一事实源（当前 alpha.3）。 */
export const DSH_VERSION:string=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).engines.dsh

/**
 * 官方网页入口包启动段的起点（其前为 staticModules seeds）。压缩变量名随版本变化（alpha.1 为 `fo`、alpha.3 为 `Ms`），
 * 按 `const <名>=globalThis.dshDesktopBoot,` 结构定位；找不到返回 -1，由调用方断言。
 */
export function dshFrontendBootStart(source:string):number{
 return /const [A-Za-z_$][\w$]*=globalThis\.dshDesktopBoot,/.exec(source)?.index??-1
}
