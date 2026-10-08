// 从 src/brand/teloa-light.svg 生成刷新首页内嵌用的精简字形 src/brand/logotype-svg.ts。
// 字标原文件坐标带十几位小数（约 39KB），刷新首页不缓存，不能逐字内嵌：这里把坐标取到 2 位小数（字标 96px 宽时误差不到 0.001px），
// 去掉取整后重合的点，改用相对坐标并合并成一条路径，只保留 viewBox 与尺寸，填充用 currentColor，由使用方按主题着色。
// 只支持原文件用到的绝对 M/L/H/V/Z；换成带曲线的字标时这里会报错，需要先扩展再重新生成。
// 用法：node packages/client/ui-workbench/scripts/generate-logotype.mjs（换字标后运行，测试会核对生成结果与提交文件一致）
import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const brand=new URL('../src/brand/',import.meta.url)
const SCALE=100

/** 把一条只含绝对 M/L/H/V/Z 的路径拆成按 SCALE 取整的子路径点列。 */
function subpaths(d){
  const tokens=d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)??[]
  const result=[]
  let command='',x=0,y=0,current
  for(let at=0;at<tokens.length;){
    const token=tokens[at]
    if(/^[A-Za-z]$/.test(token)){
      if(!'MLHVZ'.includes(token))throw Error(`字标路径含暂不支持的命令 ${token}，请先扩展生成脚本。`)
      command=token;at++
      if(command==='Z')current=undefined
      continue
    }
    const next=()=>Number(tokens[at++])
    if(command==='M'){x=next();y=next();current=[];result.push(current);command='L'}
    else if(command==='L'){x=next();y=next()}
    else if(command==='H')x=next()
    else if(command==='V')y=next()
    else throw Error('字标路径缺少命令。')
    if(!current)throw Error('字标路径缺少起点。')
    const point=[Math.round(x*SCALE),Math.round(y*SCALE)],last=current.at(-1)
    if(!last||last[0]!==point[0]||last[1]!==point[1])current.push(point)
  }
  for(const points of result){
    const [first]=points,last=points.at(-1)
    if(points.length>1&&first[0]===last[0]&&first[1]===last[1])points.pop()
  }
  return result
}

const number=value=>String(value/SCALE).replace(/^(-?)0\./,'$1.')
/** 拼接命令与数字：同一命令连续出现时省略字母，数字之间只在必须时加空格。 */
function serialize(tokens){
  let out='',command='',last
  for(const token of tokens){
    if(typeof token==='string'){if(token!==command){out+=token;command=token;last=undefined}continue}
    const text=number(token)
    if(last!==undefined&&!text.startsWith('-')&&!(text.startsWith('.')&&last.includes('.')))out+=' '
    out+=text;last=text
  }
  return out
}

/** 生成精简字形：单条路径、相对坐标、currentColor 填充。 */
export function minifyLogotype(source){
  const svg=source.match(/^<svg\b[^>]*>/)?.[0]
  const viewBox=svg?.match(/\bviewBox="([^"]+)"/)?.[1],width=svg?.match(/\bwidth="([^"]+)"/)?.[1],height=svg?.match(/\bheight="([^"]+)"/)?.[1]
  const paths=[...source.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match=>match[1])
  if(!viewBox||!width||!height||!paths.length)throw Error('字标文件缺少 viewBox、尺寸或路径。')
  const tokens=[]
  for(const points of paths.flatMap(subpaths)){
    let [x,y]=points[0]
    tokens.push('M',x,y)
    for(const [nextX,nextY] of points.slice(1)){
      const dx=nextX-x,dy=nextY-y
      if(dy===0)tokens.push('h',dx);else if(dx===0)tokens.push('v',dy);else tokens.push('l',dx,dy)
      x=nextX;y=nextY
    }
    tokens.push('z')
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${viewBox}' width='${width}' height='${height}'><path fill='currentColor' d='${serialize(tokens)}'/></svg>`
}

/** 生成提交到仓库的 TypeScript 模块正文。 */
export function logotypeModule(source){
  return [
    '// 由 scripts/generate-logotype.mjs 从 teloa-light.svg 生成，请勿手改；换字标后重新运行该脚本。',
    '// 刷新首页内嵌的精简字形：只保留形状，用 currentColor 填充，颜色由使用方按主题令牌决定。',
    `export const TELOA_LOGOTYPE_SVG:string=${JSON.stringify(minifyLogotype(source))}`,
    '',
  ].join('\n')
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  writeFileSync(new URL('logotype-svg.ts',brand),logotypeModule(readFileSync(new URL('teloa-light.svg',brand),'utf8')))
}
