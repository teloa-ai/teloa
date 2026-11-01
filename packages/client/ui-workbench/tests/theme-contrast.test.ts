import assert from 'node:assert/strict'
import test from 'node:test'
import {prototypeThemes} from '../src/brand/prototype-theme.ts'

function luminance(hex:string){
 const [r,g,b]=hex.slice(1).match(/../g)!.map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4)
 return r!*.2126+g!*.7152+b!*.0722
}
const contrast=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}

for(const [mode,palette] of Object.entries(prototypeThemes))test(`${mode} 主题正文/状态满足 4.5:1，交互边界满足 3:1`,()=>{
 const color=(role:string)=>palette['--teloa-design-'+role]!
 for(const [ink,surface] of [['text','surface'],['text','bg'],['muted','surface'],['muted','hover'],['on-primary','primary'],['accent','accent-bg'],['danger','danger-bg'],['good','good-bg'],['warn','warn-bg'],['info','info-bg']]){
  const ratio=contrast(color(ink!),color(surface!))
  assert.ok(ratio>=4.5,`${ink} / ${surface}: ${ratio}`)
 }
 for(const surface of ['surface','bg'])assert.ok(contrast(color('control-border'),color(surface))>=3,`输入边界 / ${surface}`)
})
