// 群内直接回应与表情一期（2026-09-21 群内直接回应与表情一期 功能验证，T16 收口后为 13 条，
// 2026-09-21 作者与身份修复轮补 2 条后为 15 条）。
// 这 15 条覆盖三块：①`group.routing.*` 三条——群内直接回应接力时的等待提示、命名等待提示与
// 停下理由；②`group.reaction.*` 五条——表情回应条与选择浮层的界面文案；
// ③`collaboration.composer.*` 四条——输入框工具栏（表情/提及/引用/发送提示）；
// ④`role.conversation.*`——会话头部的岗位身份说明、重新介绍动作与发给当前岗位的短请求。
//   后两条是修复轮补的：T14 上线前建的岗位会话永远走复用支、补不到引导语，新建支的自动发送
//   失败当时也没有界面出口；这两件事共用头部那一行（失败落 alert，成功落 status）。
// 原先还有一条 `group.routing.stopped`（「我先停一下，等你确认再继续。」）：那句话由后端常量
// `groupRelayStopText`（`packages/backend/src/work/group-routing-text.ts`）直接写进群消息正文，
// 界面按普通消息正文原样呈现，客户端**没有任何消费面**，再 `t()` 一次只会造出第二个事实源。
// T16 按编排者裁定把这条词条连同 orphan 守卫里的临时白名单登记一并删除（YAGNI）；
// 代价：二期若要在话题面板单独渲染「停下」决策并本地化那句话，需要重新补键与逐字一致的断言。
// 12 个表情本身是 unicode 字面量常量（`packages/contract/src/group-reactions.ts` 的
// `groupReactionEmojis`），不进 i18n、不做翻译，因此这里没有「最多 12 种」一类的提示词条
// （`group.reaction.limit` 按计划 M7 明确不设：12 种既是上限也是全集，该提示不可触发）。
// 11 列：[key, zh-CN, zh-Hant, en, ja, ko, vi, es, fr, de, pt]。
export const GROUP_REACTION_MESSAGE_ROWS = [
 ['group.routing.pending','员工正在回复…','員工正在回覆…','A employee is replying…','従業員が返信しています…','직원이 답장하고 있습니다…','Nhân viên đang trả lời…','Un empleado está respondiendo…','Un employé est en train de répondre…','Eine Mitarbeiterin oder ein Mitarbeiter antwortet gerade…','Um funcionário está a responder…'],
 ['group.routing.pendingNamed','{name} 正在回复…','{name} 正在回覆…','{name} is replying…','{name} が返信しています…','{name} 님이 답장하고 있습니다…','{name} đang trả lời…','{name} está respondiendo…','{name} est en train de répondre…','{name} antwortet gerade…','{name} está a responder…'],
 ['group.routing.stoppedHint','员工之间已经连续接力 5 轮，中间没有你的发言。','員工之間已經連續接力 5 輪，中間沒有你的發言。','Employees have relayed 5 rounds in a row without a message from you in between.','従業員同士がすでに 5 ラウンド連続でリレーしており、その間あなたの発言はありません。','직원들이 이미 5라운드 연속으로 릴레이했으며, 그 사이 당신의 발언은 없었습니다.','Các nhân viên đã tiếp sức liên tục 5 vòng mà không có phát biểu nào của bạn ở giữa.','Los empleados ya se han pasado la palabra 5 rondas seguidas sin ningún mensaje tuyo entre medias.','Les employés se sont relayés 5 tours d’affilée sans aucun message de votre part entre-temps.','Mitarbeitende haben sich bereits 5 Runden in Folge abgewechselt, ohne dass du dazwischen etwas gesagt hast.','Os funcionários já se revezaram 5 rondas seguidas sem nenhuma mensagem sua pelo meio.'],
 ['group.reaction.add','加表情','加表情','Add reaction','リアクションを追加','반응 추가','Thêm biểu cảm','Añadir reacción','Ajouter une réaction','Reaktion hinzufügen','Adicionar reação'],
 ['group.reaction.pick','选一个表情','選一個表情','Choose a reaction','リアクションを選ぶ','반응 선택','Chọn một biểu cảm','Elegir una reacción','Choisir une réaction','Reaktion auswählen','Escolher uma reação'],
 ['group.reaction.mine','你也加了这个','你也加了這個','You reacted with this too','あなたもこれを付けています','당신도 이 반응을 남겼습니다','Bạn cũng đã thêm biểu cảm này','Tú también reaccionaste con esto','Vous avez aussi ajouté cette réaction','Auch du hast das hinzugefügt','Você também adicionou esta reação'],
 ['group.reaction.by','{names}','{names}','{names}','{names}','{names}','{names}','{names}','{names}','{names}','{names}'],
 ['group.reaction.failed','表情没加上，请再试一次。','表情沒加上，請再試一次。','The reaction didn’t go through; please try again.','リアクションを追加できませんでした。もう一度お試しください。','반응을 추가하지 못했습니다. 다시 시도해 주세요.','Chưa thêm được biểu cảm, vui lòng thử lại.','No se pudo añadir la reacción; inténtalo de nuevo.','La réaction n’a pas été ajoutée ; veuillez réessayer.','Die Reaktion konnte nicht hinzugefügt werden; bitte versuche es erneut.','Não foi possível adicionar a reação; tente novamente.'],
 ['collaboration.composer.emoji','插入表情','插入表情','Insert emoji','絵文字を挿入','이모지 삽입','Chèn biểu tượng cảm xúc','Insertar emoji','Insérer un emoji','Emoji einfügen','Inserir emoji'],
 ['collaboration.composer.mention','提及员工','提及員工','Mention an employee','従業員をメンション','직원 멘션','Nhắc đến nhân viên','Mencionar a un empleado','Mentionner un employé','Mitarbeiter erwähnen','Mencionar um funcionário'],
 ['collaboration.composer.references','引用资料','引用資料','Reference materials','資料を引用','자료 인용','Tham chiếu tài liệu','Referenciar materiales','Référencer des documents','Material referenzieren','Referenciar materiais'],
 ['collaboration.composer.enterHint','回车发送，Shift+回车换行','按 Enter 傳送，Shift+Enter 換行','Press Enter to send, Shift+Enter for a new line','Enter で送信、Shift+Enter で改行','Enter로 전송, Shift+Enter로 줄바꿈','Nhấn Enter để gửi, Shift+Enter để xuống dòng','Pulsa Enter para enviar, Shift+Enter para nueva línea','Appuyez sur Entrée pour envoyer, Maj+Entrée pour un retour à la ligne','Eingabetaste zum Senden, Umschalt+Eingabetaste für einen Zeilenumbruch','Prima Enter para enviar, Shift+Enter para nova linha'],
 ['role.conversation.identity','这条对话里，它以「{name}」的岗位身份回答。','這段對話裡，它以「{name}」的職位身份回答。','In this conversation, it answers in the role of “{name}.”','この会話では、「{name}」という職務の立場で回答します。','이 대화에서는 "{name}" 직무 신분으로 답변합니다.','Trong cuộc trò chuyện này, nó trả lời với tư cách vai trò "{name}".','En esta conversación, responde con el rol de "{name}".','Dans cette conversation, il répond avec le rôle de « {name} ».','In diesem Gespräch antwortet es in der Rolle „{name}“.','Nesta conversa, ele responde no papel de "{name}".'],
 ['role.conversation.reintroduce','让它重新自我介绍','讓它重新自我介紹','Ask it to introduce itself again','もう一度自己紹介してもらう','다시 자기소개를 요청','Yêu cầu nó tự giới thiệu lại','Pedirle que se presente de nuevo','Lui demander de se présenter à nouveau','Es bitten, sich noch einmal vorzustellen','Pedir-lhe que se apresente de novo'],
 ['role.conversation.reintroduced','已让它重新自我介绍。','已讓它重新自我介紹。','It has been asked to introduce itself again.','もう一度自己紹介するよう伝えました。','다시 자기소개를 요청했습니다.','Đã yêu cầu nó tự giới thiệu lại.','Se le ha pedido que se presente de nuevo.','Il lui a été demandé de se présenter à nouveau.','Es wurde gebeten, sich noch einmal vorzustellen.','Pediu-se-lhe que se apresentasse de novo.'],
 ['role.conversation.introducePrompt','请简要介绍你当前的岗位职责与边界。','請簡要介紹你目前的職位職責與界限。','Please briefly describe your current role’s responsibilities and boundaries.','現在の職務とその範囲を簡潔に説明してください。','현재 직무의 책임과 범위를 간단히 소개해 주세요.','Hãy giới thiệu ngắn gọn trách nhiệm và giới hạn của vai trò hiện tại của bạn.','Describe brevemente las responsabilidades y los límites de tu función actual.','Décris brièvement les responsabilités et les limites de ton rôle actuel.','Beschreibe kurz die Aufgaben und Grenzen deiner aktuellen Rolle.','Descreve brevemente as responsabilidades e os limites da tua função atual.'],
  ["role.conversation.details", "会话身份", "會話身分", "Conversation identity", "会話の役割", "대화 신원", "Danh tính cuộc trò chuyện", "Identidad de la conversación", "Identité de la conversation", "Gesprächsidentität", "Identidade da conversa"],
  ["role.conversation.close", "关闭身份说明", "關閉身分說明", "Close identity details", "役割の詳細を閉じる", "신원 정보 닫기", "Đóng thông tin danh tính", "Cerrar detalles de identidad", "Fermer les détails d’identité", "Identitätsdetails schließen", "Fechar detalhes da identidade"],
 ['collaboration.message.sourceDetails','执行来源','執行來源','Execution source','実行元','실행 출처','Nguồn thực thi','Origen de ejecución','Source d’exécution','Ausführungsquelle','Origem da execução'],
] as const
