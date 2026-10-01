import type {ReactNode} from 'react'
import {parseMarkdown} from './knowledge-markdown-core.js'
import {useI18n} from './i18n/provider.js'
export {applyMarkdownCommand,parseMarkdown,type MarkdownBlock,type MarkdownCommand,type MarkdownEdit} from './knowledge-markdown-core.js'

// 含任何 C0 控制字符（tab、换行、回车等）一律 fail-closed：WHATWG URL 解析器在解析前会把
// 整串里的 tab/换行/回车直接删掉，`/\t/evil.com` 删完就是 `/\evil.com`，等价于协议相对地址，
// 现有的单斜杠判据看不出这一层——不判断这串"长什么样"，先看它"有没有会被悄悄吃掉的字符"。
// 站内路径只放行单斜杠且下一字符既非 `/` 也非 `\` 的那种：`//attacker.tld` 是协议相对地址，
// `/\attacker.tld` 会被 WHATWG URL 解析器把 `\` 当 `/` 处理、等价于协议相对地址，两者浏览器都会当外站加载，
// 而知识正文与告警正文都可能来自第三方，放行它们等于给对方一条任意文案的钓鱼链接。
const safeHref=(href:string)=>/[\x00-\x1f]/.test(href)?'#':/^(?:https?:|mailto:|#|\.\.?\/)/i.test(href)||/^\/(?![/\\])/.test(href)?href:'#'

function inline(text:string,key:string,images=true):ReactNode[]{
 const pattern=/(!?\[[^\]]*\]\([^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))/g
 const nodes:ReactNode[]=[];let cursor=0,match:RegExpExecArray|null
 while((match=pattern.exec(text))){
  if(match.index>cursor)nodes.push(text.slice(cursor,match.index))
  const token=match[0],nodeKey=key+'-'+match.index
  const image=token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/),link=token.match(/^\[([^\]]*)\]\(([^)]+)\)$/)
  // images=false 的调用方（依据区）不许外发任何请求：图片降级成 alt 文本，src 一并丢弃，避免远程信标。
  if(image)nodes.push(images?<img key={nodeKey} src={safeHref(image[2]!)} alt={image[1]!} referrerPolicy="no-referrer"/>:image[1]!)
  else if(link)nodes.push(<a key={nodeKey} href={safeHref(link[2]!)} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">{link[1]}</a>)
  else if(token.startsWith('`'))nodes.push(<code key={nodeKey}>{token.slice(1,-1)}</code>)
  else if(token.startsWith('**')||token.startsWith('__'))nodes.push(<strong key={nodeKey}>{token.slice(2,-2)}</strong>)
  else nodes.push(<em key={nodeKey}>{token.slice(1,-1)}</em>)
  cursor=match.index+token.length
 }
 if(cursor<text.length)nodes.push(text.slice(cursor))
 return nodes
}

export function MarkdownPreview({markdown,empty,images=true}:{markdown:string;empty?:string;images?:boolean}){
 const {t}=useI18n()
 const blocks=parseMarkdown(markdown)
 if(!blocks.length)return <p>{empty??t('markdown.empty')}</p>
 return <>{blocks.map((block,index)=>{
  const key='md-'+index
  if(block.kind==='heading'){const Tag=`h${block.level}` as keyof JSX.IntrinsicElements;return <Tag key={key}>{inline(block.text,key,images)}</Tag>}
  if(block.kind==='paragraph')return <p key={key}>{block.text.split('\n').flatMap((line,lineIndex)=>lineIndex?[<br key={key+'-br-'+lineIndex}/>,...inline(line,key+'-'+lineIndex,images)]:inline(line,key+'-'+lineIndex,images))}</p>
  if(block.kind==='quote')return <blockquote key={key}>{block.text.split('\n').map((line,lineIndex)=><p key={key+'-'+lineIndex}>{inline(line,key+'-'+lineIndex,images)}</p>)}</blockquote>
  if(block.kind==='code')return <pre key={key} data-language={block.language||undefined}><code>{block.text}</code></pre>
  if(block.kind==='rule')return <hr key={key}/>
  if(block.kind==='list'){const Tag=block.ordered?'ol':'ul';return <Tag key={key}>{block.items.map((item,itemIndex)=><li key={key+'-'+itemIndex}>{inline(item,key+'-'+itemIndex,images)}</li>)}</Tag>}
  return <div key={key} role="region" aria-label={t('markdown.tableAria')} tabIndex={0}><table><thead><tr>{block.headers.map((cell,index)=><th key={key+'-h-'+index}>{inline(cell,key+'-h-'+index,images)}</th>)}</tr></thead><tbody>{block.rows.map((row,rowIndex)=><tr key={key+'-r-'+rowIndex}>{block.headers.map((_,cellIndex)=><td key={key+'-r-'+rowIndex+'-'+cellIndex}>{inline(row[cellIndex]??'',key+'-r-'+rowIndex+'-'+cellIndex,images)}</td>)}</tr>)}</tbody></table></div>
 })}</>
}
