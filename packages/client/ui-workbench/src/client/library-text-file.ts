/** 文本端口只给 UTF-8；格式依据取得的路径，未知内容按纯文本呈现。 */
export function libraryTextFormat(path:string|undefined,knowledge=false):'markdown'|'text'{return knowledge||/\.(md|markdown)$/i.test(path??'')?'markdown':'text'}
export function downloadLibraryText(text:string,name:string){
 const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a')
 link.href=url;link.download=name.split(/[\\/]/).at(-1)||'document.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
