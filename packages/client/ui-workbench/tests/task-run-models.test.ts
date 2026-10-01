import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import {ROLE_MODELS_MESSAGE_ROWS} from '../src/client/i18n/locales/role-models.ts'
const dictionary=new Map(ROLE_MODELS_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
const page=mount('TaskRunModels.tsx',{'./i18n/provider.js':{useI18n:()=>({t:(key:string,values:Record<string,string>={})=>Object.entries(values).reduce((text,[key,value])=>text.replace('{'+key+'}',value),dictionary.get(key)??key)})}})
const policy={primary:{provider:'local',model:'small'},fallback:{provider:'remote',model:'large'}}
const text=(run:object,planned=false)=>nodes(page.render('TaskRunModels',{run,planned})).flatMap(node=>node.children.filter(child=>typeof child==='string')).join(' ')
test('准备配置与真实请求分开呈现，无证据不会冒充已用模型',()=>{
 assert.equal(text({}),'')
 assert.equal(text({modelPolicy:policy,modelStatus:{state:'unobserved'}}),'尚无模型请求记录')
 assert.equal(text({modelPolicy:policy}),'模型请求记录暂不可用')
 const planned=text({modelPolicy:policy},true)
 assert.match(planned,/首选模型.*small.*远程备用模型.*large/)
 assert.doesNotMatch(planned,/请求模型/)
})
test('模型变化和原因可见，未渲染内部请求编号或原始异常',()=>{
 const content=text({modelPolicy:policy,modelStatus:{state:'observed',model:{...policy.fallback,reasoningEffort:'high'},requestSeq:987654,recovery:{from:policy.primary,to:policy.fallback,reason:'TIMEOUT'}}})
 assert.match(content,/请求模型：large · remote · high/)
 assert.match(content,/已从 small 切换到 large · 请求超时/)
 assert.doesNotMatch(content,/987654|TIMEOUT/)
})
