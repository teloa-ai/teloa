import assert from 'node:assert/strict'
import test from 'node:test'
import {readBusinessImportXml} from '../src/work/business-import-xml.ts'
const read=(source:string,signal?:AbortSignal)=>readBusinessImportXml(new TextEncoder().encode(source),2*1024*1024,signal)
test('preserves_scalar_lexemes_and_namespace_identity',async()=>{
 const events=await read('<s:worksheet xmlns:s="urn:sheet" xmlns="urn:default" id="001"><v>123456789012345678.1234</v><s:c/></s:worksheet>')
 assert.deepEqual(events,[
 {type:'start',name:{namespace:'urn:sheet',local:'worksheet'},position:0,attributes:[{name:{namespace:'',local:'id'},value:'001'}]},
 {type:'start',name:{namespace:'urn:default',local:'v'},position:62,attributes:[]},
 {type:'text',position:65,value:'123456789012345678.1234'},
 {type:'end',name:{namespace:'urn:default',local:'v'},position:88},
 {type:'start',name:{namespace:'urn:sheet',local:'c'},position:92,attributes:[]},
 {type:'end',name:{namespace:'urn:sheet',local:'c'},position:92},
 {type:'end',name:{namespace:'urn:sheet',local:'worksheet'},position:98}])
})
test('entities_normalization_and_namespace_shadowing',async()=>{
 const events=await read('\ufeff<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a xmlns="u" xmlns:p="v" x="a\t\r\nb&#10;&#9; &lt;&gt;&amp;&apos;&quot;" p:y="😀"><p:b xmlns:p="w"> 001 &amp; &#x1F600;\r\n</p:b></a>')
 const start=events.find(e=>e.type==='start')!
 assert.equal(start.type,'start')
 if(start.type==='start')assert.deepEqual(start.attributes,[{name:{namespace:'',local:'x'},value:'a  b\n\t <>&\'"'},{name:{namespace:'v',local:'y'},value:'😀'}])
 assert.ok(events.some(e=>e.type==='start'&&e.name.namespace==='w'))
 assert.ok(events.some(e=>e.type==='text'&&e.value===' 001 & 😀\n'))
})
const bad=['','<a>','<a/><b/>','<a/>tail','x<a/>','<a></b>','<a x="1"x="2"/>','<a x="1" x="2"/>','<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>','<p:a/>','<a p:x="1"/>','<a xmlns:xml="u"/>','<a xmlns:xmlns="u"/>','<a xmlns:p=""/>','<a xmlns="http://www.w3.org/XML/1998/namespace"/>','<a xmlns:p="http://www.w3.org/2000/xmlns/"/>','<xmlns:a/>','<a>&unknown;</a>','<a>&#0;</a>','<a>&#xD800;</a>','<a>&#x110000;</a>','<a>&#9999999999999999999999;</a>','<a>&#x;</a>','<a>&#-1;</a>','<a>&#X41;</a>','<a>]]></a>','<a x="<"/>','<a x=1/>','<a/ >','<a></a x>','<!DOCTYPE a><a/>','<a><![CDATA[x]]></a>','<?p x?><a/>','<a/><?xml version="1.0"?>',' <?xml version="1.0"?><a/>','<?xml version="1.1"?><a/>','<?xml encoding="UTF-8" version="1.0"?><a/>','<?xml version="1.0" encoding="UTF-16"?><a/>','<?xml version="1.0" unknown="x"?><a/>','<a><!--x--y--></a>','<a><!--x---></a>','<a><!--tail</a>','<a>\u0001</a>','<a/>\ufffe','\ufeff\ufeff<a/>','<é/>','<a:b:c/>']
for(const [index,source] of bad.entries())test(`rejects_closed_subset_invalid_${index}`,async()=>{
 await assert.rejects(read(source),error=>error instanceof Error&&error.message==='业务表格 XML 格式或大小不符合导入要求。')
})
test('comments_and_outside_whitespace',async()=>{
 assert.deepEqual(await read(' \n<!--ok--><a><!--x-->a<!--b-->b</a>\t'),[
 {type:'start',name:{namespace:'',local:'a'},position:11,attributes:[]},
 {type:'text',position:22,value:'a'},{type:'text',position:31,value:'b'},
 {type:'end',name:{namespace:'',local:'a'},position:32}])
})
test('rejects_utf8_and_all_budget_overflows',async()=>{
 await assert.rejects(readBusinessImportXml(new Uint8Array([0xc0,0xaf]),100))
 for(const max of [0,-1,NaN,Infinity,2*1024*1024+1,1.5])await assert.rejects(readBusinessImportXml(new TextEncoder().encode('<a/>'),max))
 await assert.rejects(readBusinessImportXml(new TextEncoder().encode('<a/>'),3))
 for(const source of ['<a>'.repeat(17)+'</a>'.repeat(17),`<${'a'.repeat(65)}/>`,`<a ${Array.from({length:25},(_,i)=>`a${i}=""`).join(' ')}/>`,`<a x="${'x'.repeat(4001)}"/>`,`<a>${'x'.repeat(4001)}</a>`,`<a>${'<b/>'.repeat(20000)}</a>`,`<a>${'<b>x<!-- -->y</b>'.repeat(15000)}</a>`])await assert.rejects(read(source))
})
test('accepts_exact_bounded_limits',async()=>{
 await read('<a>'.repeat(16)+'</a>'.repeat(16))
 await read(`<${'a'.repeat(64)}/>`)
 await read(`<a ${Array.from({length:24},(_,i)=>`a${i}=""`).join(' ')}>${'x'.repeat(4000)}</a>`)
 await read(`<a x="${'x'.repeat(4000)}"/>`)
 await read(`<a>${'<b/>'.repeat(19999)}</a>`)
})
test('preserves_precancel_and_inflight_reason',async()=>{
 const reason={cancelled:true},controller=new AbortController();controller.abort(reason)
 await assert.rejects(read('<a/>',controller.signal),e=>e===reason)
 const active=new AbortController()
 const promise=read(`<a>${'<b/>'.repeat(5000)}</a>`,active.signal)
 setImmediate(()=>active.abort(reason))
 await assert.rejects(promise,e=>e===reason)
})
test('event_checkpoint_cancellation_preserves_reason',async()=>{
 const controller=new AbortController(),reason=new Error('本人取消')
 const promise=read(`<a>${'<b/>'.repeat(200)}</a>`,controller.signal)
 setImmediate(()=>controller.abort(reason))
 await assert.rejects(promise,e=>e===reason)
})
test('normalizes_source_positions_and_accepts_xml_binding',async()=>{
 assert.deepEqual(await read('\ufeff\r\n<a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:space="preserve">\rX\r\nY</a>'),[
 {type:'start',name:{namespace:'',local:'a'},position:1,attributes:[{name:{namespace:'http://www.w3.org/XML/1998/namespace',local:'space'},value:'preserve'}]},
 {type:'text',value:'\nX\nY',position:74},
 {type:'end',name:{namespace:'',local:'a'},position:78}])
})
test('default_namespace_resets_and_end_tag_must_match_qname',async()=>{
 const events=await read('<a xmlns="u"><b xmlns="" x="1"/></a>')
 assert.ok(events.some(e=>e.type==='start'&&e.name.local==='b'&&e.name.namespace===''))
 await assert.rejects(read('<p:a xmlns:p="u" xmlns:q="u"></q:a>'))
})
