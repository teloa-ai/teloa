import test from 'node:test'
import assert from 'node:assert/strict'
import {leaseNativeFloatVisibility,NATIVE_DETAIL_ATTRIBUTE} from '../src/client/native-float-visibility.ts'
const body=()=>{const values=new Map<string,string>();return {getAttribute:(name:string)=>values.get(name)??null,setAttribute:(name:string,value:string)=>{values.set(name,value)},removeAttribute:(name:string)=>{values.delete(name)}}}
test('SSR 不访问 document；空宿主无副作用',()=>{assert.equal(typeof document,'undefined');leaseNativeFloatVisibility(undefined,false)()})
test('native 与非 native 标记切换后恢复原始属性',()=>{
 const node=body();node.setAttribute(NATIVE_DETAIL_ATTRIBUTE,'previous')
 const hidden=leaseNativeFloatVisibility(node,false)
 assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'hidden');hidden()
 assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'previous')
 const visible=leaseNativeFloatVisibility(node,true)
 assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'visible');visible()
 assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'previous')
})
test('多 root 按隐藏优先协调，旧 cleanup 不会清掉新 root 标记',()=>{
 const node=body(),first=leaseNativeFloatVisibility(node,true),second=leaseNativeFloatVisibility(node,false)
 assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'hidden')
 first();first();assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'hidden')
 const third=leaseNativeFloatVisibility(node,true)
 second();assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'visible')
 second();assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'visible')
 third();assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),null)
})
test('最后 cleanup 不覆盖其它持有者后来写入的标记',()=>{
 const node=body(),release=leaseNativeFloatVisibility(node,false)
 node.setAttribute(NATIVE_DETAIL_ATTRIBUTE,'external-owner');release()
 assert.equal(node.getAttribute(NATIVE_DETAIL_ATTRIBUTE),'external-owner')
})
