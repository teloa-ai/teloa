import {readFile} from 'node:fs/promises'
import {SecurityActionHttpAdapter} from '../../src/security-action-http-adapter.ts'
import type {SecurityActionDispatch} from '@teloa/contract'

process.once('message',(input:{baseUrl:string;token:string;dispatchFile:string;method:'execute'|'observe'})=>{
 void (async()=>{
  const dispatch=JSON.parse(await readFile(input.dispatchFile,'utf8')) as SecurityActionDispatch
  const adapter=new SecurityActionHttpAdapter({baseUrl:input.baseUrl,token:input.token})
  const receipt=await adapter[input.method](dispatch,new AbortController().signal)
  process.send?.({pid:process.pid,receipt},()=>process.disconnect())
 })().catch(()=>process.send?.({error:true},()=>process.disconnect()))
})
