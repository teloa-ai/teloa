import test from 'node:test'
import assert from 'node:assert/strict'
import {readModelOptionsDirectory} from '../src/model-options.ts'
const directory=()=>({default:{provider:'cloud',model:'large'},groups:[{id:'cloud',name:'Cloud',remote:true,models:[{id:'large',name:'Large',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}]}],failures:[{id:'offline',name:'Offline'}]})
test('模型选项保留原生身份与思考能力，允许尚无默认模型',()=>{
 assert.deepEqual(readModelOptionsDirectory(directory()),directory())
 assert.deepEqual(readModelOptionsDirectory({default:null,groups:[],failures:[]}),{default:null,groups:[],failures:[]})
})
test('模型目录拒绝地址、凭据、错误原文和重复身份',()=>{
 for(const edit of [(v:any)=>v.groups[0].baseURL='https://private.test',(v:any)=>v.groups[0].models[0].apiKey='secret',(v:any)=>v.failures[0].message='token',(v:any)=>v.groups.push(v.groups[0]),(v:any)=>v.groups[0].models.push(v.groups[0].models[0]),(v:any)=>v.groups[0].remote='yes',(v:any)=>v.groups[0].models[0].reasoning.defaultEffort='missing']){
  const value=directory();edit(value);assert.throws(()=>readModelOptionsDirectory(value))
 }
})
