import {localizedMetadata,skillFrontmatterName,type LocalizedMetadata} from '@teloa/contract'
import { readIndustryFiles, type IndustryContent, type IndustryFileInput } from './industry-directory.ts'

export type AtomicSkillMetadata = {
  id: string
  title: string
  version: string
  categories: string[]
  localized?: {title?: LocalizedMetadata}
}

export type AtomicSkillContent = AtomicSkillMetadata & {
  hash: string
  entryPath: string
  files: IndustryContent['files']
  text: string
}

const digest = async (value: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  byte => byte.toString(16).padStart(2, '0'),
).join('')

export type AtomicSkillMetadataField='id'|'title'|'version'|'categories'
/** 元数据校验失败时标明实际字段，界面据此展开并指向对应输入；消息保持面向用户的中文说明。 */
export class AtomicSkillMetadataError extends Error{
  readonly field:AtomicSkillMetadataField
  constructor(message:string,field:AtomicSkillMetadataField){super(message);this.name='AtomicSkillMetadataError';this.field=field}
}

function requiredText(value: unknown, label: string, max: number, field: AtomicSkillMetadataField): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AtomicSkillMetadataError(label + '必须填写且不超过 ' + max + ' 字。', field)
  return value.trim()
}

export function validateAtomicSkillMetadata(metadata: AtomicSkillMetadata): AtomicSkillMetadata {
  const id = requiredText(metadata.id, '技能标识', 120, 'id')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id)) throw new AtomicSkillMetadataError('技能标识仅允许字母、数字和连字符。', 'id')
  const version = requiredText(metadata.version, '技能版本', 80, 'version')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new AtomicSkillMetadataError('技能版本必须是固定的三段版本号。', 'version')
  if (!Array.isArray(metadata.categories) || metadata.categories.length > 20) throw new AtomicSkillMetadataError('技能分类最多 20 项。', 'categories')
  const categories = metadata.categories.map(category => requiredText(category, '技能分类', 80, 'categories'))
  if (new Set(categories).size !== categories.length) throw new AtomicSkillMetadataError('技能分类不能重复。', 'categories')
  const title=requiredText(metadata.title, '技能名称', 120, 'title')
  let localized:AtomicSkillMetadata['localized']
  if(metadata.localized!==undefined){
    if(!metadata.localized||typeof metadata.localized!=='object'||Array.isArray(metadata.localized)||Object.keys(metadata.localized).some(key=>key!=='title'))throw new AtomicSkillMetadataError('技能本地化元数据格式不正确。', 'title')
    localized={}
    if(metadata.localized.title!==undefined){
      const value=localizedMetadata(metadata.localized.title)
      if(value.original!==title)throw new AtomicSkillMetadataError('本地化元数据的稳定原文必须与技能标题一致。', 'title')
      localized.title=value
    }
  }
  return { id, title, version, categories, ...(localized?{localized}:{}) }
}

/** 仅静态读取所选单一目录，保留每个文件的原字节；不执行目录内容。 */
async function readAtomicSkillDirectory(inputs:readonly IndustryFileInput[]){
  if (!inputs.length) throw Error('请选择仅含一个顶层 SKILL.md 的技能目录。')
  const files = await readIndustryFiles(inputs)
  const entryPaths = files.filter(file => file.path.split('/').at(-1) === 'SKILL.md').map(file => file.path)
  if (entryPaths.length !== 1) throw Error('请选择仅含一个顶层 SKILL.md 的技能目录。')
  const entryPath = entryPaths[0]!
  const root = entryPath.slice(0, entryPath.lastIndexOf('/') + 1)
  if (!files.every(file => file.path.startsWith(root))) throw Error('技能目录包含入口目录外的文件，请选择单一目录。')
  const entry = files.find(file => file.path === entryPath)!
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)
  } catch {
    throw Error('SKILL.md 不是有效 UTF-8 文本。')
  }
  if (!text.trim()) throw Error('SKILL.md 不能为空。')
  return {files,entryPath,text}
}

/** 标准名称沿契约层同一读取器带入；没有可信名称时保留原来的明确填写路径，不猜测版本或权限。 */
export async function suggestAtomicSkillMetadata(inputs:readonly IndustryFileInput[]):Promise<Pick<AtomicSkillMetadata,'id'|'title'>|undefined>{
  const {text}=await readAtomicSkillDirectory(inputs),name=skillFrontmatterName(text)
  return name&&name.length<=120&&/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)?{id:name,title:name}:undefined
}

export async function readAtomicSkill(inputs: readonly IndustryFileInput[], metadata: AtomicSkillMetadata): Promise<AtomicSkillContent> {
  const normalized = validateAtomicSkillMetadata(metadata)
  const {files,entryPath,text}=await readAtomicSkillDirectory(inputs)
  const hash = await digest(JSON.stringify({
    metadata: normalized,
    files: files.map(file => [file.path, file.hash]),
  }))
  return { ...normalized, hash, entryPath, files, text }
}
