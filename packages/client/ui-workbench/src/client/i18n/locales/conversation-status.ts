type Values=readonly [string,string,string,string,string,string,string,string,string,string]
type Row<K extends string=string>=readonly [K,...Values]
const r=<K extends string>(key:K,...values:Values):Row<K>=>[key,...values]

export const CONVERSATION_STATUS_MESSAGE_ROWS=[
  r(
    'conversationStatus.capabilityScope',
    '按本会话核验',
    '依本次對話核驗',
    'Verified for this conversation',
    'この会話で確認済み',
    '이 대화에서 확인됨',
    'Đã xác minh trong cuộc trò chuyện này',
    'Verificado para esta conversación',
    'Vérifié pour cette conversation',
    'Für dieses Gespräch geprüft',
    'Verificado para esta conversa',
  ),
] as const
