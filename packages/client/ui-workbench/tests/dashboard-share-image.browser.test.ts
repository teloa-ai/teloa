import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('看板 PNG：真实图表、精确文本、中文换行与元数据完整导出；外部资源、污染与超限明确失败',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-dashboard-share-image-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.ts'),`import {dashboardSharePng} from ${JSON.stringify(join(client,'dashboard-share-image.ts'))};window.dashboardSharePng=dashboardSharePng`)
 const built=await build({configFile:false,root,logLevel:'error',build:{write:false,minify:false,rollupOptions:{input:join(temp,'fixture.ts'),output:{format:'iife',inlineDynamicImports:true}}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(5000)
 const requests:string[]=[]
 await page.route('**/*',async (route:any)=>{requests.push(route.request().url());await route.abort()})
 await page.setContent(`<!doctype html><html><body style="font-family:system-ui"><main id="grid">
 <article data-widget="conversion" style="width:720px"><h3>登录转化漏斗</h3><p>精确读数 123.4567；本期 2026-10-01 至 2026-10-21。</p>
 <svg width="360" height="90" viewBox="0 0 360 90"><defs><linearGradient id="tone"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#ff0000"/></linearGradient></defs><rect width="360" height="90" fill="url(#tone)"/></svg>
 <ol><li>净变化 -75 <span style="display:inline-block;width:200px;height:8px;background:#eee"><i style="display:block;width:50%;margin-left:25%;height:8px;background:rgb(0,200,0)"></i></span></li></ol>
 <table><thead><tr><th>来源</th><th>原始金额</th></tr></thead><tbody><tr><td>邮件</td><td>CNY 123456789012345.6789</td></tr><tr><td>${'中文说明不可省略。'.repeat(35)}</td><td>末行 999.0001</td></tr></tbody></table></article>
 <article data-widget="canvas" style="width:720px"><h3>画布图表</h3><canvas width="280" height="70"></canvas><p>末张卡片，完整保留。</p></article></main></body></html>`)
 await page.addScriptTag({content:bundle.output.filter(x=>x.type==='chunk').map(x=>x.code).join('\n')})
 await page.evaluate(()=>{const canvas=document.querySelector('canvas')!,context=canvas.getContext('2d')!;context.fillStyle='#0044ff';context.fillRect(0,0,canvas.width,canvas.height)})
 const result=await page.evaluate(async()=>{
  const metadata={title:'登录转化漏斗 · 导出验收',scope:'产品研发',version:'v2 · abc1234567',timeRange:'最近 30 天',capturedAt:'2026-10-21 19:00:00 +08:00'}
  const blob=await (window as any).dashboardSharePng(document.querySelector('#grid'),metadata)
  const image=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
  const context=canvas.getContext('2d')!;context.drawImage(image,0,0)
  const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let red=0,green=0,blue=0,ink=0,greenLeft=canvas.width,greenRight=0
  for(let i=0;i<pixels.length;i+=4){const r=pixels[i]!,g=pixels[i+1]!,b=pixels[i+2]!;if(r>230&&g<30&&b<30)red++;if(r<30&&g>170&&b<30){green++;const x=i/4%canvas.width;greenLeft=Math.min(greenLeft,x);greenRight=Math.max(greenRight,x)}if(r<30&&g<100&&b>230)blue++;if(r<100&&g<120&&b<140)ink++}
  image.close()
  return {type:blob.type,width:canvas.width,height:canvas.height,red,green,greenLeft,greenRight,blue,ink,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))}
 })
 assert.equal(result.type,'image/png');assert.equal(result.width,1200);assert.ok(result.height>800&&result.height<3000)
 assert.ok(result.red>=30_000,'SVG 图形及本图渐变必须实际画入 PNG')
 assert.ok(result.green>=5_000,'原生 HTML 柱条必须保留')
 assert.equal(result.greenLeft,330,'负值柱的相对起点必须保留');assert.equal(result.greenRight,869)
 assert.ok(result.blue>=15_000,'原 canvas 图表必须实际画入 PNG')
 assert.ok(result.ink>5_000,'标题、范围、精确读数与完整中文文本必须可见')
 const bytes=Buffer.from(result.bytes);assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(bytes.readUInt32BE(16),result.width);assert.equal(bytes.readUInt32BE(20),result.height)
 const evidence=process.env.TELOA_DASHBOARD_SHARE_TEST_OUTPUT
 if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'dashboard-share.png'),bytes);await writeFile(join(evidence,'image-result.json'),JSON.stringify({...result,bytes:bytes.length},null,2)+'\n')}
 assert.deepEqual(requests,[],'正常导出完全在本地完成')
 const failure=async (html:string,metadata?:Record<string,string>)=>page.evaluate(async ({html,metadata}:{html:string;metadata?:Record<string,string>})=>{
  document.querySelector('#grid')!.innerHTML=html
  try{await (window as any).dashboardSharePng(document.querySelector('#grid'),metadata??{title:'test',scope:'test',version:'v1',timeRange:'all',capturedAt:'now'});return 'unexpected-success'}catch(error){return (error as any).code}
 },{html,metadata})
 assert.equal(await failure('<article data-widget="bad"><h3>未完成图表</h3><div data-widget-chart="bad"></div></article>'),'not-ready')
 assert.equal(await failure('<article data-widget="bad"><svg width="100" height="100"><foreignObject width="100" height="100"><div>HTML</div></foreignObject></svg></article>'),'unsupported')
 assert.equal(await failure('<article data-widget="bad"><svg width="100" height="100"><image href="https://example.invalid/private.png" width="100" height="100"/></svg></article>'),'unsupported')
 assert.equal(await failure('<article data-widget="bad"><svg width="100" height="100"><use href="https://example.invalid/chart.svg#private"/></svg></article>'),'unsupported')
 assert.equal(await failure('<article data-widget="large"><p>'+('长'.repeat(100_001))+'</p></article>'),'too-large')
 assert.equal(await failure('<article data-widget="large"><p>data</p></article>',{title:'长'.repeat(10_001),scope:'test',version:'v1',timeRange:'all',capturedAt:'now'}),'too-large')
 assert.equal(await failure('<article data-widget="large"><svg width="10000" height="10000"><rect width="1" height="1"/></svg></article>'),'too-large')
 assert.deepEqual(requests,['https://example.invalid/private.png'],'只有插入原夹具触发的图片请求被阻断；导出器不复制或加载外部资源')

 // about:blank 与临时本机图片源不同源，真实污染 canvas，而非模拟 toDataURL 抛错。
 const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=','base64')
 const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'image/png'});response.end(pixel)})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
 const address=server.address();assert.ok(address&&typeof address!=='string');const source='http://127.0.0.1:'+address.port+'/pixel.png'
 await page.unroute('**/*');await page.route('**/*',async (route:any)=>{if(route.request().url()===source)await route.continue();else await route.abort()})
 const tainted=await page.evaluate(async (source:string)=>{
  document.querySelector('#grid')!.innerHTML='<article data-widget="tainted"><h3>图表</h3><canvas width="2" height="2"></canvas></article>'
  const image=new Image();image.src=source;await image.decode();document.querySelector('canvas')!.getContext('2d')!.drawImage(image,0,0)
  try{await (window as any).dashboardSharePng(document.querySelector('#grid'),{title:'test',scope:'test',version:'v1',timeRange:'all',capturedAt:'now'});return 'unexpected-success'}catch(error){return (error as any).code}
 },source)
 assert.equal(tainted,'image-failed')
})
