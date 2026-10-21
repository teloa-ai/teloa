import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {dashboardShareFixture} from '../../../backend/tests/fixtures/business-dashboard-share.ts'
// @ts-expect-error 复用已有隔离无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

/** 真 React 页面、协议读取器和群适配器；只有数据服务是本轮隔离夹具。 */
test('正式看板从抽屉导出真实 PNG/完整原始 CSV，关闭保草稿不发送，群未知回执沿原请求恢复',{timeout:60000},async()=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-dashboard-share-')),value=await dashboardShareFixture(55)
 const groupId='11111111-1111-4111-8111-111111111111',at=value.capturedAt
 const group={id:groupId,ownerId:'self',version:1,name:'客户业务协作群',scope:value.target.scope,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at,updatedAt:at}
 let readCalls=0
 const uploads:any[]=[],messages=new Map<string,any>(),sendCalls:any[]=[],unexpected:string[]=[]
 const server=createServer((request,response)=>{
  if(request.method==='GET'){response.setHeader('content-type','text/html');response.end('<!doctype html><html lang="zh-CN"><head></head><body><div id="root"></div></body></html>');return}
  const parts:Buffer[]=[];request.on('data',part=>parts.push(part));request.on('end',()=>{
   const input=JSON.parse(Buffer.concat(parts).toString()),reply=(value:unknown)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(value))}
   if(request.url==='/upload'){
    uploads.push(input);const bytes=Buffer.from(input.dataBase64,'base64'),png=input.mime==='image/png'
    assert.equal(input.groupId,groupId);assert.equal(input.expectedVersion,1)
    reply({ok:true,value:{attachment:{attachmentId:png?'22222222-2222-4222-8222-222222222222':'33333333-3333-4333-8333-333333333333',ownerId:'self',version:1,kind:png?'image':'file',mime:input.mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),name:input.name,width:png?1200:null,height:png?400:null,uploadedInGroupId:groupId,state:'active',createdAt:at,withdrawnAt:null}}});return
   }
   if(input.endpoint==='business-dashboards/share-snapshot'){readCalls++;assert.deepEqual(input.payload.target,value.target);reply(value);return}
   if(input.endpoint==='groups/list'){reply([group,{...group,id:'44444444-4444-4444-8444-444444444444',scope:'SOC',name:'别的业务群'}]);return}
   if(input.endpoint==='groups/get'){reply({group,members:[{groupId,roleId:null,createdAt:at}]});return}
   if(input.endpoint==='groups/messages/send'){
    sendCalls.push(input.payload);let message=messages.get(input.payload.requestId)
    if(!message){message={id:'55555555-5555-4555-8555-555555555555',groupId,rootId:null,authorId:'self',text:input.payload.text,references:input.payload.references,mentions:[],createdAt:at};messages.set(input.payload.requestId,message);response.writeHead(502);response.end('回包中断');return}
    reply(message);return
   }
   unexpected.push(input.endpoint);response.writeHead(500);response.end('unexpected')
  })
 })
 let browser:any,pageForFailure:any
 try{
  const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
import {DashboardShareProvider} from '${client}BusinessDashboardShare.tsx';import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';
import {createDashboardShareApi} from '${client}dashboard-share-api.ts';import {createGroupApi} from '${client}group-api.ts';import {createGroupAttachmentApi} from '${client}group-attachment-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.classList.add(tokens.tokens);document.body.style.margin='24px';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const call=async(endpoint,payload)=>{const response=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint,payload})});if(!response.ok)throw Error('HTTP '+response.status);return response.json()};let pending=null;
const groups=createGroupApi(call,{read:()=>pending,write:value=>{pending=value},clear:()=>{pending=null}});
const attachments=createGroupAttachmentApi(call,undefined,'self',(_url,init)=>fetch('/upload',init));
const value=${JSON.stringify(value)};window.shareFixture={groups};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><DashboardShareProvider services={{read:createDashboardShareApi(call),groups,attachments,namespace:'isolated-owner',scopeName:()=> '客户业务'}}><BusinessConfigurationPage projection={value.page.projection} colorScheme="light"/></DashboardShareProvider></I18nProvider>);`
  await writeFile(join(temp,'fixture.tsx'),entry)
  const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'DashboardShareFixture',formats:['iife']}}})
  const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port
  browser=await loadPlaywright().chromium.launch(launchOptions());const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors:string[]=[],remote:string[]=[]
  pageForFailure=page;page.setDefaultTimeout(10000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{if(route.request().url().startsWith(url+'/'))return route.continue();remote.push(route.request().url());return route.abort()})
  await page.goto(url);await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n')})
  const open=()=>page.getByRole('button',{name:'分享看板',exact:true}).click(),drawer=page.getByRole('dialog',{name:'分享看板'})
  await open();await drawer.getByRole('button',{name:'导出原始数据 CSV'}).waitFor();await drawer.getByLabel('发到业务协作群',{exact:true}).selectOption(groupId);await drawer.getByLabel('发送内容',{exact:true}).selectOption('both')
  assert.equal(await drawer.getByRole('option',{name:'别的业务群'}).count(),0)
  await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});assert.equal(uploads.length,0);assert.equal(messages.size,0)
  await open();await drawer.getByRole('button',{name:'导出原始数据 CSV'}).waitFor();assert.equal(await drawer.getByLabel('发到业务协作群',{exact:true}).inputValue(),groupId);assert.equal(await drawer.getByLabel('发送内容',{exact:true}).inputValue(),'both')
  const csvDownload=page.waitForEvent('download');await drawer.getByRole('button',{name:'导出原始数据 CSV'}).click();const csv=await readFile(await (await csvDownload).path())
  assert.equal(csv.subarray(0,3).toString('hex'),'efbbbf');const csvText=csv.toString();assert.match(csvText,/id-54/);assert.match(csvText,/9007199254740993\.0001/);assert.match(csvText,/'=原文,/);assert.match(csvText,new RegExp(value.snapshotHash));assert.match(csvText,/"all"/)
  const pngDownload=page.waitForEvent('download');await drawer.getByRole('button',{name:'导出图片 PNG'}).click();const png=await readFile(await (await pngDownload).path());assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),1200);assert.ok(png.readUInt32BE(20)>200)
  await drawer.getByRole('button',{name:'确认发送',exact:true}).click();await drawer.getByRole('button',{name:'核对并继续原发送'}).waitFor();assert.equal(messages.size,1);assert.equal(uploads.length,2)
  await drawer.getByRole('button',{name:'核对并继续原发送'}).click();await drawer.getByText('已发送到所选协作群。',{exact:true}).waitFor();assert.equal(messages.size,1);assert.equal(uploads.length,2);assert.equal(sendCalls.length,2);assert.deepEqual(sendCalls[0],sendCalls[1]);assert.equal(sendCalls[0].references.length,2);assert.match(sendCalls[0].text,new RegExp(value.snapshotHash))
  assert.deepEqual(Buffer.from(uploads.find(row=>row.mime==='text/csv').dataBase64,'base64'),csv);assert.deepEqual(Buffer.from(uploads.find(row=>row.mime==='image/png').dataBase64,'base64'),png)
  assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);assert.deepEqual(unexpected,[])
  const evidence=process.env.TELOA_DASHBOARD_SHARE_TEST_OUTPUT
  if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'dashboard-share.csv'),csv);await writeFile(join(evidence,'dashboard-share.png'),png);await page.screenshot({path:join(evidence,'drawer-sent.png'),fullPage:true});await writeFile(join(evidence,'browser-result.json'),JSON.stringify({source:'isolated service-generated fixture; no user instance or live model',target:value.target,snapshotHash:value.snapshotHash,rawRows:55,pngBytes:png.length,csvBytes:csv.length,pngWidth:png.readUInt32BE(16),pngHeight:png.readUInt32BE(20),uploadCount:uploads.length,sendCalls:sendCalls.length,messages:messages.size,errors,remote},null,2)+'\n')}
   const reread=page.waitForResponse((response:any)=>response.url().endsWith('/rpc')&&response.request().postDataJSON().endpoint==='business-dashboards/share-snapshot');await drawer.getByRole('button',{name:'重新读取快照'}).click();await reread;await drawer.getByRole('button',{name:'确认发送',exact:true}).waitFor();assert.equal(readCalls,2);assert.equal(messages.size,1);assert.equal(uploads.length,2);await page.mouse.click(20,500);await drawer.waitFor({state:'hidden'});assert.equal(messages.size,1)
 }catch(error){if(pageForFailure){console.error(await pageForFailure.locator('body').innerText());const output=process.env.TELOA_DASHBOARD_SHARE_TEST_OUTPUT;if(output)await pageForFailure.screenshot({path:join(output,'drawer-failed.png'),fullPage:true})}throw error}finally{await browser?.close();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(temp,{recursive:true,force:true})}
})
