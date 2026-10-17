import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as contract from '@teloa/contract'
import {buildSharePlan,sharePackageDigest,canonicalSharePackage} from '../src/client/share-package-plan.ts'

/** 契约 v2 读取器合入后，客户端内置的 v2 边界必须与契约逐字节一致；未合入时本用例跳过而不是假装通过。 */
const v2=(contract as unknown as {readTemplateShare?:(value:unknown)=>unknown;templateShareDigest:(value:unknown)=>Promise<string>;canonicalTemplateShare:(value:unknown)=>string})
const role=(id:string,name:string,skills:string[]=[])=>({id,name,kind:'employee' as const,duty:'Verify sources.',dataScope:'Provided documents.',executionScope:'Confirm external writes.',skills,knowledge:['k'],scopes:['general'],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:['Ask first.'],escalationRules:[],deliveryChecks:[]}})
const skillText='---\nname: research-notes\ndescription: Keep notes\n---\n# Notes'
const packages=()=>[
 buildSharePlan({publisher:'Max',license:'CC-BY-4.0',subject:'employee',roles:[role('a','Researcher',['research-notes','missing'])],skills:[{name:'research-notes',title:'Research notes',resourceId:'research-notes',version:'1.2.0',text:skillText,license:'MIT',publisher:'Upstream',sourceUrl:'https://example.org/skills'}],connections:[{serverName:'slack',title:'Slack',tools:['send_message']}]}),
 buildSharePlan({publisher:'Max',subject:'team',title:'Support team',roles:[role('a','Lead',['research-notes']),role('b','Agent')],coordinatorRoleId:'b',skills:[{name:'research-notes',title:'Research notes',resourceId:'research-notes',version:'1.0.0',text:skillText,license:'MIT'}],connections:[{serverName:'slack',title:'Slack',tools:['send_message']}],plugins:[{packageName:'@teloa/example-plugin',version:'1.0.0',title:'Example'}],bindings:[{roleId:'b',connections:['slack']}]}),
 buildSharePlan({publisher:'Max',subject:'skill',roles:[],skills:[{name:'official',title:'Official',resourceId:'official',version:'2.0.0',publicId:'official'}]}),
 buildSharePlan({publisher:'Max',subject:'mcp',roles:[],skills:[],connections:[{serverName:'notion',title:'Notion',tools:['search']}]}),
 buildSharePlan({publisher:'Max',subject:'app',roles:[],skills:[{name:'s',title:'S',resourceId:'s',version:'1.0.0',text:skillText,license:'MIT'}],connections:[{serverName:'notion',title:'Notion',tools:['search']}]}),
]

test('client-built v2 packages are accepted by the contract reader and share the same canonical bytes and digest',{skip:typeof v2.readTemplateShare!=='function'&&'contract v2 reader not merged'},async()=>{
 for(const pkg of packages()){
  assert.doesNotThrow(()=>v2.readTemplateShare!(pkg),pkg.subject)
  assert.equal(v2.canonicalTemplateShare(pkg),canonicalSharePackage(pkg),pkg.subject+' canonical bytes')
  assert.equal(await v2.templateShareDigest(pkg),await sharePackageDigest(pkg),pkg.subject+' digest')
 }
})
