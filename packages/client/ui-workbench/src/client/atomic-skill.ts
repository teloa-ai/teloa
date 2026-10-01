import {localizedMetadata,type LocalizedMetadata} from '@teloa/contract'
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

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(label + '必须填写且不超过 ' + max + ' 字。')
  return value.trim()
}

export function validateAtomicSkillMetadata(metadata: AtomicSkillMetadata): AtomicSkillMetadata {
  const id = requiredText(metadata.id, '技能标识', 120)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id)) throw Error('技能标识仅允许字母、数字和连字符。')
  const version = requiredText(metadata.version, '技能版本', 80)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw Error('技能版本必须是固定的三段版本号。')
  if (!Array.isArray(metadata.categories) || metadata.categories.length > 20) throw Error('技能分类最多 20 项。')
  const categories = metadata.categories.map(category => requiredText(category, '技能分类', 80))
  if (new Set(categories).size !== categories.length) throw Error('技能分类不能重复。')
  const title=requiredText(metadata.title, '技能名称', 120)
  let localized:AtomicSkillMetadata['localized']
  if(metadata.localized!==undefined){
    if(!metadata.localized||typeof metadata.localized!=='object'||Array.isArray(metadata.localized)||Object.keys(metadata.localized).some(key=>key!=='title'))throw Error('技能本地化元数据格式不正确。')
    localized={}
    if(metadata.localized.title!==undefined){
      const value=localizedMetadata(metadata.localized.title)
      if(value.original!==title)throw Error('本地化元数据的稳定原文必须与技能标题一致。')
      localized.title=value
    }
  }
  return { id, title, version, categories, ...(localized?{localized}:{}) }
}

/** 读取用户明确选择的单一 Skill 目录；不解析 front matter，也不执行目录文件。 */
export async function readAtomicSkill(inputs: readonly IndustryFileInput[], metadata: AtomicSkillMetadata): Promise<AtomicSkillContent> {
  const normalized = validateAtomicSkillMetadata(metadata)
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
  const hash = await digest(JSON.stringify({
    metadata: normalized,
    files: files.map(file => [file.path, file.hash]),
  }))
  return { ...normalized, hash, entryPath, files, text }
}
