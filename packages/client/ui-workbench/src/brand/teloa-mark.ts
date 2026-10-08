// 方块标的 T 字形，与同目录 teloa-mark.svg 同源（web-shell-brand 测试核对字形一致）。
// 服务端没有 SVG 导入；刷新首页的网站图标与过渡画面由这里生成单色标识。
const VIEW_BOX='-16 -19 138 138'
const PATH='M0.5 -2.5 105.5 -2.5 105.5 11.0153 60.449 11.0153 60.449 102.5 45.551 102.5 45.551 11.0153 0.5 11.0153Z'

/** 单色方块标；ink 取主题文字色。 */
export const teloaMarkSvg=(ink:string):string=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" width="138" height="138"><path fill="${ink}" d="${PATH}"/></svg>`
