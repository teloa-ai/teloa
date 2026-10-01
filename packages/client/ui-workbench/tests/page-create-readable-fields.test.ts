import test from 'node:test'
import assert from 'node:assert/strict'
import {createReadableFields} from '../src/client/page-create-presentation.ts'

test('Skill 草案展示 UTF-8 正文与文件名，不展示 Base64 传输内容',()=>{
 const text='---\nname: lumen-review\ndescription: Review draft\n---\n# 核对初稿\n保留来源。'
 const base64=Buffer.from(text).toString('base64')
 const preview={draft:{entity:'skill',body:JSON.stringify({id:'lumen-review',title:'核对初稿',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64}]})},fields:[{path:'id',value:'lumen-review'},{path:'files[0].base64',value:base64},{path:'files[0].path',value:'SKILL.md'}]} as any
 const fields=createReadableFields(preview)
 assert.ok(fields.some(row=>row.path==='SKILL.md'&&row.value===text))
 assert.ok(!JSON.stringify(fields).includes(base64))
 assert.deepEqual(createReadableFields({...preview,draft:{entity:'role'}}),preview.fields)
})
