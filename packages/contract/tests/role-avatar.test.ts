import assert from 'node:assert/strict'
import test from 'node:test'
import {roleDefinition} from '../src/roles.ts'
const fields={name:'Researcher',kind:'employee',scopes:['general'],duty:'Review sources',dataScope:'Selected materials',executionScope:'Draft only',skills:[],knowledge:[]}
test('员工头像选择在定义读写中保持同一标识，旧记录兼容且不允许任意图片',()=>{
 assert.equal(roleDefinition({...fields,avatarKey:'researcher'}).avatarKey,'researcher')
 assert.equal(roleDefinition(fields).avatarKey,undefined)
 assert.throws(()=>roleDefinition({...fields,avatarKey:'https://example.test/private.png'}))
})
test('自由组合头像：预设键与 bot:<形状>:<颜色> 同属合法取值，墨黑可选，未知形状拒绝，读写原样保留',async()=>{
 const {ROLE_AVATAR_KEYS,ROLE_AVATAR_SHAPES,ROLE_AVATAR_COLORS,ROLE_AVATAR_PRESETS,isRoleAvatarKey,isRoleAvatarCombination,roleAvatarParts,roleAvatarKeyOf}=await import('../src/roles.ts')
 const {readRoleProfile}=await import('../src/roles.ts')
 assert.equal(ROLE_AVATAR_KEYS.length,28,'旧白名单原样保留')
 assert.equal(ROLE_AVATAR_SHAPES.length*ROLE_AVATAR_COLORS.length,120)
 assert.equal((ROLE_AVATAR_COLORS as readonly string[]).includes('ink'),true,'最新在线稿的墨黑为合法员工色板')
 assert.deepEqual(Object.keys(ROLE_AVATAR_PRESETS).sort(),[...ROLE_AVATAR_KEYS].sort())
 assert.equal(new Set(Object.values(ROLE_AVATAR_PRESETS).map(parts=>parts.join(':'))).size,28,'预设外观互不重复')
 for(const [shape,color] of Object.values(ROLE_AVATAR_PRESETS))assert.ok(ROLE_AVATAR_SHAPES.includes(shape)&&ROLE_AVATAR_COLORS.includes(color))
 assert.deepEqual(ROLE_AVATAR_PRESETS.developer,['hexa','indigo'],'沿用设计稿对照表')
 for(const shape of ROLE_AVATAR_SHAPES)for(const color of ROLE_AVATAR_COLORS){
  const key=roleAvatarKeyOf(shape,color)
  assert.ok(isRoleAvatarKey(key),key);assert.deepEqual(roleAvatarParts(key),{shape,color})
  assert.equal(roleDefinition({...fields,avatarKey:`bot:${shape}:${color}`}).avatarKey,`bot:${shape}:${color}`,'契约不改写写入值')
 }
 assert.equal(roleAvatarKeyOf('bean','olive'),'researcher','等于预设的组合规范为旧键，旧版本也能读')
 assert.equal(roleAvatarKeyOf('ghost','amber'),'bot:ghost:amber')
 assert.equal(isRoleAvatarCombination('researcher'),false);assert.equal(isRoleAvatarCombination('bot:ghost:amber'),true)
 assert.deepEqual(readRoleProfile({name:'Ada',avatarKey:'bot:cloud:plum'}),{name:'Ada',avatarKey:'bot:cloud:plum'})
 for(const avatarKey of ['bot:star4:black','bot:star:teal','bot:circle','bot:circle:teal:x','BOT:circle:teal','bot:circle:#123456','bot::teal',' bot:circle:teal','https://example.test/a.png',''])
  {assert.equal(isRoleAvatarKey(avatarKey),false,avatarKey);assert.equal(roleAvatarParts(avatarKey),undefined);assert.throws(()=>roleDefinition({...fields,avatarKey}),/不合法/,avatarKey);assert.throws(()=>readRoleProfile({name:'Ada',avatarKey}),/不合法/,avatarKey)}
 for(const value of [null,1,{},['bot:circle:teal']])assert.equal(isRoleAvatarKey(value),false)
})
