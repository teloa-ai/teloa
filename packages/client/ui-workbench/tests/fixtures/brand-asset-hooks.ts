import {registerHooks} from 'node:module'
import {readFileSync} from 'node:fs'
// tsc 声明产物不复制图片；组件测试仍读取真实品牌字节，模拟正式内联构建。
registerHooks({
 resolve(specifier,context,next){
  if(/\.(svg|webp)$/.test(specifier)&&context.parentURL?.includes('/ui-workbench/lib/types/')){
   return {url:new URL(specifier,context.parentURL).href.replace('/lib/types/brand/','/src/brand/'),shortCircuit:true}
  }
  return next(specifier,context)
 },
 load(url,context,next){
  if(url.includes('/ui-workbench/src/brand/resources/')&&/\.(svg|webp)$/.test(url)){
   const mime=url.endsWith('.svg')?'image/svg+xml':'image/webp'
   return {format:'module',shortCircuit:true,source:'export default '+JSON.stringify('data:'+mime+';base64,'+readFileSync(new URL(url)).toString('base64'))}
  }
  return next(url,context)
 },
})
