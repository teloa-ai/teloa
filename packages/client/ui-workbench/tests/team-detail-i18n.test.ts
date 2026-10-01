import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import ts from 'typescript'

const clientRoot = new URL('../src/client/', import.meta.url)
const localeRoot = new URL('../src/client/i18n/locales/', import.meta.url)

test('岗位详情到文件末尾的固定 UI 中文全部经词典呈现', async () => {
  const source = await readFile(new URL('TeamPage.tsx', clientRoot), 'utf8')
  assert.deepEqual(chineseUiLiterals(source.slice(source.indexOf('function RoleDetail')),'TeamPage.tsx',(value,node)=>node.parent.kind===ts.SyntaxKind.PropertyAssignment&&['业务范围','执行范围'].includes(value)), [])
})

test('岗位深层词典为十种主语言提供不同的代表性翻译', async () => {
  const source = await readFile(new URL('team-details.ts', localeRoot), 'utf8')
  const file = ts.createSourceFile('team-details.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const rows = new Map<string, string[]>()
  const visit = (node: ts.Node) => {
    const first = ts.isArrayLiteralExpression(node) ? node.elements[0] : undefined
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 11 && first !== undefined && ts.isStringLiteral(first)) {
      const row = node.elements.map(item => ts.isStringLiteral(item) ? item.text : '')
      rows.set(first.text, row)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.deepEqual(rows.get('team.detail.identity.status'), [
    'team.detail.identity.status', "员工身份与当前状态", "員工身分與目前狀態", "Employee identity and current status",
    "従業員の識別情報と現在の状態", "직원 신원 및 현재 상태", "Danh tính nhân viên và trạng thái hiện tại",
    "Identidad del empleado y estado actual", "Identité du employé et état actuel", "Identität und aktueller Status des Mitarbeiters", "Identidade do funcionário e estado atual",
  ])
  assert.deepEqual(rows.get('team.form.memory.candidateBody'), [
    'team.form.memory.candidateBody', '候选正文（Markdown）', '候選正文（Markdown）', 'Candidate content (Markdown)',
    '候補本文（Markdown）', '후보 본문(Markdown)', 'Nội dung đề xuất (Markdown)',
    'Contenido candidato (Markdown)', 'Contenu proposé (Markdown)', 'Vorgeschlagener Inhalt (Markdown)', 'Conteúdo candidato (Markdown)',
  ])
  assert.ok([...rows.values()].every(row => row.length === 11 && row.slice(1).every(Boolean)))
})
