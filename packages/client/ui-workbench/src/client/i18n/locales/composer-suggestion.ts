/** 输入框「下一条建议」设置项：先定稿简繁英，其余语言回退英文，不在开发中反复补译。 */
const rows = [
 ['title','显示下一条建议','顯示下一條建議','Show next-step suggestions'],
 ['detail','助手回复后，在空输入框里用灰字给出下一步建议。按 Tab 才放入草稿，不会自动发送。','助手回覆後，在空白輸入框以灰字給出下一步建議。按 Tab 才放入草稿，不會自動傳送。','After a reply, show a grey next-step suggestion in the empty composer. Pressing Tab puts it in the draft; it is never sent automatically.'],
 ['aria','建议的下一步：{text}。按 Tab 放入输入框（不会自动发送），继续输入即丢弃。','建議的下一步：{text}。按 Tab 放入草稿（不會自動傳送），繼續輸入即丟棄。','Suggested next step: {text}. Press Tab to put it into the draft; it is never sent automatically.'],
] as const
export type ComposerSuggestionMessageKey=`composerSuggestion.${typeof rows[number][0]}`
export const COMPOSER_SUGGESTION_MESSAGE_KEYS=rows.map(row=>`composerSuggestion.${row[0]}` as ComposerSuggestionMessageKey)
const column=(index:1|2|3)=>Object.fromEntries(rows.map(row=>[`composerSuggestion.${row[0]}`,row[index]])) as Readonly<Record<ComposerSuggestionMessageKey,string>>
export const composerSuggestionMessages={'zh-CN':column(1),'zh-Hant':column(2),en:column(3)}
