import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const sourceRoot=new URL('../src/client/i18n/locales/',import.meta.url)

test('深层页面词条使用独立模块并由统一目录聚合',async()=>{
  const aggregate=await readFile(new URL('core-pages.ts',sourceRoot),'utf8')
  for(const [file,exportName] of [
    ['team-details.ts','TEAM_DETAIL_MESSAGE_ROWS'],
    ['task-details.ts','TASK_DETAIL_MESSAGE_ROWS'],
    ['continuous-details.ts','CONTINUOUS_DETAIL_MESSAGE_ROWS'],
    ['business-page.ts','BUSINESS_PAGE_MESSAGE_ROWS'],
    ['business-details.ts','BUSINESS_DETAILS_MESSAGE_ROWS'],
    ['project-workspace.ts','PROJECT_WORKSPACE_MESSAGE_ROWS'],
    ['artifact-panel.ts','ARTIFACT_PANEL_MESSAGE_ROWS'],
    ['conversation-dialog.ts','CONVERSATION_DIALOG_MESSAGE_ROWS'],
    ['approval-card.ts','APPROVAL_CARD_MESSAGE_ROWS'],
    ['knowledge-directory.ts','KNOWLEDGE_DIRECTORY_MESSAGE_ROWS'],
    ['knowledge-document.ts','KNOWLEDGE_DOCUMENT_MESSAGE_ROWS'],
    ['adopt-dialog.ts','ADOPT_DIALOG_MESSAGE_ROWS'],
    ['market-page.ts','MARKET_PAGE_MESSAGE_ROWS'],
    ['market-industry.ts','MARKET_INDUSTRY_MESSAGE_ROWS'],
    ['market-skill-controls.ts','MARKET_SKILL_CONTROL_MESSAGE_ROWS'],
    ['industry-update-preview.ts','INDUSTRY_UPDATE_PREVIEW_MESSAGE_ROWS'],
    ['workspace-settings.ts','WORKSPACE_SETTINGS_MESSAGE_ROWS'],
  ] as const){
    const moduleSource=await readFile(new URL(file,sourceRoot),'utf8')
    assert.match(moduleSource,new RegExp(`export const ${exportName}`),file)
    assert.match(aggregate,new RegExp(`import \\{${exportName}\\} from './${file.replace('.ts','.js')}'`),file)
    assert.match(aggregate,new RegExp(`\\.\\.\\.${exportName}`),file)
  }
})
