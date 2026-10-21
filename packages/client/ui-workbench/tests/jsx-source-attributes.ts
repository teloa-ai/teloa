import ts from 'typescript'

/** 只读 JSX 接线断言：属性顺序、箭头函数和新增守卫不应截断标签。 */
export function jsxAttributeExpressions(source:string,tag:string,attribute:string):string[]{
 const file=ts.createSourceFile('wiring.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),values:string[]=[]
 const visit=(node:ts.Node)=>{
  if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(file)===tag){
   for(const prop of node.attributes.properties){
    if(!ts.isJsxAttribute(prop)||prop.name.getText(file)!==attribute||!prop.initializer)continue
    if(ts.isJsxExpression(prop.initializer)){if(prop.initializer.expression)values.push(prop.initializer.expression.getText(file))}
    else if(ts.isStringLiteral(prop.initializer))values.push(prop.initializer.text)
   }
  }
  ts.forEachChild(node,visit)
 }
 visit(file)
 return values
}
