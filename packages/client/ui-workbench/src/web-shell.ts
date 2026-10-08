// 刷新时浏览器先拿到官方前端包的首页与静态资源，工作台挂载后才换成 Teloa。这里只用 DSH 宿主公开的扩展点：
// 结构化注入行加过渡样式，tapIndex 换标题，具名路由在上游原地址提供网站图标与应用清单（优先于官方静态服务）。
// 不改官方包，也不在 #root 里放节点：官方渲染器把 #root 里的启动卡片水合后再换成应用，多一个节点会被当成启动卡片认领，
// 真正的启动卡片就留在工作台旁边。
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { prototypeThemes } from './brand/prototype-theme.ts'
import { TELOA_LOGOTYPE_SVG } from './brand/logotype-svg.ts'
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

const scheme=(theme:Record<string,string>)=>
  `--teloa-boot-bg:${theme['--teloa-design-bg']};--teloa-boot-text:${theme['--teloa-design-text']};--teloa-boot-track:${theme['--teloa-design-border']};--teloa-boot-ink:${theme['--teloa-design-muted']}`
// 变量只在 #root 为空或只有官方启动卡片时定义，工作台挂载后不再继承到应用里；不支持 :has() 的浏览器只认空 #root。
const BOOTING='#root:is(:empty,:not(:has(>:not([data-dsh-boot]))))'
const SHOWN='#root:is(:empty,:has(>[data-dsh-boot]:only-child [data-dsh-boot-spinner]))'
// 启动卡片转为失败说明后，卡片里第一个纯文字节点是官方字样，紧跟着带子节点的失败说明；说明文字不动。
const FAILED_WORDMARK='#root>[data-dsh-boot]:only-child:not(:has([data-dsh-boot-spinner]))>*>:first-child:not(:has(*)):has(+*>*)'
// 支持遮罩时，字形是遮罩、颜色取 currentColor：上方 96px 宽的字标，下方隔 16px 一条 2px 加载条。
const LOGOTYPE_MASK='var(--teloa-boot-logotype) 0 0/100% auto no-repeat,linear-gradient(#000 0 0) 0 100%/100% 2px no-repeat'
const BAR='linear-gradient(90deg,transparent,var(--teloa-boot-ink),transparent) -40px 100%/40px 2px no-repeat,linear-gradient(var(--teloa-boot-track) 0 0) 0 100%/100% 2px no-repeat'
const PULSE='linear-gradient(var(--teloa-boot-pulse) 0 0) 0 100%/100% 2px no-repeat'
const MASKABLE='@supports (mask-image:url("")) or (-webkit-mask-image:url(""))'
/**
 * 过渡画面画在 #root 的两个伪元素上：::before 盖满视口，::after 是加载条；支持遮罩时 ::after 再扩成字标加加载条。
 * #root 为空（入口脚本尚未执行）或只有仍在转圈的官方启动卡片时显示；工作台挂载后 #root 换成应用节点即不再匹配；
 * 启动卡片转为失败说明（转圈消失）时让出，支持遮罩时把卡片上的官方字样换成 Teloa 字标，颜色沿用卡片自己的文字色。
 * 字形只内嵌一份（刷新首页不缓存），按主题令牌着色。深浅色先随系统；本人在设置里选过主题时，以官方主题启动行写下的标记为准，
 * 与工作台挂载后一致。减少动效时加载条只缓慢呼吸。不支持遮罩的浏览器只显示底色与加载条，失败卡保留原字样。
 */
const BOOT_STYLE=[
  `${BOOTING}{--teloa-boot-logotype:url("data:image/svg+xml,${encodeURIComponent(TELOA_LOGOTYPE_SVG)}");${scheme(light)}}`,
  `@media(prefers-color-scheme:dark){html:not([data-ds-theme-source]) ${BOOTING}{${scheme(dark)}}}`,
  `body[data-ds-dark-theme] ${BOOTING}{${scheme(dark)}}`,
  `${SHOWN}::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;background:var(--teloa-boot-bg)}`,
  `${SHOWN}::after{content:"";position:fixed;z-index:1;pointer-events:none;left:calc(50% - 48px);top:calc(50% + 14px);width:96px;height:2px;color:var(--teloa-boot-text);background:${BAR};animation:teloa-boot-sweep 1.4s ease-in-out infinite}`,
  '@keyframes teloa-boot-sweep{to{background-position:96px 100%,0 100%}}',
  // 减少动效时不扫动：加载条颜色在边框色与次要文字色之间缓慢往返（需要注册的颜色变量才能平滑过渡）。
  "@property --teloa-boot-pulse{syntax:'<color>';inherits:false;initial-value:transparent}",
  `@media(prefers-reduced-motion:reduce){${SHOWN}::after{background:${PULSE};animation:teloa-boot-breathe 2.4s ease-in-out infinite alternate}}`,
  '@keyframes teloa-boot-breathe{from{--teloa-boot-pulse:var(--teloa-boot-track)}to{--teloa-boot-pulse:var(--teloa-boot-ink)}}',
  `${MASKABLE}{${SHOWN}::after{top:calc(50% - 21px);height:37px;background-color:currentColor;-webkit-mask:${LOGOTYPE_MASK};mask:${LOGOTYPE_MASK}}`
    +`${FAILED_WORDMARK}{width:96px;height:19px;font-size:0;background:currentColor;-webkit-mask:var(--teloa-boot-logotype) center/contain no-repeat;mask:var(--teloa-boot-logotype) center/contain no-repeat}}`,
].join('')
const OWN_STYLE=`<style>${BOOT_STYLE}</style>`
const CHARSET=/<meta\s+charset[^>]*>/i

/** 结构化行排在 <head> 开标签之后；字符集声明须在文档前 1024 字节内，把这段样式挪到它后面，其余行的内容与顺序不动。 */
function placeAfterCharset(html:string):string{
  if(!html.includes(OWN_STYLE))return html
  const rest=html.replace(OWN_STYLE,''),charset=CHARSET.exec(rest)
  if(!charset)return html
  const at=charset.index+charset[0].length
  return rest.slice(0,at)+OWN_STYLE+rest.slice(at)
}

/** 浏览器首页的 Teloa 品牌；没有 webServer 的组合（桌面壳）只登记过渡样式行。 */
export function installWebShellBrand(ctx:Context):void{
  ctx.on('webserver/index-inject',(table:unknown[])=>{table.push({kind:'style',text:BOOT_STYLE})})
  ctx.inject(['webServer'],child=>{
    const server=child.get('webServer') as WebServerSeat
    child.effect(()=>server.tapIndex(html=>placeAfterCharset(html.replace(UPSTREAM_TITLE,'<title>Teloa</title>'))),'teloa: 首页标题与过渡样式位置')
    for(const [path,handler] of Object.entries(assets))child.effect(()=>server.register({kind:'exact',path,handler}),'teloa: 首页图标与清单')
  })
}
