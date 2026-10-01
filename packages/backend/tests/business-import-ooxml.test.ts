import assert from 'node:assert/strict'
import test from 'node:test'
import {inspectBusinessImportWorkbookParts,parseBusinessImportSheetParts,type BusinessImportOoxmlPart} from '../src/work/business-import-ooxml.ts'
const S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P='http://schemas.openxmlformats.org/package/2006/relationships'
const C='http://schemas.openxmlformats.org/package/2006/content-types'
const mime='application/vnd.openxmlformats-officedocument.spreadsheetml.'
const part=(path:string,xml:string):BusinessImportOoxmlPart=>({path,bytes:new TextEncoder().encode(xml)})
const rel=(id:string,type:string,target:string,extra='')=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${target}" ${extra}/>`
const relations=(xml:string)=>`<Relationships xmlns="${P}">${xml}</Relationships>`
const sheet=(xml:string)=>`<worksheet xmlns="${S}" xmlns:r="${R}">${xml}</worksheet>`
const data=(xml:string)=>sheet(`<sheetData>${xml}</sheetData>`)
const header='<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>'
const basic=data(header+'<row r="2"><c r="A2"><v>001</v></c></row>')
function fixture(selected=basic,extra:BusinessImportOoxmlPart[]=[]):BusinessImportOoxmlPart[]{
 const extraTypes=extra.filter(p=>!p.path.endsWith('.rels')).map(p=>`<Override PartName="/${p.path}" ContentType="${mime}${p.path.includes('styles')?'styles':'sharedStrings'}+xml"/>`).join('')
 return [part('[Content_Types].xml',`<Types xmlns="${C}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/book/main.xml" ContentType="${mime}sheet.main+xml"/><Override PartName="/data/one.xml" ContentType="${mime}worksheet+xml"/><Override PartName="/data/two.xml" ContentType="${mime}worksheet+xml"/>${extraTypes}</Types>`),part('_rels/.rels',relations(rel('root','officeDocument','book/main.xml'))),part('book/main.xml',`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="第一表" sheetId="7" r:id="one"/><sheet name=" 第二表 " sheetId="9" r:id="two"/></sheets></workbook>`),part('book/_rels/main.xml.rels',relations(rel('one','worksheet','../data/one.xml')+rel('two','worksheet','/data/two.xml')+extra.filter(p=>p.path.includes('styles')||p.path.includes('sharedStrings')).map(p=>rel(p.path, p.path.includes('styles')?'styles':'sharedStrings',`../${p.path}`)).join(''))),part('data/one.xml',basic),part('data/two.xml',selected),...extra]
}
const source={kind:'xlsx' as const,sheet:{sheetId:'9',name:' 第二表 ',part:'data/two.xml'}}
test('准确关系选择第二表并保留全部标量和数字词法',async()=>{
 const selected=data(header+'<row r="2"><c r="A2"><v>001</v></c><c r="B2"><v>123456789012345678.1234</v></c><c r="C2"><v>1.25E+20</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="str"><v>  文本  </v></c><c r="G2"/></row>')
 const parts=fixture(selected)
 assert.deepEqual((await inspectBusinessImportWorkbookParts(parts)).sheets,[{sheetId:'7',name:'第一表',part:'data/one.xml'},source.sheet])
 const table=await parseBusinessImportSheetParts(parts,source)
 assert.equal(table.columns,7)
 assert.deepEqual(table.rows[1]!.cells,[{kind:'number',text:'001'},{kind:'number',text:'123456789012345678.1234'},{kind:'number',text:'1.25E+20'},{kind:'boolean',text:'true'},{kind:'string',text:'  文本  '},{kind:'blank',text:''},{kind:'blank',text:''}])
 assert.deepEqual(table.source,source)
 assert.equal(Object.hasOwn(table,'fileHash'),false)
})
function replace(parts:BusinessImportOoxmlPart[],path:string,from:string,to:string){return parts.map(p=>p.path===path?part(path,new TextDecoder().decode(p.bytes).replace(from,to)):p)}
function issue(error:unknown,code?:string,row?:number,column?:number):boolean{
 assert.ok(error instanceof Error)
 const e=error as Error&{code:string;details:{businessImportIssues:{code:string;message:string;rowNumber?:number;column?:number}[]}}
 assert.equal(e.code,'teloa/invalid-input');assert.equal(e.details.businessImportIssues.length,1)
 const i=e.details.businessImportIssues[0]!
 if(code)assert.equal(i.code,code)
 if(row!==undefined)assert.equal(i.rowNumber,row)
 if(column!==undefined)assert.equal(i.column,column)
 assert.ok(i.code.length<=64&&i.message.length<=240);return true
}
const parse=(parts:BusinessImportOoxmlPart[])=>parseBusinessImportSheetParts(parts,source)
const rejected=(parts:BusinessImportOoxmlPart[],code?:string,row?:number,column?:number)=>assert.rejects(parse(parts),e=>issue(e,code,row,column))
const withCell=(xml:string)=>fixture(data(header+`<row r="2">${xml}</row>`))
const withStyles=(xml:string,cell='<c r="A2" s="1"><v>001</v></c>')=>fixture(data(header+`<row r="2">${cell}</row>`),[part('assets/styles.xml',`<styleSheet xmlns="${S}">${xml}</styleSheet>`)])
test('稀疏矩形保留中间空行且尺寸声明不预分配',async()=>{
 const table=await parse(fixture(sheet('<dimension ref="A1:XFD1048576"/><sheetData>'+header+'<row r="3"><c r="B3" t="str"><v/></c></row></sheetData>')))
 assert.equal(table.rows.length,3);assert.equal(table.columns,2)
 assert.deepEqual(table.rows[1]!.cells,[{kind:'blank',text:''},{kind:'blank',text:''}])
 assert.deepEqual(table.rows[2]!.cells,[{kind:'blank',text:''},{kind:'string',text:''}])
 const tail=replace(fixture(), 'data/two.xml','</sheetData>','<row r="1048576"/></sheetData>')
 assert.equal((await parse(tail)).rows.length,2,'尾部格式空行不扩大业务矩形')
 await rejected(replace(tail,'data/two.xml','r="1048576"','r="1048576" hidden="1"'),'xlsx-hidden',1048576)
})
test('共享和内联字符串的单次转义、字面保护和空白',async()=>{
 const sst=part('assets/sharedStrings.xml',`<sst xmlns="${S}" count="999999999" uniqueCount="999999999"><si><t xml:space="preserve"> a_x000D__x005F_x0041_&#9;&#10;_xD83D__xDE00_ </t></si><si><t/></si></sst>`)
 const table=await parse(fixture(data(header+'<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t xml:space="default">_x005F_x0000_</t></is></c><c r="C2" t="str"><v xml:space="preserve">_x0041_</v></c><c r="D2" t="s"><v>1</v></c><c r="E2"><v/></c><c r="F2" t="b"><v>0</v></c></row>'),[sst]))
 assert.deepEqual(table.rows[1]!.cells,[{kind:'string',text:' a\r_x0041_\t\n😀 '},{kind:'string',text:'_x0000_'},{kind:'string',text:'A'},{kind:'string',text:''},{kind:'blank',text:''},{kind:'boolean',text:'false'}])
 const escaped=replace(fixture(),'book/main.xml',' 第二表 ','_x005F_x0041_')
 assert.equal((await inspectBusinessImportWorkbookParts(escaped)).sheets[1]!.name,'_x0041_')
})
test('全包部件、内容类型和全部关系拒绝无效或动态输入',async()=>{
 const cases=[
 fixture().filter(p=>p.path!=='[Content_Types].xml'),
 fixture().filter(p=>p.path!=='_rels/.rels'),
 [...fixture(),fixture()[0]!],
 [...fixture(),part('DATA/Two.xml',basic)],
 [...fixture(),part('é.xml',basic),part('e\u0301.xml',basic)],
 [...fixture(),part('../escape.xml',basic)],
 replace(fixture(),'[Content_Types].xml',`${mime}sheet.main+xml`,'application/vnd.ms-excel.sheet.macroEnabled.main+xml'),
 replace(fixture(),'[Content_Types].xml','/data/two.xml','/data/missing.xml'),
 replace(fixture(),'book/_rels/main.xml.rels','../data/one.xml','../../data/one.xml'),
 replace(fixture(),'book/_rels/main.xml.rels','/data/two.xml','data%2Ftwo.xml'),
 replace(fixture(),'book/_rels/main.xml.rels','/data/two.xml','https://example.test/x'),
 replace(fixture(),'book/_rels/main.xml.rels','/data/two.xml','/data/two.xml?x'),
 replace(fixture(),'book/_rels/main.xml.rels','Id="two"','Id="one"'),
 replace(fixture(),'book/_rels/main.xml.rels','Target="/data/two.xml"','Target="/data/two.xml" TargetMode="External"'),
 replace(fixture(),'book/_rels/main.xml.rels',`${R}/worksheet`,`${R}/externalLink`),
 replace(fixture(),'book/_rels/main.xml.rels','/data/two.xml','/data/one.xml'),
 [...fixture(),part('data/_rels/one.xml.rels',relations(rel('unsafe','hyperlink','https://example.test','TargetMode="External"')))],
 replace(fixture(),'data/one.xml','<worksheet','<worksheet xmlns:x="urn:unknown"').map(p=>p.path==='data/one.xml'?part(p.path,new TextDecoder().decode(p.bytes).replace('<sheetData>','<x:extension/><sheetData>')):p),
 replace(fixture(),'book/main.xml',S,'http://purl.oclc.org/ooxml/spreadsheetml/main'),
 ]
 for(const parts of cases)await rejected(parts)
 // XML 整部件读完：未选表的尾部同样不能被忽略。
 await rejected(replace(fixture(),'data/one.xml','</worksheet>','</worksheet><tail/>'),'xlsx-xml')
})
test('准确来源三元组、隐藏状态与重复身份',async()=>{
 for(const selected of [{...source.sheet,name:'第二表'},{...source.sheet,sheetId:'7'},{...source.sheet,part:'data/one.xml'}])await assert.rejects(parseBusinessImportSheetParts(fixture(),{kind:'xlsx',sheet:selected}),e=>issue(e,'xlsx-sheet'))
 const hidden=replace(fixture(),'book/main.xml','sheetId="9"','sheetId="9" state="veryHidden"')
 assert.equal((await inspectBusinessImportWorkbookParts(hidden)).sheets.length,2)
 await rejected(hidden,'xlsx-hidden')
 for(const [from,to] of [['sheetId="9"','sheetId="7"'],[' 第二表 ','第一表'],['r:id="two"','r:id="one"'],['sheetId="9"','sheetId="9" state="invisible"']])await rejected(replace(fixture(),'book/main.xml',from!,to!))
})
test('所有选定单元格拒绝公式缓存、日期与歧义类型并附物理坐标',async()=>{
 for(const xml of ['<f/>','<f t="shared" si="1">A1</f><v>12</v>','<f t="array" ref="BL2:BL3">1</f><v>1</v>'])await rejected(withCell(`<c r="A2"><v>001</v></c><c r="BL2">${xml}</c>`),'xlsx-formula',2,63)
 for(const type of ['d','e','unknown'])await rejected(withCell(`<c r="A2" t="${type}"><v>12</v></c>`),type==='d'?'xlsx-date':'xlsx-type',2,0)
 for(const xml of ['<c r="A2" cm="1"><v>1</v></c>','<c r="A2"><v>1</v><v>2</v></c>','<c r="A2"><v>1</v><is><t>x</t></is></c>','<c r="A2" t="inlineStr"><v>x</v><is><t>x</t></is></c>','<c r="A2"><unknown/></c>','<c r="A2"><v> 001 </v></c>','<c r="A2" t="b"><v>true</v></c>'])await rejected(withCell(xml),undefined,2,0)
})
test('共享引用、富文本和不支持的字符转义整体拒绝',async()=>{
 for(const index of ['0','-1','01','1.0','999999999999999999999999'])await rejected(withCell(`<c r="A2" t="s"><v>${index}</v></c>`),'xlsx-string',2,0)
 for(const text of ['_x0000_','_x0001_','_x007F_','_xD800_','_xDC00_'])await rejected(withCell(`<c r="A2" t="inlineStr"><is><t>${text}</t></is></c>`))
 await rejected(withCell('<c r="A2" t="inlineStr"><is><r><t>x</t></r></is></c>'))
 await rejected(fixture(basic,[part('assets/sharedStrings.xml',`<sst xmlns="${S}"><si><r><t>x</t></r></si></sst>`)]))
 await rejected(withCell('<c r="A2" t="inlineStr"><is><t xml:space="unknown">x</t></is></c>'))
})
test('日期样式不能被applyNumberFormat或继承绕过',async()=>{
 const safe='<cellStyleXfs><xf numFmtId="0"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="0"/></cellXfs>'
 const fmt=(code:string)=>`<numFmts><numFmt numFmtId="164" formatCode="${code.replaceAll('&','&amp;').replaceAll('"','&quot;')}"/></numFmts>`
 assert.equal((await parse(withStyles(fmt('[Red][>=100][$USD-409]#,##0.00;0.00E+00')+safe))).rows[1]!.cells[0]!.text,'001')
 for(const id of ['14','22','27','36','45','47','50','58','5','59'])await rejected(withStyles(`<cellXfs><xf numFmtId="0"/><xf numFmtId="${id}" applyNumberFormat="0"/></cellXfs>`),'xlsx-date',2,0)
 for(const code of ['yyyy-mm-dd','[h]:mm','0 m','0[unknown]','0"unfinished','0\\','[$-F800]0'])await rejected(withStyles(fmt(code)+safe),'xlsx-date',2,0)
 await rejected(withStyles('<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="0" xfId="0" applyNumberFormat="0"/></cellXfs>'),'xlsx-date',2,0)
 await rejected(withStyles('<cellXfs><xf numFmtId="0"/></cellXfs>'),'xlsx-style',2,0)
 await rejected(withCell('<c r="A2" s="1"><v>001</v></c>'),'xlsx-style',2,0)
 const inherited=withStyles('<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>','<c r="A2"><v>001</v></c>')
 await rejected(replace(inherited,'data/two.xml','<row r="2">','<row r="2" s="1" customFormat="1">'),'xlsx-date',2)
 await rejected(replace(inherited,'data/two.xml','<sheetData>','<cols><col min="1" max="1" style="1"/></cols><sheetData>'),'xlsx-date')
 await rejected(replace(inherited,'data/two.xml','</sheetData>','<row r="1048576" s="1" customFormat="1"/></sheetData>'),'xlsx-date',1048576)
 const invalidRoot=withStyles('<cellXfs><xf numFmtId="0"/></cellXfs>','<c r="A2"><v>1</v></c>')
 await rejected(replace(invalidRoot,'assets/styles.xml',`<styleSheet xmlns="${S}"><cellXfs><xf numFmtId="0"/></cellXfs></styleSheet>`,`<constructor xmlns="${S}"><nested/></constructor>`),'xlsx-feature')
})
test('静态布局可读而隐藏、合并、筛选和关系功能拒绝',async()=>{
 const metadata='<sheetPr><tabColor rgb="FF000000"/><outlinePr summaryBelow="1"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:A2"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/><selection activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="10" hidden="false"/></cols>'
 const suffix='<printOptions gridLines="1"/><pageMargins left="1" right="1" top="1" bottom="1" header="0" footer="0"/><pageSetup orientation="portrait"/><headerFooter><oddHeader>标题</oddHeader></headerFooter>'
 assert.equal((await parse(fixture(sheet(metadata+'<sheetData>'+header+'<row r="2"><c r="A2"><v>001</v></c></row></sheetData>'+suffix)))).rows.length,2)
 assert.equal((await parse(replace(fixture(),'book/main.xml','</sheets>','</sheets><definedNames/>'))).rows.length,2)
 for(const xml of ['<mergeCells><mergeCell ref="A1:B1"/></mergeCells>','<autoFilter ref="A1:A2"/>','<dataValidations><dataValidation sqref="A1"/></dataValidations>','<hyperlinks><hyperlink ref="A1" r:id="x"/></hyperlinks>','<drawing r:id="x"/>','<tableParts><tablePart r:id="x"/></tableParts>','<sheetProtection sheet="1"/>'])await rejected(fixture(sheet('<sheetData>'+header+'<row r="2"><c r="A2"><v>1</v></c></row></sheetData>'+xml)))
 await rejected(fixture(data(header+'<row r="2" hidden="1"><c r="A2"><v>1</v></c></row>')),'xlsx-hidden',2)
 await rejected(fixture(sheet('<cols><col min="1" max="2" hidden="1"/></cols><sheetData>'+header+'<row r="2"><c r="A2"><v>1</v></c></row></sheetData>')),'xlsx-hidden')
 await rejected(fixture(sheet('<sheetFormatPr zeroHeight="1"/><sheetData>'+header+'<row r="2"><c r="A2"><v>1</v></c></row></sheetData>')),'xlsx-hidden')
 await rejected(fixture(sheet('<pageSetup r:id="printer"/><sheetData>'+header+'<row r="2"><c r="A2"><v>1</v></c></row></sheetData>')))
})
test('坐标、乱序、越界及末尾错误不得回传可采用前缀',async()=>{
 for(const xml of ['<row r="2"><c r="A2"><v>1</v></c><c r="A2"><v>2</v></c></row>','<row r="2"><c r="B2"><v>1</v></c><c r="A2"><v>2</v></c></row>','<row r="2"><c r="A3"><v>1</v></c></row>','<row r="2"><c r="a2"><v>1</v></c></row>','<row r="2"><c r="A02"><v>1</v></c></row>','<row r="2"><c r="BM2"><v>1</v></c></row>','<row r="52"><c r="A52"><v>1</v></c></row>','<row r="2"><c r="A2"><v>1</v></c></row><row r="2"/>','<row r="3"/><row r="2"><c r="A2"><v>1</v></c></row>'])await rejected(fixture(data(header+xml)))
 await rejected(fixture(data(header+'<row r="2"><c r="A2"><v>001</v></c><c r="BL2"><v>NaN</v></c></row>')),'xlsx-type',2,63)
})
test('资源预算、注释拆分与原取消原因',async()=>{
 await rejected([...fixture(),part('big.xml',' '.repeat(1024*1024+1))],'xlsx-limit')
 await rejected([...fixture(),...Array.from({length:59},(_,i)=>part(`extra${i}.xml`,'<x/>'))],'xlsx-limit')
 await rejected([...fixture(),...Array.from({length:3},(_,i)=>part(`large${i}.xml`,' '.repeat(800000)))],'xlsx-limit')
 const manyNodes=sheet('<sheetData>'+'<row/>'.repeat(19998)+'</sheetData>')
 await rejected(replace(fixture(manyNodes),'data/one.xml',basic,manyNodes),'xlsx-limit')
 const manyEvents=sheet('<sheetData>'+`<row><c><v>${'x<!-- -->'.repeat(45)}</v></c></row>`.repeat(1000)+'</sheetData>')
 const extraEvents=part('assets/sharedStrings.xml',`<sst xmlns="${S}">${`<si><t>${'x<!-- -->'.repeat(45)}</t></si>`.repeat(1000)}</sst>`)
 await rejected(replace(fixture(manyEvents,[extraEvents]),'data/one.xml',basic,manyEvents),'xlsx-limit')
 await rejected(withCell(`<c r="A2" t="str"><v>${'x'.repeat(2001)}<!-- split -->${'x'.repeat(2000)}</v></c>`),'xlsx-limit')
 const exact=await parse(withCell(`<c r="A2" t="str"><v>${'x'.repeat(2000)}<!-- split -->${'x'.repeat(2000)}</v></c>`));assert.equal(exact.rows[1]!.cells[0]!.text.length,4000)
 const reason={cancelled:true},pre=new AbortController();pre.abort(reason)
 await assert.rejects(parseBusinessImportSheetParts(fixture(),source,pre.signal),e=>e===reason)
 const active=new AbortController(),pending=parseBusinessImportSheetParts(fixture(data(header+Array.from({length:50},(_,i)=>`<row r="${i+2}">${Array.from({length:64},(_,j)=>{let n=j+1,name='';while(n){n--;name=String.fromCharCode(65+n%26)+name;n=Math.floor(n/26)}return `<c r="${name}${i+2}"><v>001</v></c>`}).join('')}</row>`).join(''))),source,active.signal)
 setImmediate(()=>active.abort(reason));await assert.rejects(pending,e=>e===reason)
})
