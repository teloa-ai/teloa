export function marketSkillInstallationSelection(selected:string|null):string|null{
  if(!selected?.startsWith('skill:'))return null
  const installationId=selected.slice(6)
  return installationId&&installationId!=='directory'?installationId:null
}
