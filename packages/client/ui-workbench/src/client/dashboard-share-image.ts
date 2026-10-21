export type DashboardShareImageMetadata={title:string;scope:string;version:string;timeRange:string;capturedAt:string}
export type DashboardShareImageErrorCode='not-ready'|'too-large'|'unsupported'|'image-failed'
export class DashboardShareImageError extends Error{
 constructor(readonly code:DashboardShareImageErrorCode){super(code);this.name='DashboardShareImageError'}
}

type TextBlock={kind:'text';text:string;heading:boolean}
type ImageBlock={kind:'image';source:string;width:number;height:number}
type BarBlock={kind:'bar';fraction:number;offset:number;color:string}
type Block=TextBlock|ImageBlock|BarBlock
const WIDTH=1200,PADDING=40,INNER=WIDTH-PADDING*2,CARD=INNER-40,MAX_NODES=30_000,MAX_TEXT=100_000,MAX_HEIGHT=16_000
const font=(size:number,weight=400)=>`${weight} ${size}px system-ui, -apple-system, sans-serif`
function fail(code:DashboardShareImageErrorCode):never{throw new DashboardShareImageError(code)}
const normal=(text:string)=>text.replace(/\s+/gu,' ').trim()

/** 导出是可阅读的单列静态排版；表格保留所有已显示行，图表取当前绘图，不把聚合数据重算成原始数据。 */
function capture(grid:HTMLElement):Block[][]{
 const cards=Array.from(grid.querySelectorAll<HTMLElement>('article[data-widget]'))
 if(!grid.isConnected||!cards.length)fail('not-ready')
 if(cards.length>64||grid.querySelectorAll('*').length>MAX_NODES)fail('too-large')
 let characters=0
 const visible=(element:Element)=>{const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse'}
 return cards.map(card=>{
  if(!visible(card)||!card.getBoundingClientRect().width)fail('not-ready')
  const blocks:Block[]=[],buffer:string[]=[]
  const append=(text:string,heading=false)=>{
   text=normal(text);if(!text)return
   characters+=text.length;if(characters>MAX_TEXT)fail('too-large')
   blocks.push({kind:'text',text,heading})
  }
  const flush=()=>{append(buffer.join(' '));buffer.length=0}
  const visit=(node:Node):void=>{
   if(node.nodeType===Node.TEXT_NODE){if(node.textContent)buffer.push(node.textContent);return}
   if(!(node instanceof Element)||!visible(node))return
   if(node.matches('script,style,template,[data-drilldown-open]'))return
   if(node instanceof SVGSVGElement){
    flush();const bounds=node.getBoundingClientRect()
    if(bounds.width*bounds.height>20_000_000)fail('too-large')
    if(bounds.width&&bounds.height)blocks.push({kind:'image',source:svgSource(node),width:bounds.width,height:bounds.height})
    return
   }
   if(node instanceof HTMLCanvasElement){
    flush();if(!node.width||!node.height)fail('not-ready')
    if(node.width*node.height>20_000_000)fail('too-large')
    let source:string
    try{source=node.toDataURL('image/png')}catch{fail('image-failed')}
    blocks.push({kind:'image',source,width:node.width,height:node.height});return
   }
   // 普通看板不包含嵌入媒体；拒绝遗漏或意外读取第三方图片。
   if(node.matches('img,iframe,object,embed,video,audio,foreignObject'))fail('unsupported')
   if(node.tagName==='TABLE'){
    flush()
    for(const row of Array.from((node as HTMLTableElement).rows))append(Array.from(row.cells).map(cell=>normal(cell.textContent??'')).join('  |  '),row.parentElement?.tagName==='THEAD')
    return
   }
   // 原生流水线与类型化柱条以现有几何尺寸导出，文字仍保留完整精确读数。
   if(node.tagName==='LI'){
    const bars=Array.from(node.querySelectorAll<HTMLElement>('i')).filter(bar=>visible(bar)&&getComputedStyle(bar).backgroundColor!=='rgba(0, 0, 0, 0)'&&bar.parentElement&&bar.getBoundingClientRect().height>0)
    if(bars.length){
     flush();append(node.textContent??'')
     for(const bar of bars){
      const bounds=bar.getBoundingClientRect(),parent=bar.parentElement!.getBoundingClientRect()
      if(!parent.width)fail('not-ready')
      const fraction=Math.max(0,Math.min(1,bounds.width/parent.width))
      blocks.push({kind:'bar',fraction,offset:Math.max(0,Math.min(1-fraction,(bounds.left-parent.left)/parent.width)),color:getComputedStyle(bar).backgroundColor})
     }
     return
    }
   }
   const heading=/^H[1-6]$/.test(node.tagName)
   if(heading){flush();append(node.textContent??'',true);return}
   const block=/^(DIV|SECTION|P|LI|UL|OL|ARTICLE|BR)$/.test(node.tagName)
   if(block)flush()
   for(const child of Array.from(node.childNodes))visit(child)
   if(block)flush()
  }
  visit(card);flush()
  if(!blocks.length)fail('not-ready')
  if(card.querySelector('[data-widget-chart]:empty'))fail('not-ready')
  return blocks
 })
}

const svgTags=new Set(['svg','g','defs','title','desc','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','clipPath','linearGradient','radialGradient','stop','symbol','use','pattern','mask'])
const svgStyles=['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','opacity','color','font-family','font-size','font-weight','font-style','letter-spacing','text-anchor','dominant-baseline','visibility','display','clip-path','paint-order']
/** 只序列化静态 SVG 和本图内引用；内联计算后样式，不复制网络资源、脚本或 foreignObject。 */
function svgSource(svg:SVGSVGElement):string{
 const clone=svg.cloneNode(true) as SVGSVGElement
 const originals=[svg,...Array.from(svg.querySelectorAll('*'))],copies=[clone,...Array.from(clone.querySelectorAll('*'))]
 const ids=new Set(originals.flatMap(node=>node.id?[node.id]:[]))
 const localReference=(value:string)=>{
  let fragment:string|undefined
  if(value.startsWith('#'))fragment=value.slice(1)
  else{try{const url=new URL(value,document.baseURI),base=new URL(document.baseURI);if(url.origin===base.origin&&url.pathname===base.pathname&&url.search===base.search)fragment=url.hash.slice(1)}catch{/* 非本图引用被拒绝。 */}}
  if(!fragment||!ids.has(fragment))fail('unsupported')
  return '#'+fragment
 }
 originals.forEach((node,index)=>{
  if(!svgTags.has(node.localName))fail('unsupported')
  const copy=copies[index]!,style=getComputedStyle(node)
  copy.removeAttribute('style');copy.removeAttribute('class')
  for(const attribute of Array.from(copy.attributes)){
   if(attribute.name.toLowerCase().startsWith('on'))copy.removeAttribute(attribute.name)
   else if(attribute.localName==='href')copy.setAttributeNS(attribute.namespaceURI,attribute.name,localReference(attribute.value))
   else if(/url\(/i.test(attribute.value))copy.setAttribute(attribute.name,attribute.value.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi,(_all,value:string)=>`url(${localReference(value)})`))
  }
  for(const property of svgStyles){
   let value=style.getPropertyValue(property)
   if(/url\(/i.test(value))value=value.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi,(_all,reference:string)=>`url(${localReference(reference)})`)
   if(value)(copy as SVGElement).style.setProperty(property,value)
  }
 })
 const bounds=svg.getBoundingClientRect()
 clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width',String(bounds.width));clone.setAttribute('height',String(bounds.height))
 return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(clone))
}

function wrap(context:CanvasRenderingContext2D,text:string,width:number):string[]{
 const lines:string[]=[];let line=''
 const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)
 for(const {segment} of graphemes){
  if(line&&context.measureText(line+segment).width>width){lines.push(line);line=segment}else line+=segment
 }
 if(line)lines.push(line)
 return lines
}

async function imageSource(source:string):Promise<HTMLImageElement>{
 return new Promise((resolve,reject)=>{
  const image=new Image(),timeout=setTimeout(()=>{image.onload=null;image.onerror=null;image.src='';reject(new DashboardShareImageError('image-failed'))},10_000)
  image.onload=()=>{clearTimeout(timeout);resolve(image)}
  image.onerror=()=>{clearTimeout(timeout);reject(new DashboardShareImageError('image-failed'))}
  image.src=source
 })
}

/** 无外部请求、无 HTML 嵌图、无新增依赖；超限或不支持的图形明确失败，不生成缺内容的“成功”图片。 */
export async function dashboardSharePng(grid:HTMLElement,metadata:DashboardShareImageMetadata):Promise<Blob>{
 if(Object.values(metadata).some(value=>typeof value!=='string'||!value.trim()))fail('not-ready')
 if(Object.values(metadata).reduce((sum,value)=>sum+value.length,0)>10_000)fail('too-large')
 await document.fonts.ready
 const cards=capture(grid),canvas=document.createElement('canvas')
 canvas.width=WIDTH;canvas.height=1
 const context=canvas.getContext('2d');if(!context)fail('image-failed')
 type Draw=()=>void
 const commands:Draw[]=[]
 let y=PADDING
 const text=(value:string,size:number,weight:number,color:string,width:number,x:number)=>{
  context.font=font(size,weight)
  for(const line of wrap(context,value,width)){
   const top=y;commands.push(()=>{context.font=font(size,weight);context.fillStyle=color;context.fillText(line,x,top)})
   y+=Math.ceil(size*1.5)
  }
 }
 text(metadata.title,28,600,'#17212b',INNER,PADDING)
 y+=6;text('Teloa · '+metadata.scope+' · '+metadata.version+' · '+metadata.timeRange,16,400,'#52606d',INNER,PADDING)
 text(metadata.capturedAt,16,400,'#52606d',INNER,PADDING);y+=24
 const images:Array<()=>Promise<void>>=[]
 for(const blocks of cards){
  const top=y;y+=20
  const cardCommands:Draw[]=[]
  const start=commands.length
  for(const block of blocks){
   if(block.kind==='text'){text(block.text,block.heading?20:16,block.heading?600:400,'#17212b',CARD,PADDING+20);y+=10}
   else if(block.kind==='bar'){
    const top=y;commands.push(()=>{context.fillStyle='#e8edf2';context.fillRect(PADDING+20,top,CARD,10);context.fillStyle=block.color;context.fillRect(PADDING+20+CARD*block.offset,top,CARD*block.fraction,10)})
    y+=24
   }else{
    // 不放大小图标；真正图表按卡片宽度缩小，使用实际图表比例。
    const width=Math.min(CARD,block.width),height=width/block.width*block.height,top=y
    if(!Number.isFinite(height)||height<=0||height>MAX_HEIGHT)fail('too-large')
    let image:HTMLImageElement|undefined
    images.push(()=>imageSource(block.source).then(value=>{image=value}))
    commands.push(()=>{if(!image)fail('image-failed');context.drawImage(image,PADDING+20,top,width,height)})
    y+=height+12
   }
   if(y>MAX_HEIGHT)fail('too-large')
  }
  cardCommands.push(...commands.splice(start))
  y+=10;const height=y-top
  commands.push(()=>{context.fillStyle='#fff';context.fillRect(PADDING,top,INNER,height);context.strokeStyle='#d8dee6';context.strokeRect(PADDING+.5,top+.5,INNER-1,height-1)})
  commands.push(...cardCommands);y+=20
 }
 y+=PADDING
 if(y>MAX_HEIGHT||WIDTH*y>20_000_000)fail('too-large')
 await Promise.all(images.map(load=>load()))
 canvas.height=Math.ceil(y);context.textBaseline='top';context.fillStyle='#f6f8fa';context.fillRect(0,0,WIDTH,canvas.height)
 try{for(const draw of commands)draw()}catch(error){if(error instanceof DashboardShareImageError)throw error;fail('image-failed')}
 return new Promise((resolve,reject)=>{try{canvas.toBlob(blob=>blob?resolve(blob):reject(new DashboardShareImageError('image-failed')),'image/png')}catch{reject(new DashboardShareImageError('image-failed'))}})
}
