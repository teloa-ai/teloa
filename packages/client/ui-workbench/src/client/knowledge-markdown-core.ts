export type MarkdownBlock=
 | {kind:'heading';level:number;text:string}
 | {kind:'paragraph';text:string}
 | {kind:'quote';text:string}
 | {kind:'code';language:string;text:string}
 | {kind:'list';ordered:boolean;items:string[]}
 | {kind:'table';headers:string[];rows:string[][]}
 | {kind:'rule'}

const heading=/^(#{1,6})\s+(.+)$/
const unordered=/^\s*[-*+]\s+(.+)$/
const ordered=/^\s*\d+[.)]\s+(.+)$/
const separator=/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/

const cells=(line:string)=>line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim())
const beginsBlock=(lines:string[],index:number)=>{
 const line=lines[index]??''
 return !line.trim()||heading.test(line)||/^\s*>\s?/.test(line)||/^\s*```/.test(line)||unordered.test(line)||ordered.test(line)||/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)||(index+1<lines.length&&separator.test(lines[index+1]??''))
}

export function parseMarkdown(markdown:string):MarkdownBlock[]{
 const lines=markdown.replace(/\r\n?/g,'\n').split('\n'),blocks:MarkdownBlock[]=[]
 for(let index=0;index<lines.length;){
  const line=lines[index]??''
  if(!line.trim()){index++;continue}
  const fence=line.match(/^\s*```\s*([^\s`]*)\s*$/)
  if(fence){const body:string[]=[];index++;while(index<lines.length&&!/^\s*```\s*$/.test(lines[index]??'')){body.push(lines[index]??'');index++}if(index<lines.length)index++;blocks.push({kind:'code',language:fence[1]??'',text:body.join('\n')});continue}
  const title=line.match(heading)
  if(title){blocks.push({kind:'heading',level:title[1]!.length,text:title[2]!});index++;continue}
  if(/^\s*>\s?/.test(line)){const body:string[]=[];while(index<lines.length&&/^\s*>\s?/.test(lines[index]??'')){body.push((lines[index]??'').replace(/^\s*>\s?/,''));index++}blocks.push({kind:'quote',text:body.join('\n')});continue}
  if(unordered.test(line)||ordered.test(line)){const isOrdered=ordered.test(line),items:string[]=[];const pattern=isOrdered?ordered:unordered;while(index<lines.length){const match=(lines[index]??'').match(pattern);if(!match)break;items.push(match[1]!);index++}blocks.push({kind:'list',ordered:isOrdered,items});continue}
  if(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){blocks.push({kind:'rule'});index++;continue}
  if(index+1<lines.length&&separator.test(lines[index+1]??'')){const headers=cells(line),rows:string[][]=[];index+=2;while(index<lines.length&&(lines[index]??'').includes('|')&&(lines[index]??'').trim()){rows.push(cells(lines[index]??''));index++}blocks.push({kind:'table',headers,rows});continue}
  const paragraph=[line];index++;while(index<lines.length&&!beginsBlock(lines,index)){paragraph.push(lines[index]??'');index++}blocks.push({kind:'paragraph',text:paragraph.join('\n')})
 }
 return blocks
}

export type MarkdownCommand='bold'|'italic'|'heading'|'quote'|'code'|'link'|'unordered-list'|'ordered-list'
export type MarkdownEdit={value:string;selectionStart:number;selectionEnd:number}

export function applyMarkdownCommand(value:string,start:number,end:number,command:MarkdownCommand,placeholder:string):MarkdownEdit{
 const selected=value.slice(start,end),body=selected||placeholder
 const wrap=(prefix:string,suffix=prefix):MarkdownEdit=>({value:value.slice(0,start)+prefix+body+suffix+value.slice(end),selectionStart:start+prefix.length,selectionEnd:start+prefix.length+body.length})
 if(command==='bold')return wrap('**')
 if(command==='italic')return wrap('_')
 if(command==='code')return selected.includes('\n')?wrap('```\n','\n```'):wrap('`')
 if(command==='link'){const replacement=`[${body}](https://)`;return {value:value.slice(0,start)+replacement+value.slice(end),selectionStart:start+body.length+3,selectionEnd:start+body.length+11}}
 const lineStart=value.lastIndexOf('\n',Math.max(0,start-1))+1,lineEnd=value.indexOf('\n',end)<0?value.length:value.indexOf('\n',end),lines=value.slice(lineStart,lineEnd).split('\n')
 const prefix=command==='heading'?'## ':command==='quote'?'> ':command==='ordered-list'?'1. ':'- '
 const replacement=lines.map((line,index)=>command==='ordered-list'?`${index+1}. ${line||placeholder}`:prefix+(line||placeholder)).join('\n')
 return {value:value.slice(0,lineStart)+replacement+value.slice(lineEnd),selectionStart:lineStart,selectionEnd:lineStart+replacement.length}
}
