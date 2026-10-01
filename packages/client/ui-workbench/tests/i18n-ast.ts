import ts from 'typescript'

export type ChineseLiteralAllowlist=(value:string,node:ts.Node)=>boolean

export function chineseUiLiterals(source:string,fileName='source.tsx',allow:ChineseLiteralAllowlist=()=>false):string[]{
 const file=ts.createSourceFile(fileName,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const values:string[]=[]
 const visit=(node:ts.Node)=>{
  const text=ts.isJsxText(node)||ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)?node.text:''
  const value=text.trim()
  if(value&&/\p{Script=Han}/u.test(value)&&!allow(value,node))values.push(value)
  ts.forEachChild(node,visit)
 }
 visit(file)
 return values
}
