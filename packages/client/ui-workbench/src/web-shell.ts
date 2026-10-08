// 刷新时浏览器先拿到官方前端包的首页与静态资源，工作台挂载后才换成 Teloa。这里只用 DSH 宿主公开的扩展点：
// 结构化注入行加过渡样式，tapIndex 换标题，具名路由在上游原地址提供网站图标与应用清单（优先于官方静态服务）。
// 不改官方包，也不在 #root 里放节点：官方渲染器把 #root 里的启动卡片水合后再换成应用，多一个节点会被当成启动卡片认领，
// 真正的启动卡片就留在工作台旁边。
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { prototypeThemes } from './brand/prototype-theme.ts'
import { teloaMarkSvg } from './brand/teloa-mark.ts'

declare module '@deepseek-ai/cordis'{interface Events{'webserver/index-inject'(table:unknown[]):void}}
type Handler=(req:IncomingMessage,res:ServerResponse)=>void
type WebServerSeat={
  tapIndex(transform:(html:string)=>string):()=>void
  register(route:{kind:'exact';path:string;handler:Handler}):()=>void
}

const light=prototypeThemes.light,dark=prototypeThemes.dark
const UPSTREAM_TITLE='<title>DeepSeek Harness</title>'

const asset=(type:string,body:string):Handler=>(req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
  res.writeHead(200,{'content-type':type})
  res.end(body)
}
const assets:Record<string,Handler>={
  '/favicon.svg':asset('image/svg+xml',teloaMarkSvg(light['--teloa-design-text']!)),
  '/favicon-dark.svg':asset('image/svg+xml',teloaMarkSvg(dark['--teloa-design-text']!)),
  // 只换名称并补 Teloa 浅色底色；入口、范围、显示方式与图标地址沿用上游清单。
  '/manifest.webmanifest':asset('application/manifest+json',JSON.stringify({
    name:'Teloa',short_name:'Teloa',start_url:'./',scope:'./',display:'fullscreen',
    icons:[{src:'favicon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}],
    theme_color:light['--teloa-design-bg'],background_color:light['--teloa-design-bg'],
  })),
}

const palette=(theme:Record<string,string>)=>
  `--teloa-boot-bg:${theme['--teloa-design-bg']};--teloa-boot-mark:url("data:image/svg+xml,${encodeURIComponent(teloaMarkSvg(theme['--teloa-design-text']!))}")`
/**
 * 过渡画面画在 #root 的伪元素上：#root 为空（入口脚本尚未执行）或只有仍在转圈的官方启动卡片时盖满视口；
 * 工作台挂载后 #root 换成应用节点即不再匹配；启动卡片转为失败说明（转圈消失）时让出，不挡住失败原因。
 * 深浅色先随系统；本人在设置里选过主题时，以官方主题启动行写下的标记为准，与工作台挂载后一致。
 */
const BOOT_STYLE=[
  `#root::before{${palette(light)}}`,
  `@media(prefers-color-scheme:dark){html:not([data-ds-theme-source]) #root::before{${palette(dark)}}}`,
  `body[data-ds-dark-theme] #root::before{${palette(dark)}}`,
  '#root:is(:empty,:has(>[data-dsh-boot]:only-child [data-dsh-boot-spinner]))::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;background:var(--teloa-boot-mark) center/56px 56px no-repeat var(--teloa-boot-bg)}',
].join('')

/** 浏览器首页的 Teloa 品牌；没有 webServer 的组合（桌面壳）只登记过渡样式行。 */
export function installWebShellBrand(ctx:Context):void{
  ctx.on('webserver/index-inject',(table:unknown[])=>{table.push({kind:'style',text:BOOT_STYLE})})
  ctx.inject(['webServer'],child=>{
    const server=child.get('webServer') as WebServerSeat
    child.effect(()=>server.tapIndex(html=>html.replace(UPSTREAM_TITLE,'<title>Teloa</title>')),'teloa: 首页标题')
    for(const [path,handler] of Object.entries(assets))child.effect(()=>server.register({kind:'exact',path,handler}),'teloa: 首页图标与清单')
  })
}
