import {
 WorkError,readBusinessImportSheetV2,readBusinessImportSourceV2,readBusinessImportPolicyV2,
 readBusinessImportCellV2,readBusinessImportTableV2,
 type BusinessImportSheetV2,type BusinessImportSourceV2,type BusinessImportPolicyV2,
 type BusinessImportCellV2,type BusinessImportTableV2,
} from '@teloa/contract'
import {readBusinessImportXml,type BusinessImportXmlAttribute} from './business-import-xml.ts'

export type BusinessImportOoxmlPart={path:string;bytes:Uint8Array}
const S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P='http://schemas.openxmlformats.org/package/2006/relationships'
const C='http://schemas.openxmlformats.org/package/2006/content-types'
const X='http://www.w3.org/XML/1998/namespace'
const A='http://schemas.openxmlformats.org/drawingml/2006/main'
const CORE='http://schemas.openxmlformats.org/package/2006/metadata/core-properties'
const DC='http://purl.org/dc/elements/1.1/'
const DCT='http://purl.org/dc/terms/'
const EP='http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
const CP='http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
const VT='http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
const XSI='http://www.w3.org/2001/XMLSchema-instance'
const MiB=1024*1024
const policy=():BusinessImportPolicyV2=>readBusinessImportPolicyV2({parserVersion:'xlsx-scalar-v1',scalarPolicy:'closed-scalar-v1',datePolicy:'reject-date-v1',formulaPolicy:'reject-formula-v1'})
type Node={ns:string;name:string;attrs:readonly BusinessImportXmlAttribute[];children:Node[];text:string}
type Kind='workbook'|'worksheet'|'styles'|'sharedStrings'|'theme'|'core'|'extended'|'custom'|'calcChain'|'table'|'rels'
type Relationship={id:string;kind:Kind;target:string}
type Package={trees:Map<string,Node>;kinds:Map<string,Kind>;rels:Map<string,Relationship[]>;workbook:string;sheets:BusinessImportSheetV2[];states:Map<string,string>}
function fail(code:string,message:string,rowNumber?:number,column?:number):never{
 throw new WorkError('teloa/invalid-input',message,{businessImportIssues:[{code,message,...(rowNumber===undefined?{}:{rowNumber}),...(column===undefined?{}:{column})}]})
}
function badPackage():never{return fail('xlsx-package','业务 XLSX 包部件、类型或结构不符合导入要求。')}
function badRelationship():never{return fail('xlsx-relationship','业务 XLSX 内部关系不完整或包含不支持的关系。')}
function unsupported():never{return fail('xlsx-feature','业务 XLSX 包含暂不支持的结构；请转为普通文本表格后导入。')}
function limit():never{return fail('xlsx-limit','业务 XLSX 超过部件、文本或行列资源上限。')}
const attr=(n:Node,name:string,ns='')=>n.attrs.find(a=>a.name.local===name&&a.name.namespace===ns)?.value
function attributes(n:Node,allowed:string[],namespaced:Record<string,string[]>={}){
 for(const a of n.attrs)if(!(a.name.namespace===''?allowed:namespaced[a.name.namespace]??[]).includes(a.name.local))unsupported()
}
function structure(n:Node,ns:string,name:string,children:string[],allowedAttrs:string[]=[],namespaced:Record<string,string[]>={}){
 if(n.ns!==ns||n.name!==name)unsupported()
 attributes(n,allowedAttrs,namespaced)
 if(n.text.trim()||n.children.some(c=>c.ns!==ns||!children.includes(c.name)))unsupported()
}
function one(n:Node,name:string,required=false):Node|undefined{
 const found=n.children.filter(c=>c.name===name)
 if(found.length>1||required&&!found.length)unsupported()
 return found[0]
}
function leaf(n:Node,allowed:string[]=[],space=false){
 attributes(n,allowed,space?{[X]:['space']}:{});if(n.children.length)unsupported()
 const value=attr(n,'space',X);if(value!==undefined&&value!=='default'&&value!=='preserve')unsupported()
}
function read<T>(fn:()=>T,code='xlsx-type',message='业务 XLSX 单元格类型或原值不符合导入要求。'):T{
 try{return fn()}catch{fail(code,message)}
}
async function checkpoint(signal?:AbortSignal){await new Promise<void>(resolve=>setImmediate(resolve));signal?.throwIfAborted()}
function safePath(path:string):boolean{
 return path.length>0&&path.length<=300&&!/[\\\x00-\x1f\x7f:%?#]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..')
}
function relationshipPath(owner:string):string{
 if(!owner)return '_rels/.rels'
 const slash=owner.lastIndexOf('/');return `${slash<0?'':owner.slice(0,slash+1)}_rels/${owner.slice(slash+1)}.rels`
}
function relationshipOwner(path:string):string{
 if(path==='_rels/.rels')return ''
 const pieces=path.split('/');if(pieces.at(-2)!=='_rels'||!pieces.at(-1)?.endsWith('.rels'))badRelationship()
 return [...pieces.slice(0,-2),pieces.at(-1)!.slice(0,-5)].join('/')
}
function resolveTarget(owner:string,target:string):string{
 if(!target||target.length>300||/[\\\x00-\x1f\x7f:%?#]/.test(target))badRelationship()
 const result=target.startsWith('/')?[]:owner.split('/').slice(0,-1)
 for(const segment of (target.startsWith('/')?target.slice(1):target).split('/')){
  if(!segment)badRelationship()
  if(segment==='.')continue
  if(segment==='..'){if(!result.length)badRelationship();result.pop()}else result.push(segment)
 }
 const path=result.join('/');if(!safePath(path))badRelationship();return path
}
const spreadsheet='application/vnd.openxmlformats-officedocument.spreadsheetml.'
const contentKinds=new Map<string,Kind>([
 [spreadsheet+'sheet.main+xml','workbook'],[spreadsheet+'worksheet+xml','worksheet'],
 [spreadsheet+'styles+xml','styles'],[spreadsheet+'sharedStrings+xml','sharedStrings'],
 [spreadsheet+'calcChain+xml','calcChain'],[spreadsheet+'table+xml','table'],
 ['application/vnd.openxmlformats-officedocument.theme+xml','theme'],
 ['application/vnd.openxmlformats-package.core-properties+xml','core'],
 ['application/vnd.openxmlformats-officedocument.extended-properties+xml','extended'],
 ['application/vnd.openxmlformats-officedocument.custom-properties+xml','custom'],
 ['application/vnd.openxmlformats-package.relationships+xml','rels'],
])
const relationshipKinds=new Map<string,Kind>([
 ...(['officeDocument','worksheet','styles','sharedStrings','theme','calcChain','table','extended-properties','custom-properties'] as const).map(type=>[`${R}/${type}`,({officeDocument:'workbook','extended-properties':'extended','custom-properties':'custom'} as Record<string,Kind>)[type]??type as Kind] as [string,Kind]),
 ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties','core'],
])
async function parseTrees(parts:readonly BusinessImportOoxmlPart[],signal?:AbortSignal):Promise<Map<string,Node>>{
 signal?.throwIfAborted()
 if(!Array.isArray(parts)||parts.length<1||parts.length>64)limit()
 const snapshots:BusinessImportOoxmlPart[]=[],paths=new Set<string>();let bytes=0
 for(let i=0;i<parts.length;i++){
  const p=parts[i];if(!p||typeof p.path!=='string'||!safePath(p.path)||!(p.bytes instanceof Uint8Array))badPackage()
  const identity=p.path.normalize('NFC').toLowerCase();if(paths.has(identity))badPackage();paths.add(identity)
  if(p.bytes.byteLength>MiB||(bytes+=p.bytes.byteLength)>2*MiB)limit()
  snapshots.push({path:p.path,bytes:p.bytes.slice()})
 }
 const trees=new Map<string,Node>();let elements=0,eventsCount=0,nextYield=256
 for(const part of snapshots){
  let events
  try{events=await readBusinessImportXml(part.bytes,MiB,signal)}catch(error){signal?.throwIfAborted();fail('xlsx-xml','业务 XLSX 的 XML 部件格式或大小不符合导入要求。')}
  eventsCount+=events.length;if(eventsCount>120000)limit()
  const stack:Node[]=[];let root:Node|undefined
  for(const event of events){
   if(event.type==='start'){
    if(++elements>40000)limit()
    if(elements>=nextYield){await checkpoint(signal);nextYield=elements+256}
    const n:Node={ns:event.name.namespace,name:event.name.local,attrs:event.attributes,children:[],text:'' }
    if(stack.length)stack.at(-1)!.children.push(n);else root=n
    stack.push(n)
   }else if(event.type==='end')stack.pop()
   else{const node=stack.at(-1)!;node.text+=event.value;if(node.text.length>4000)limit()}
  }
  if(!root)badPackage();trees.set(part.path,root)
 }
 signal?.throwIfAborted();return trees
}
function contentTypes(trees:Map<string,Node>):Map<string,Kind>{
 const root=trees.get('[Content_Types].xml');if(!root)badPackage()
 structure(root,C,'Types',['Default','Override'])
 const defaults=new Map<string,string>(),overrides=new Map<string,string>()
 for(const node of root.children){
  structure(node,C,node.name,[],node.name==='Default'?['Extension','ContentType']:['PartName','ContentType'])
  const type=attr(node,'ContentType');if(!type||!contentKinds.has(type)&&!(node.name==='Default'&&type==='application/xml'))badPackage()
  if(node.name==='Default'){
   const extension=attr(node,'Extension');if(!extension||! /^[A-Za-z0-9]+$/.test(extension))badPackage()
   const key=extension.toLowerCase();if(defaults.has(key)&&defaults.get(key)!==type)badPackage();defaults.set(key,type)
  }else{
   const name=attr(node,'PartName');if(!name?.startsWith('/')||!safePath(name.slice(1))||!trees.has(name.slice(1)))badPackage()
   const key=name.slice(1);if(overrides.has(key)&&overrides.get(key)!==type)badPackage();overrides.set(key,type)
  }
 }
 const kinds=new Map<string,Kind>()
 for(const path of trees.keys())if(path!=='[Content_Types].xml'){
  const type=overrides.get(path)??defaults.get(path.slice(path.lastIndexOf('.')+1).toLowerCase())
  const kind=type&&contentKinds.get(type);if(!kind||kind==='rels'&&!path.endsWith('.rels')||path.endsWith('.rels')&&kind!=='rels')badPackage()
  kinds.set(path,kind)
 }
 return kinds
}
function readRelationships(trees:Map<string,Node>,kinds:Map<string,Kind>):Map<string,Relationship[]>{
 if(kinds.get('_rels/.rels')!=='rels')badRelationship()
 const all=new Map<string,Relationship[]>()
 for(const [path,kind] of kinds)if(kind==='rels'){
  const owner=relationshipOwner(path);if(owner&&!trees.has(owner)||relationshipPath(owner)!==path)badRelationship()
  const root=trees.get(path)!;structure(root,P,'Relationships',['Relationship'])
  if(root.children.length>128)limit()
  const ids=new Set<string>(),rels:Relationship[]=[]
  for(const n of root.children){
   structure(n,P,'Relationship',[],['Id','Type','Target','TargetMode'])
   const id=attr(n,'Id'),type=attr(n,'Type'),target=attr(n,'Target'),mode=attr(n,'TargetMode')
   if(!id||ids.has(id)||!type||!target||mode!==undefined&&mode!=='Internal')badRelationship()
   ids.add(id);const relationKind=relationshipKinds.get(type);if(!relationKind)badRelationship()
   const targetPath=resolveTarget(owner,target);if(kinds.get(targetPath)!==relationKind)badRelationship()
   // 关系类别仅在公开的相应源部件上有效，不能把动态关系伪装成静态属性。
   const ownerKind=owner?kinds.get(owner):undefined
   if(ownerKind===undefined?!['workbook','core','extended','custom'].includes(relationKind):ownerKind==='workbook'?!['worksheet','styles','sharedStrings','theme','calcChain'].includes(relationKind):ownerKind==='worksheet'?relationKind!=='table':true)badRelationship()
   rels.push({id,kind:relationKind,target:targetPath})
  }
  all.set(owner,rels)
 }
 for(const rels of all.values())for(const kind of ['workbook','styles','sharedStrings','theme','core','extended','custom','calcChain'])if(rels.filter(r=>r.kind===kind).length>1)badRelationship()
 return all
}
/** ST_Xstring 是单次词法转义；解码后的下划线不会触发第二遍读取。 */
function xstring(text:string):string{
 const decoded=text.replace(/_x([0-9a-fA-F]{4})_/g,(_,digits:string)=>String.fromCharCode(Number.parseInt(digits,16)))
 if(decoded.length>4000)limit()
 for(let i=0;i<decoded.length;i++){
  const n=decoded.charCodeAt(i)
  if(n===0||n<32&&n!==9&&n!==10&&n!==13||n===127||n===0xfffe||n===0xffff)fail('xlsx-string','业务 XLSX 字符串包含不支持的控制字符或转义。')
  if(n>=0xd800&&n<=0xdbff){const next=decoded.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail('xlsx-string','业务 XLSX 字符串包含未配对的字符转义。')}
  else if(n>=0xdc00&&n<=0xdfff)fail('xlsx-string','业务 XLSX 字符串包含未配对的字符转义。')
 }
 return decoded
}

// 闭合静态元数据语法。未列出的元素或命名空间必须显式拒绝。
const staticGrammar:Record<string,[string[],string[]]>={
 fileVersion:[[],['appName','lastEdited','lowestEdited','rupBuild','codeName']],
 workbookPr:[[],['date1904','dateCompatibility','showObjects','showBorderUnselectedTables','filterPrivacy','promptedSolutions','showInkAnnotation','backupFile','saveExternalLinkValues','updateLinks','codeName','hidePivotFieldList','showPivotChartFilter','allowRefreshQuery','publishItems','checkCompatibility','autoCompressPictures','refreshAllConnections','defaultThemeVersion']],
 bookViews:[['workbookView'],[]],workbookView:[[],['visibility','minimized','showHorizontalScroll','showVerticalScroll','showSheetTabs','xWindow','yWindow','windowWidth','windowHeight','tabRatio','firstSheet','activeTab','autoFilterDateGrouping']],
 calcPr:[[],['calcId','calcMode','fullCalcOnLoad','refMode','iterate','iterateCount','iterateDelta','fullPrecision','calcCompleted','calcOnSave','concurrentCalc','concurrentManualCount','forceFullCalc']],
 definedNames:[[],[]],
 sheetPr:[['tabColor','outlinePr','pageSetUpPr'],['codeName','syncHorizontal','syncVertical','syncRef','transitionEvaluation','transitionEntry','published','filterMode','enableFormatConditionsCalculation']],
 tabColor:[[],['auto','indexed','rgb','theme','tint']],outlinePr:[[],['applyStyles','summaryBelow','summaryRight','showOutlineSymbols']],pageSetUpPr:[[],['autoPageBreaks','fitToPage']],
 dimension:[[],['ref']],sheetViews:[['sheetView'],[]],sheetView:[['pane','selection'],['windowProtection','showFormulas','showGridLines','showRowColHeaders','showZeros','rightToLeft','tabSelected','showRuler','showOutlineSymbols','defaultGridColor','showWhiteSpace','view','topLeftCell','colorId','zoomScale','zoomScaleNormal','zoomScaleSheetLayoutView','zoomScalePageLayoutView','workbookViewId']],
 pane:[[],['xSplit','ySplit','topLeftCell','activePane','state']],selection:[[],['pane','activeCell','activeCellId','sqref']],sheetFormatPr:[[],['baseColWidth','defaultColWidth','defaultRowHeight','customHeight','zeroHeight','thickTop','thickBottom','outlineLevelRow','outlineLevelCol']],
 cols:[['col'],[]],col:[[],['min','max','width','style','hidden','bestFit','customWidth','phonetic','outlineLevel','collapsed']],
 pageMargins:[[],['left','right','top','bottom','header','footer']],pageSetup:[[],['paperSize','scale','firstPageNumber','fitToWidth','fitToHeight','pageOrder','orientation','usePrinterDefaults','blackAndWhite','draft','cellComments','useFirstPageNumber','errors','horizontalDpi','verticalDpi','copies']],printOptions:[[],['horizontalCentered','verticalCentered','headings','gridLines','gridLinesSet']],
 headerFooter:[['oddHeader','oddFooter','evenHeader','evenFooter','firstHeader','firstFooter'],['differentOddEven','differentFirst','scaleWithDoc','alignWithMargins']],
}
const textMetadata=new Set(['oddHeader','oddFooter','evenHeader','evenFooter','firstHeader','firstFooter'])
function staticNode(n:Node){
 if(n.ns!==S)unsupported()
 if(textMetadata.has(n.name)){leaf(n);return}
 if(!Object.hasOwn(staticGrammar,n.name))unsupported()
 const rule=staticGrammar[n.name]!;structure(n,S,n.name,rule[0],rule[1]);for(const c of n.children)staticNode(c)
}
const worksheetMetadata=['sheetPr','dimension','sheetViews','sheetFormatPr','cols','pageMargins','pageSetup','printOptions','headerFooter']
const restrictedSheet=['mergeCells','autoFilter','dataValidations','hyperlinks','drawing','legacyDrawing','legacyDrawingHF','tableParts','sheetProtection','protectedRanges','conditionalFormatting','rowBreaks','colBreaks','scenarios','sheetCalcPr','customSheetViews','ignoredErrors','smartTags','sheetCalcPr','sheetProtection']
function worksheetStructure(root:Node){
 structure(root,S,'worksheet',[...worksheetMetadata,'sheetData',...restrictedSheet])
 one(root,'sheetData',true)
 for(const name of worksheetMetadata)if(root.children.filter(n=>n.name===name).length>1)unsupported()
 for(const n of root.children)if(worksheetMetadata.includes(n.name))staticNode(n)
 // 未选表也不接受未知命名空间、扩展或无关子结构。已知受限功能选中后明确报错。
 const allowed=new Set(['worksheet',...worksheetMetadata,...Object.keys(staticGrammar),...textMetadata,'sheetData','row','c','v','is','t','f','r','rPr','rPh','phoneticPr',...restrictedSheet,'mergeCell','dataValidation','formula1','formula2','hyperlink','tablePart','filterColumn','filters','filter','customFilters','customFilter','dynamicFilter','top10','colorFilter','iconFilter','sortState','sortCondition','protectedRange','cfRule','formula','colorScale','dataBar','iconSet','cfvo','color','brk','ignoredError','scenario','inputCells','customSheetView'])
 const visit=(n:Node,row?:number,column?:number)=>{
  if(n.name==='c'){
   const ref=attr(n,'r'),match=ref&&/^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref)
   if(match){row=Number(match[2]);let col=0;for(const char of match[1]!)col=col*26+char.charCodeAt(0)-64;column=col-1}
  }
  if(n.ns!==S||!allowed.has(n.name))fail('xlsx-feature','业务 XLSX 包含暂不支持的结构；请转为普通文本表格后导入。',row,column)
  for(const a of n.attrs)if(a.name.namespace!==''&&!(a.name.namespace===R&&a.name.local==='id')&&!(a.name.namespace===X&&a.name.local==='space'))fail('xlsx-feature','业务 XLSX 包含暂不支持的结构；请转为普通文本表格后导入。',row,column)
  for(const c of n.children)visit(c,row,column)
 }
 visit(root)
}
function workbookSheets(root:Node,workbookRels:Relationship[]):{sheets:BusinessImportSheetV2[];states:Map<string,string>}{
 structure(root,S,'workbook',['fileVersion','workbookPr','bookViews','sheets','calcPr','definedNames'])
 for(const n of root.children)if(root.children.filter(c=>c.name===n.name).length>1)unsupported()
 const list=one(root,'sheets',true)!;structure(list,S,'sheets',['sheet'])
 if(list.children.length<1||list.children.length>16)limit()
 for(const node of root.children)if(node!==list)staticNode(node)
 const sheets:BusinessImportSheetV2[]=[],states=new Map<string,string>(),ids=new Set<string>(),names=new Set<string>(),targets=new Set<string>()
 for(const n of list.children){
  structure(n,S,'sheet',[],['name','sheetId','state'],{[R]:['id']})
  const rid=attr(n,'id',R),relation=workbookRels.find(r=>r.id===rid)
  if(!relation||relation.kind!=='worksheet')badRelationship()
  const s=read(()=>readBusinessImportSheetV2({sheetId:attr(n,'sheetId'),name:xstring(attr(n,'name')??''),part:relation.target}),'xlsx-sheet','业务 XLSX 工作表名称或身份不符合导入要求。')
  const name=s.name.normalize('NFC').toLowerCase(),state=attr(n,'state')??'visible'
  if(!['visible','hidden','veryHidden'].includes(state)||ids.has(s.sheetId)||names.has(name)||targets.has(s.part))fail('xlsx-sheet','业务 XLSX 工作表身份重复或状态不正确。')
  ids.add(s.sheetId);names.add(name);targets.add(s.part);sheets.push(s);states.set(s.part,state)
 }
 const sheetRels=workbookRels.filter(r=>r.kind==='worksheet')
 if(sheetRels.length!==sheets.length||new Set(sheetRels.map(r=>r.target)).size!==sheetRels.length)badRelationship()
 return {sheets,states}
}

const styleGrammar:Record<string,[string[],string[]]>={
 styleSheet:[['numFmts','fonts','fills','borders','cellStyleXfs','cellXfs','cellStyles','dxfs','tableStyles','colors'],[]],
 numFmts:[['numFmt'],['count']],numFmt:[[],['numFmtId','formatCode']],fonts:[['font'],['count']],font:[['name','sz','b','i','u','strike','outline','shadow','condense','extend','vertAlign','color','family','charset','scheme'],[]],
 fills:[['fill'],['count']],fill:[['patternFill','gradientFill'],[]],patternFill:[['fgColor','bgColor'],['patternType']],gradientFill:[['stop'],['type','degree','left','right','top','bottom']],stop:[['color'],['position']],
 borders:[['border'],['count']],border:[['left','right','top','bottom','diagonal','vertical','horizontal','start','end'],['diagonalUp','diagonalDown','outline']],
 cellStyleXfs:[['xf'],['count']],cellXfs:[['xf'],['count']],xf:[['alignment','protection'],['numFmtId','fontId','fillId','borderId','xfId','quotePrefix','pivotButton','applyNumberFormat','applyFont','applyFill','applyBorder','applyAlignment','applyProtection']],
 alignment:[[],['horizontal','vertical','textRotation','wrapText','shrinkToFit','indent','relativeIndent','justifyLastLine','readingOrder']],protection:[[],['locked','hidden']],
 cellStyles:[['cellStyle'],['count']],cellStyle:[[],['name','xfId','builtinId','iLevel','hidden','customBuiltin']],dxfs:[['dxf'],['count']],dxf:[['font','numFmt','fill','alignment','border','protection'],[]],
 tableStyles:[['tableStyle'],['count','defaultTableStyle','defaultPivotStyle']],tableStyle:[['tableStyleElement'],['name','pivot','table','count']],tableStyleElement:[[],['type','size','dxfId']],colors:[['indexedColors','mruColors'],[]],indexedColors:[['rgbColor'],[]],mruColors:[['color'],[]],rgbColor:[[],['rgb']],
}
for(const name of ['name','sz','b','i','u','strike','outline','shadow','condense','extend','vertAlign','family','charset','scheme'])styleGrammar[name]=[[],['val']]
for(const name of ['color','fgColor','bgColor'])styleGrammar[name]=[[],['auto','indexed','rgb','theme','tint']]
for(const name of ['left','right','top','bottom','diagonal','vertical','horizontal','start','end'])styleGrammar[name]=[['color'],['style']]
function validateGrammar(n:Node,ns:string,grammar:Record<string,[string[],string[]]>){if(!Object.hasOwn(grammar,n.name))unsupported();const rule=grammar[n.name]!;structure(n,ns,n.name,rule[0],rule[1]);for(const c of n.children)validateGrammar(c,ns,grammar)}
function uint(value:string|undefined,max:number,defaultValue?:number):number{
 if(value===undefined&&defaultValue!==undefined)return defaultValue
 if(value===undefined||! /^(?:0|[1-9][0-9]*)$/.test(value))unsupported()
 const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed>max)unsupported();return parsed
}
function pureNumericFormat(format:string):boolean{
 let rest=''
 for(let i=0;i<format.length;i++){
  const c=format[i]!
  if(c==='"'){let end=i+1;while(end<format.length&&format[end]!=='"')end++;if(end===format.length)return false;i=end}
  else if(c==='\\'||c==='_'||c==='*'){if(++i===format.length)return false}
  else if(c==='['){
   const end=format.indexOf(']',i+1);if(end<0)return false
   const bracket=format.slice(i+1,end)
   if(/-F(?:800|400)$/i.test(bracket)||! /^(?:Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Color(?:[1-9]|[1-4][0-9]|5[0-6])|(?:<=|>=|<>|<|>|=)[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)|\$[^\[\]\x00-\x1f]*-[0-9a-fA-F]+)$/i.test(bracket))return false
   i=end
  }else rest+=c
 }
 if(!rest||/[ymdhs\[\]"\\]/i.test(rest))return false
 // E 仅限科学数字指数语法；General 是唯一接受的单词。
 rest=rest.replace(/General/gi,'0').replace(/[Ee][+-][0#?]+/g,'0')
 return /^[0#?.,%+\-\/():; $€£¥]+$/.test(rest)&&/[0#?]/.test(rest)
}
function styles(root:Node|undefined):(index:string|undefined)=>boolean{
 if(!root)return index=>{if(index!==undefined&&index!=='0')fail('xlsx-style','业务 XLSX 单元格样式索引不存在。');return true}
 if(root.name!=='styleSheet')unsupported()
 validateGrammar(root,S,styleGrammar)
 for(const n of root.children)if(root.children.filter(c=>c.name===n.name).length>1)unsupported()
 const formats=new Map<number,string>(),fmtNodes=one(root,'numFmts')?.children??[]
 if(fmtNodes.length>256)limit()
 for(const n of fmtNodes){const id=uint(attr(n,'numFmtId'),65535),code=attr(n,'formatCode');if(id<164||code===undefined||formats.has(id))unsupported();formats.set(id,code)}
 const base=one(root,'cellStyleXfs')?.children??[],cells=one(root,'cellXfs')?.children??[]
 if(!cells.length||cells.length+base.length>1024)limit()
 const safeFormat=(id:number):boolean=>{
  if(formats.has(id))return pureNumericFormat(formats.get(id)!)
  return id<=4||id>=9&&id<=13||id>=37&&id<=44||id===48||id===49
 }
 const safeXf=(xf:Node)=>safeFormat(uint(attr(xf,'numFmtId'),65535,0))
 const safeCells=cells.map(xf=>{
  const id=attr(xf,'xfId');if(id===undefined)return safeXf(xf)
  const inherited=base[uint(id,1023)];if(!inherited)unsupported();return safeXf(xf)&&safeXf(inherited)
 })
 return index=>{const id=uint(index,1023,0);if(id>=cells.length)fail('xlsx-style','业务 XLSX 单元格样式索引不存在。');return safeCells[id]!}
}
function ordinaryString(n:Node):string{
 structure(n,S,n.name,['t'])
 const t=one(n,'t',true)!;leaf(t,[],true);return xstring(t.text)
}
function sharedStrings(root:Node|undefined):string[]{
 if(!root)return []
 structure(root,S,'sst',['si'],['count','uniqueCount'])
 if(root.children.length>8192)limit()
 return root.children.map(ordinaryString)
}

const themeGrammar:Record<string,[string[],string[]]>={
 theme:[['themeElements','objectDefaults','extraClrSchemeLst'],['name']],themeElements:[['clrScheme','fontScheme','fmtScheme'],[]],
 clrScheme:[['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'],['name']],
 fontScheme:[['majorFont','minorFont'],['name']],majorFont:[['latin','ea','cs','font'],[]],minorFont:[['latin','ea','cs','font'],[]],latin:[[],['typeface','panose','pitchFamily','charset']],ea:[[],['typeface','panose','pitchFamily','charset']],cs:[[],['typeface','panose','pitchFamily','charset']],font:[[],['script','typeface']],
 fmtScheme:[['fillStyleLst','lnStyleLst','effectStyleLst','bgFillStyleLst'],['name']],fillStyleLst:[['solidFill','gradFill','pattFill','noFill','grpFill'],[]],bgFillStyleLst:[['solidFill','gradFill','pattFill','noFill','grpFill'],[]],lnStyleLst:[['ln'],[]],effectStyleLst:[['effectStyle'],[]],effectStyle:[['effectLst','scene3d','sp3d'],[]],
 solidFill:[['srgbClr','schemeClr','sysClr','prstClr','scrgbClr','hslClr'],[]],gradFill:[['gsLst','lin','path','tileRect'],['flip','rotWithShape']],gsLst:[['gs'],[]],gs:[['srgbClr','schemeClr','sysClr','prstClr','scrgbClr','hslClr'],['pos']],lin:[[],['ang','scaled']],path:[['fillToRect'],['path']],fillToRect:[[],['l','t','r','b']],tileRect:[[],['l','t','r','b']],pattFill:[['fgClr','bgClr'],['prst']],fgClr:[['srgbClr','schemeClr','sysClr','prstClr'],[]],bgClr:[['srgbClr','schemeClr','sysClr','prstClr'],[]],noFill:[[],[]],grpFill:[[],[]],
 ln:[['noFill','solidFill','gradFill','pattFill','prstDash','custDash','round','bevel','miter','headEnd','tailEnd'],['w','cap','cmpd','algn']],prstDash:[[],['val']],custDash:[['ds'],[]],ds:[[],['d','sp']],round:[[],[]],bevel:[[],[]],miter:[[],['lim']],headEnd:[[],['type','w','len']],tailEnd:[[],['type','w','len']],
 effectLst:[['outerShdw','innerShdw','glow','softEdge','reflection','blur','fillOverlay','prstShdw'],[]],outerShdw:[['srgbClr','schemeClr','sysClr','prstClr'],['blurRad','dist','dir','sx','sy','kx','ky','algn','rotWithShape']],innerShdw:[['srgbClr','schemeClr','sysClr','prstClr'],['blurRad','dist','dir']],glow:[['srgbClr','schemeClr','sysClr','prstClr'],['rad']],softEdge:[[],['rad']],blur:[[],['rad','grow']],reflection:[[],['blurRad','stA','stPos','endA','endPos','dist','dir','fadeDir','sx','sy','kx','ky','algn','rotWithShape']],fillOverlay:[['solidFill','gradFill','pattFill','noFill','grpFill'],['blend']],prstShdw:[['srgbClr','schemeClr','sysClr','prstClr'],['prst','dist','dir']],
 scene3d:[['camera','lightRig','backdrop'],[]],camera:[['rot'],['prst','fov','zoom']],lightRig:[['rot'],['rig','dir']],rot:[[],['lat','lon','rev']],backdrop:[['anchor','norm','up'],[]],anchor:[[],['x','y','z']],norm:[[],['dx','dy','dz']],up:[[],['dx','dy','dz']],
 sp3d:[['bevelT','bevelB','extrusionClr','contourClr'],['z','extrusionH','contourW','prstMaterial']],bevelT:[[],['w','h','prst']],bevelB:[[],['w','h','prst']],extrusionClr:[['srgbClr','schemeClr','sysClr','prstClr'],[]],contourClr:[['srgbClr','schemeClr','sysClr','prstClr'],[]],
 objectDefaults:[[],[]],extraClrSchemeLst:[[],[]],
}
const colorTransforms=['tint','shade','comp','inv','gray','alpha','alphaOff','alphaMod','hue','hueOff','hueMod','sat','satOff','satMod','lum','lumOff','lumMod','red','redOff','redMod','green','greenOff','greenMod','blue','blueOff','blueMod','gamma','invGamma']
for(const n of ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'])themeGrammar[n]=[['srgbClr','schemeClr','sysClr','prstClr','scrgbClr','hslClr'],[]]
for(const n of ['srgbClr','schemeClr','prstClr'])themeGrammar[n]=[colorTransforms,['val']]
themeGrammar.sysClr=[colorTransforms,['val','lastClr']];themeGrammar.scrgbClr=[colorTransforms,['r','g','b']];themeGrammar.hslClr=[colorTransforms,['hue','sat','lum']]
for(const n of colorTransforms)themeGrammar[n]=[[],['val']]
const tableGrammar:Record<string,[string[],string[]]>={table:[['autoFilter','tableColumns','tableStyleInfo'],['id','name','displayName','ref','headerRowCount','totalsRowCount','totalsRowShown','published','headerRowDxfId','dataDxfId','totalsRowDxfId','headerRowBorderDxfId','tableBorderDxfId','totalsRowBorderDxfId','headerRowCellStyle','dataCellStyle','totalsRowCellStyle']],autoFilter:[[],['ref']],tableColumns:[['tableColumn'],['count']],tableColumn:[[],['id','name','uniqueName','totalsRowLabel','totalsRowFunction','headerRowDxfId','dataDxfId','totalsRowDxfId','headerRowCellStyle','dataCellStyle','totalsRowCellStyle']],tableStyleInfo:[[],['name','showFirstColumn','showLastColumn','showRowStripes','showColumnStripes']]}
function properties(root:Node,kind:Kind){
 const ns=kind==='core'?CORE:kind==='extended'?EP:CP,rootName=kind==='core'?'coreProperties':'Properties'
 if(root.ns!==ns||root.name!==rootName||root.text.trim())unsupported();attributes(root,[])
 const coreNames=new Set(['category','contentStatus','keywords','lastModifiedBy','lastPrinted','revision','version']),dcNames=new Set(['creator','description','identifier','language','subject','title'])
 const extendedNames=new Set(['Application','AppVersion','Company','Manager','Template','TotalTime','Pages','Words','Characters','CharactersWithSpaces','Lines','Paragraphs','Slides','Notes','HiddenSlides','MMClips','ScaleCrop','LinksUpToDate','SharedDoc','HyperlinksChanged','DocSecurity','HeadingPairs','TitlesOfParts','HLinks','HyperlinkBase','PresentationFormat'])
 const variants=new Set(['vector','variant','lpstr','lpwstr','bstr','i1','i2','i4','i8','int','ui1','ui2','ui4','ui8','uint','r4','r8','decimal','date','filetime','bool','cy','error','empty','null'])
 const variant=(n:Node)=>{if(n.ns!==VT||!variants.has(n.name))unsupported();attributes(n,n.name==='vector'?['size','baseType']:[]);if(!['vector','variant'].includes(n.name)&&n.children.length||['vector','variant'].includes(n.name)&&n.text.trim())unsupported();for(const c of n.children)variant(c)}
 for(const n of root.children){
  if(kind==='core'){
   if(n.ns===CORE&&coreNames.has(n.name)||n.ns===DC&&dcNames.has(n.name))leaf(n)
   else if(n.ns===DCT&&['created','modified'].includes(n.name)){attributes(n,[],{[XSI]:['type']});if(n.children.length||attr(n,'type',XSI)!=='dcterms:W3CDTF')unsupported()}
   else unsupported()
  }else if(kind==='extended'){
   if(n.ns!==EP||!extendedNames.has(n.name))unsupported();attributes(n,[])
   if(['HeadingPairs','TitlesOfParts','HLinks'].includes(n.name)){if(n.text.trim())unsupported();for(const c of n.children)variant(c)}else if(n.children.length)unsupported()
  }else{
   if(n.ns!==CP||n.name!=='property'||n.text.trim()||n.children.length!==1)unsupported();attributes(n,['fmtid','pid','name','linkTarget']);if(attr(n,'linkTarget')!==undefined)unsupported();variant(n.children[0]!)
  }
 }
}
function validateParts(trees:Map<string,Node>,kinds:Map<string,Kind>){
 for(const [path,kind] of kinds){
  const n=trees.get(path)!
  if(kind==='worksheet')worksheetStructure(n)
  else if(kind==='styles')styles(n)
  else if(kind==='sharedStrings')sharedStrings(n)
  else if(kind==='theme'){if(n.name!=='theme')unsupported();validateGrammar(n,A,themeGrammar)}
  else if(kind==='core'||kind==='extended'||kind==='custom')properties(n,kind)
  else if(kind==='table'){if(n.name!=='table')unsupported();validateGrammar(n,S,tableGrammar)}
  else if(kind==='calcChain'){structure(n,S,'calcChain',['c']);for(const c of n.children)structure(c,S,'c',[],['r','i','s','l','t','a'])}
 }
}
async function inspect(parts:readonly BusinessImportOoxmlPart[],signal?:AbortSignal):Promise<Package>{
 const trees=await parseTrees(parts,signal),kinds=contentTypes(trees),rels=readRelationships(trees,kinds)
 const documents=rels.get('')!.filter(r=>r.kind==='workbook');if(documents.length!==1)badRelationship()
 if([...kinds.values()].filter(kind=>kind==='workbook').length!==1)badPackage()
 const workbook=documents[0]!.target,workbookRels=rels.get(workbook);if(!workbookRels)badRelationship()
 const {sheets,states}=workbookSheets(trees.get(workbook)!,workbookRels)
 validateParts(trees,kinds);signal?.throwIfAborted();return {trees,kinds,rels,workbook,sheets,states}
}
export async function inspectBusinessImportWorkbookParts(parts:readonly BusinessImportOoxmlPart[],signal?:AbortSignal):Promise<{sheets:BusinessImportSheetV2[];policy:BusinessImportPolicyV2}>{
 const pkg=await inspect(parts,signal);signal?.throwIfAborted();return {sheets:pkg.sheets,policy:policy()}
}
function reference(value:string|undefined):{row:number;column:number}{
 const match=value&&/^([A-Z]{1,3})([1-9][0-9]*)$/.exec(value)
 if(!match)fail('xlsx-coordinate','业务 XLSX 单元格坐标缺失或格式不正确。')
 const row=Number(match[2]);let column=0;for(const char of match[1]!)column=column*26+char.charCodeAt(0)-64
 if(!Number.isSafeInteger(row)||row>51||column>64)limit();return {row,column:column-1}
}
function hidden(value:string|undefined):boolean{
 if(value===undefined||value==='0'||value==='false')return false
 if(value==='1'||value==='true')return true
 unsupported()
}
function cell(n:Node,row:number,column:number,strings:string[],safeStyle:(index:string|undefined)=>boolean):BusinessImportCellV2{
 structure(n,S,'c',['v','is','f'],['r','s','t'])
 if(n.children.some(c=>c.name==='f'))fail('xlsx-formula','业务 XLSX 含公式；请将公式转成普通值后导入。',row,column)
 if(!safeStyle(attr(n,'s')))fail('xlsx-date','业务 XLSX 含日期、时间或无法证明为普通数字的样式；请转为普通文本。',row,column)
 const type=attr(n,'t')??'n'
 if(type==='d')fail('xlsx-date','业务 XLSX 含日期类型；请转为普通文本后导入。',row,column)
 if(!['n','str','s','inlineStr','b'].includes(type))fail('xlsx-type','业务 XLSX 含错误值或不支持的单元格类型。',row,column)
 const v=one(n,'v'),inline=one(n,'is');if(v)leaf(v,[],true)
 if(type==='inlineStr'){if(v||!inline)unsupported();return read(()=>readBusinessImportCellV2({kind:'string',text:ordinaryString(inline)}))}
 if(inline)unsupported()
 if(type==='str')return read(()=>readBusinessImportCellV2({kind:'string',text:xstring(v?.text??'')}))
 if(type==='n')return read(()=>readBusinessImportCellV2(v?.text?{kind:'number',text:v.text}:{kind:'blank',text:''}))
 if(type==='b'){if(v?.text!=='0'&&v?.text!=='1')fail('xlsx-type','业务 XLSX 布尔单元格只能使用原值 0 或 1。',row,column);return {kind:'boolean',text:v.text==='1'?'true':'false'}}
 if(v===undefined||! /^(?:0|[1-9][0-9]*)$/.test(v.text))fail('xlsx-string','业务 XLSX 共享字符串索引不正确。',row,column)
 const index=Number(v.text);if(!Number.isSafeInteger(index)||index>=strings.length)fail('xlsx-string','业务 XLSX 共享字符串引用不存在。',row,column)
 return {kind:'string',text:strings[index]!}
}
export async function parseBusinessImportSheetParts(parts:readonly BusinessImportOoxmlPart[],input:BusinessImportSourceV2,signal?:AbortSignal):Promise<BusinessImportTableV2>{
 signal?.throwIfAborted()
 const source=read(()=>readBusinessImportSourceV2(input),'xlsx-sheet','请选择当前 XLSX 中准确的工作表。')
 const pkg=await inspect(parts,signal),match=pkg.sheets.find(s=>s.sheetId===source.sheet.sheetId&&s.name===source.sheet.name&&s.part===source.sheet.part)
 if(!match)fail('xlsx-sheet','所选工作表与当前 XLSX 的名称、编号或部件不一致。')
 if(pkg.states.get(match.part)!=='visible')fail('xlsx-hidden','所选工作表已隐藏；请选择可见工作表。')
 const root=pkg.trees.get(match.part)!
 for(const n of root.children)if(restrictedSheet.includes(n.name))fail(n.name==='mergeCells'?'xlsx-merged':'xlsx-feature','所选工作表含合并、筛选、保护或其他不支持的功能；请转为普通表格。')
 const format=one(root,'sheetFormatPr');if(format&&hidden(attr(format,'zeroHeight')))fail('xlsx-hidden','所选工作表隐藏了默认行；请取消隐藏后导入。')
 const workbookRels=pkg.rels.get(pkg.workbook)!,stylePart=workbookRels.find(r=>r.kind==='styles')?.target,stringPart=workbookRels.find(r=>r.kind==='sharedStrings')?.target
 const safeStyle=styles(stylePart?pkg.trees.get(stylePart):undefined),strings=sharedStrings(stringPart?pkg.trees.get(stringPart):undefined)
 for(const col of one(root,'cols')?.children??[]){
  const min=uint(attr(col,'min'),16384),max=uint(attr(col,'max'),16384);if(min<1||max<min)unsupported()
  if(hidden(attr(col,'hidden')))fail('xlsx-hidden','所选工作表含隐藏列；请取消隐藏后导入。')
  if(!safeStyle(attr(col,'style')))fail('xlsx-date','所选工作表列样式包含日期或无法证明为普通数字的格式。')
 }
 const dim=one(root,'dimension');if(dim){const ref=attr(dim,'ref');if(!ref||! /^[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?$/.test(ref))fail('xlsx-coordinate','业务 XLSX 声明的工作表尺寸格式不正确。')}
 const data=one(root,'sheetData',true)!;structure(data,S,'sheetData',['row'])
 const sparse=new Map<number,Map<number,BusinessImportCellV2>>();let lastRow=0,lastCellRow=0,width=0,count=0
 for(const row of data.children){
  structure(row,S,'row',['c'],['r','spans','s','customFormat','ht','hidden','customHeight','outlineLevel','collapsed','thickTop','thickBot','ph'])
  const number=uint(attr(row,'r'),1048576);if(number<1||number<=lastRow)fail('xlsx-coordinate','业务 XLSX 行坐标重复或没有按顺序排列。');lastRow=number
  if(hidden(attr(row,'hidden')))fail('xlsx-hidden','所选工作表含隐藏行；请取消隐藏后导入。',number)
  if(!safeStyle(attr(row,'s')))fail('xlsx-date','所选工作表行样式包含日期或无法证明为普通数字的格式。',number)
  const cells=new Map<number,BusinessImportCellV2>();sparse.set(number,cells);let lastColumn=-1
  for(const n of row.children){
   if(++count%256===0)await checkpoint(signal)
   const position=reference(attr(n,'r'))
   if(position.row!==number||position.column<=lastColumn)fail('xlsx-coordinate','业务 XLSX 单元格坐标重复、乱序或不属于所在行。',number,position.column)
   lastColumn=position.column;lastCellRow=number;width=Math.max(width,lastColumn+1)
   try{cells.set(lastColumn,cell(n,number,lastColumn,strings,safeStyle))}catch(error){
    if(error instanceof WorkError){
     const issue=(error.details?.businessImportIssues as {code:string;message:string}[]|undefined)?.[0]
     if(issue)fail(issue.code,issue.message,number,lastColumn)
    }
    throw error
   }
  }
 }
 if(lastCellRow<2||width<1)fail('xlsx-empty','业务 XLSX 至少需要表头和一行数据。')
 const rows=Array.from({length:lastCellRow},(_,i)=>({rowNumber:i+1,cells:Array.from({length:width},(_,column)=>sparse.get(i+1)?.get(column)??{kind:'blank' as const,text:'' as const})}))
 const table=read(()=>readBusinessImportTableV2({format:'teloa.business-import-table/v2',source,policy:policy(),columns:width,rows}))
 signal?.throwIfAborted();return table
}
