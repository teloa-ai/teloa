type Values=readonly [string,string,string,string,string,string,string,string,string,string]
type Row<K extends string=string>=readonly [K,...Values]
const r=<K extends string>(key:K,...values:Values):Row<K>=>[key,...values]

export const EXAMPLE_DIRECTORY_MESSAGE_ROWS=[
  r('team.sandbox.chatUnavailable','这是预览身份，保存为员工后才能开始会话。','這是預覽身分，儲存為員工後才能開始對話。','This is a preview identity. Save it as an employee to start a conversation.','これはプレビュー用の身分です。会話を始めるには従業員として保存してください。','미리보기 신원입니다. 대화를 시작하려면 직원으로 저장하세요.','Đây là danh tính xem trước. Hãy lưu thành nhân viên để bắt đầu cuộc trò chuyện.','Esta es una identidad de vista previa. Guárdala como empleado para iniciar una conversación.','Il s’agit d’une identité d’aperçu. Enregistrez-la comme employé pour démarrer une conversation.','Dies ist eine Vorschauidentität. Speichern Sie sie als Mitarbeiter, um ein Gespräch zu beginnen.','Esta é uma identidade de pré-visualização. Guarde-a como funcionário para iniciar uma conversa.'),
] as const
