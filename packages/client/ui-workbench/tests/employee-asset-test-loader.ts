import {registerHooks} from 'node:module'
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.webp')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.webp')?{format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}:next(url,context),
})
