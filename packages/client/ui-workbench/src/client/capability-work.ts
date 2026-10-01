import type { BindingFields, CapabilityBinding, CapabilityPreview } from './capability-preview.ts'

export type BindingForm = { bindingId: string; version: number; baseRevision: number; fields: BindingFields; note: string }
export type BindingForms = Record<string, BindingForm>
export const bindingFormKey = (id: string, version: number) => JSON.stringify([id, version])
export function editBindingForm(forms: BindingForms, binding: CapabilityBinding, version: number, patch: Partial<Pick<BindingForm, 'fields' | 'note'>>): BindingForms {
  if (binding.removed) throw Error('绑定已解除，不能继续编辑。')
  const source = binding.versions.find(row => row.version === version)
  if (!source) throw Error('配置版本不存在。')
  const key = bindingFormKey(binding.id, version), previous = forms[key]
  return { ...forms, [key]: { bindingId: binding.id, version, baseRevision: previous?.baseRevision ?? binding.revision, fields: { ...(patch.fields ?? previous?.fields ?? source.fields) }, note: patch.note ?? previous?.note ?? '' } }
}
export function rebaseBindingForm(forms: BindingForms, binding: CapabilityBinding, version: number): BindingForms {
  const next = editBindingForm(forms, binding, version, {}), key = bindingFormKey(binding.id, version)
  return { ...next, [key]: { ...next[key]!, baseRevision: binding.revision } }
}
export function clearBindingForm(forms: BindingForms, id: string, version: number): BindingForms {
  const next = { ...forms }
  delete next[bindingFormKey(id, version)]
  return next
}

export type BindingFailure = { id: string; bindingId: string; version: number; title: string; scope: string; target: string; message: string; at: string; active: boolean }
export function capabilityFailures(state: CapabilityPreview): BindingFailure[] {
  return state.bindings.filter(binding => !binding.removed).flatMap(binding => {
    const relevant = new Set([binding.activeVersion, binding.versions.at(-1)?.version])
    return binding.versions.filter(version => relevant.has(version.version) && version.check?.result === 'failed').map((version): BindingFailure => ({
      id: JSON.stringify(['binding-failure', binding.id, version.version]), bindingId: binding.id, version: version.version,
      title: binding.title, scope: binding.target.scope, target: binding.target.title, message: version.check!.note, at: version.check!.at, active: binding.activeVersion === version.version,
    }))
  }).sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
}
