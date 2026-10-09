import {BUSINESS_DAILY_MESSAGE_ROWS} from './business-daily.js'
import {BUSINESS_CONFIGURATION_MESSAGE_ROWS} from './business-configuration.js'
import {BUSINESS_BUILDER_MESSAGE_ROWS} from './business-builder.js'
import {BUSINESS_RECORD_MESSAGE_ROWS} from './business-records.js'
import {SESSION_BROWSER_STOP_MESSAGE_ROWS} from './session-browser-stop.js'
import {LOCAL_RETRIEVAL_MESSAGE_ROWS} from './local-retrieval.js'
import {ROLE_MODELS_MESSAGE_ROWS} from './role-models.js'
import {LOCAL_MODELS_MESSAGE_ROWS} from './local-models.js'
import {EXTENSION_MANAGEMENT_MESSAGE_ROWS} from './extension-management.js'
import {TELOA_FEEDBACK_MESSAGE_ROWS} from './teloa-feedback.js'
import {TEAM_DETAIL_MESSAGE_ROWS} from './team-details.js'
import {TASK_DETAIL_MESSAGE_ROWS} from './task-details.js'
import {CONTINUOUS_DETAIL_MESSAGE_ROWS} from './continuous-details.js'
import {BUSINESS_PAGE_MESSAGE_ROWS} from './business-page.js'
import {BUSINESS_DETAILS_MESSAGE_ROWS} from './business-details.js'
import {PROJECT_WORKSPACE_MESSAGE_ROWS} from './project-workspace.js'
import {ARTIFACT_PANEL_MESSAGE_ROWS} from './artifact-panel.js'
import {CONVERSATION_DIALOG_MESSAGE_ROWS} from './conversation-dialog.js'
import {APPROVAL_CARD_MESSAGE_ROWS} from './approval-card.js'
import {KNOWLEDGE_DIRECTORY_MESSAGE_ROWS} from './knowledge-directory.js'
import {KNOWLEDGE_DOCUMENT_MESSAGE_ROWS} from './knowledge-document.js'
import {ADOPT_DIALOG_MESSAGE_ROWS} from './adopt-dialog.js'
import {MARKET_PAGE_MESSAGE_ROWS} from './market-page.js'
import {MARKET_INDUSTRY_MESSAGE_ROWS} from './market-industry.js'
import {MARKET_SOLUTION_MESSAGE_ROWS} from './market-solution.js'
import {INDUSTRY_COMPOSITION_MESSAGE_ROWS} from './industry-composition.js'
import {MARKET_SKILL_CONTROL_MESSAGE_ROWS} from './market-skill-controls.js'
import {MARKET_INSTALLATION_MESSAGE_ROWS} from './market-installations.js'
import {MARKET_FORM_MESSAGE_ROWS} from './market-forms.js'
import {MARKET_CATALOG_MESSAGE_ROWS} from './market-catalog.js'
import {CONNECTOR_MESSAGE_ROWS} from './connectors.js'
import {WORKSPACE_SETTINGS_MESSAGE_ROWS} from './workspace-settings.js'
import {COLLABORATION_MESSAGE_ROWS} from './collaboration.js'
import {CAPABILITY_BINDINGS_MESSAGE_ROWS} from './capability-bindings.js'
import {WORK_DIRECTORY_MESSAGE_ROWS} from './work-directory.js'
import {TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS} from './team-capability-catalog.js'
import {WORKSPACE_SEARCH_MESSAGE_ROWS} from './workspace-search.js'
import {CONVERSATION_STATUS_MESSAGE_ROWS} from './conversation-status.js'
import {EXAMPLE_DIRECTORY_MESSAGE_ROWS} from './example-directories.js'
import {FORMAL_UI_RESIDUAL_MESSAGE_ROWS} from './formal-ui-residual.js'
import {BUSINESS_FORM_MESSAGE_ROWS} from './business-forms.js'
import {ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS} from './artifact-knowledge-secondary.js'
import {HOME_SECONDARY_MESSAGE_ROWS} from './home-secondary.js'
import {FORMAL_UI_P5_MESSAGE_ROWS} from './formal-ui-p5.js'
import {FORMAL_UI_P6_MESSAGE_ROWS} from './formal-ui-p6.js'
import {PRESENTATION_HELPER_MESSAGE_ROWS} from './presentation-helpers.js'
import {PRESENTATION_SECONDARY_MESSAGE_ROWS} from './presentation-secondary.js'
import {INDUSTRY_UPDATE_PREVIEW_MESSAGE_ROWS} from './industry-update-preview.js'
import {EDITION_MESSAGE_ROWS} from './edition.js'
import {ATTENTION_DECISION_MESSAGE_ROWS} from './attention-decision.js'
import {SECURITY_RECOVERY_MESSAGE_ROWS} from './security-recovery.js'
import {RECOVERY_DISCARD_MESSAGE_ROWS} from './recovery-discard.js'
import {BUSINESS_DEFINITION_MESSAGE_ROWS} from './business-definitions.js'
import {BUSINESS_CUSTOMIZATION_MESSAGE_ROWS} from './business-customization.js'
import {BUSINESS_DASHBOARD_MESSAGE_ROWS} from './business-dashboards.js'
import {PAGE_CREATE_MESSAGE_ROWS} from './page-create.js'
import {BUSINESS_SHARE_MESSAGE_ROWS} from './business-share.js'
import {BUSINESS_SHORTCUT_MESSAGE_ROWS} from './business-shortcuts.js'
import {SUBAGENT_DELEGATION_MESSAGE_ROWS} from './subagent-delegation.js'
import {ABOUT_PLAN_MESSAGE_ROWS} from './about-plans.js'
import {MARKET_SAVED_RESTORED_ROWS} from './market-saved-restored.js'
import {MARKET_SKILL_UPGRADE_RESTORED_ROWS} from './market-skill-upgrade-restored.js'
import {AUTO_DREAM_MESSAGE_ROWS} from './auto-dream.js'
import {GROUP_MENTION_MESSAGE_ROWS} from './group-mention.js'
import {GROUP_ATTACHMENT_MESSAGE_ROWS} from './group-attachment.js'
import {GROUP_REACTION_MESSAGE_ROWS} from './group-reaction.js'
import {WEB_ACCESS_MESSAGE_ROWS} from './web-access.js'
import {MARKET_TAXONOMY_MESSAGE_ROWS} from './market-taxonomy.js'
import {IM_CHANNELS_MESSAGE_ROWS} from './im-channels.js'
import {CREDENTIAL_STORE_MESSAGE_ROWS} from './credential-store.js'
import {BUNDLED_EXTENSIONS_MESSAGE_ROWS} from './bundled-extensions.js'
import {APPLICATION_CAPABILITY_MESSAGE_ROWS} from './application-capabilities.js'

/**
 * 聚合词表只需保证每行完整覆盖十种产品语言。显式行类型避免持续追加词表时让声明产物展开成
 * 数千项字面量联合；各专题词表仍保留自己的精确键集并由静态词表测试核对接线。
 */
type CorePageMessageRow=readonly [string,string,string,string,string,string,string,string,string,string,string]

export const CORE_PAGE_MESSAGE_ROWS:readonly CorePageMessageRow[] = [
  ...APPLICATION_CAPABILITY_MESSAGE_ROWS,
  ...BUSINESS_CONFIGURATION_MESSAGE_ROWS,
  ...BUSINESS_DAILY_MESSAGE_ROWS,
  ...BUSINESS_RECORD_MESSAGE_ROWS,
  ...BUSINESS_BUILDER_MESSAGE_ROWS,
  ...TELOA_FEEDBACK_MESSAGE_ROWS,
  ...LOCAL_MODELS_MESSAGE_ROWS,
 ...ROLE_MODELS_MESSAGE_ROWS,
  ...EXTENSION_MANAGEMENT_MESSAGE_ROWS,
  ...LOCAL_RETRIEVAL_MESSAGE_ROWS,
  ['navigation.v2.attention','需要你','需要你','Needs your decision','判断が必要','결정이 필요함','Cần bạn quyết định','Necesita tu decisión','Votre décision','Ihre Entscheidung','Precisa da sua decisão'],
  ['navigation.v2.colleagues','员工','員工','Employees','従業員','직원','Nhân viên','Empleados','Employés','Mitarbeitende','Funcionários'],
  ['navigation.v2.conversations','对话','對話','Conversations','会話','대화','Trò chuyện','Conversaciones','Discussions','Unterhaltungen','Conversas'],
  ['navigation.v2.business','业务','業務','Business','業務','업무','Nghiệp vụ','Negocio','Activité','Geschäft','Negócio'],
  ['navigation.v2.library','资料','資料','Library','資料','자료','Tài liệu','Biblioteca','Bibliothèque','Bibliothek','Biblioteca'],
  ['navigation.v2.settings','设置','設定','Settings','設定','설정','Cài đặt','Ajustes','Réglages','Einstellungen','Definições'],
  ['navigation.group.team','团队与业务','團隊與業務','Team and business','チームと業務','팀과 업무','Nhóm và nghiệp vụ','Equipo y negocio','Équipe et activité','Team und Geschäft','Equipe e negócios'],
  ['navigation.group.resources','资源','資源','Resources','リソース','리소스','Tài nguyên','Recursos','Ressources','Ressourcen','Recursos'],
  ['continuous.v2.title','自动化','自動化','Automations','自動化','자동화','Tự động hóa','Automatizaciones','Automatisations','Automatisierungen','Automações'],
  ['continuous.empty.automation','还没有自动化','還沒有自動化','No automations yet','自動化はまだありません','아직 자동화가 없습니다','Chưa có tự động hóa','Aún no hay automatizaciones','Aucune automatisation pour le moment','Noch keine Automatisierungen','Ainda não há automações'],
  ['continuous.empty.setup','新建自动化，设置执行时间、负责人和工作目标。','新增自動化，設定執行時間、負責人和工作目標。','Create an automation and choose its schedule, owner, and goal.','自動化を作成し、実行日時、担当者、目標を設定します。','자동화를 만들고 일정, 담당자, 목표를 설정하세요.','Tạo tự động hóa và chọn lịch chạy, người phụ trách và mục tiêu.','Crea una automatización y define su horario, responsable y objetivo.','Créez une automatisation et définissez son calendrier, son responsable et son objectif.','Erstellen Sie eine Automatisierung mit Zeitplan, Verantwortlichem und Ziel.','Crie uma automação e defina o horário, responsável e objetivo.'],
  ['continuous.empty.noMatch','没有匹配的结果','沒有符合的結果','No matching results','一致する結果はありません','일치하는 결과가 없습니다','Không có kết quả phù hợp','No hay resultados coincidentes','Aucun résultat correspondant','Keine passenden Ergebnisse','Nenhum resultado correspondente'],
  ['continuous.empty.changeFilters','调整搜索词或筛选条件，查看其他结果。','調整搜尋詞或篩選條件，查看其他結果。','Try another search or adjust the filters.','検索語や絞り込み条件を変更してください。','검색어나 필터를 변경해 보세요.','Thử từ khóa khác hoặc điều chỉnh bộ lọc.','Prueba otra búsqueda o ajusta los filtros.','Essayez une autre recherche ou ajustez les filtres.','Versuchen Sie einen anderen Suchbegriff oder passen Sie die Filter an.','Tente outra pesquisa ou ajuste os filtros.'],
  ['continuous.v2.description','按时间或事件执行。每次执行会创建任务并记录结果；结果需要继续处理时，可创建跟进任务。','按時間或事件執行。每次執行會建立任務並記錄結果；結果需要繼續處理時，可建立跟進任務。','Run on a schedule or event. Each run creates a task and records its result; follow-up tasks can continue work on the result.','日時やイベントに応じて実行します。毎回タスクを作成して結果を記録し、必要に応じてフォローアップのタスクで処理を続けられます。','시간이나 이벤트에 따라 실행합니다. 매 실행마다 작업을 만들고 결과를 기록하며, 추가 처리가 필요하면 후속 작업을 만들 수 있습니다.','Chạy theo lịch hoặc sự kiện. Mỗi lần chạy tạo một nhiệm vụ và lưu kết quả; có thể tạo nhiệm vụ tiếp nối để xử lý kết quả.','Se ejecuta por horario o evento. Cada ejecución crea una tarea y registra el resultado; las tareas de seguimiento pueden continuar su tratamiento.','Exécution selon un horaire ou un événement. Chaque exécution crée une tâche et enregistre son résultat ; des tâches de suivi peuvent poursuivre le traitement.','Ausführung nach Zeitplan oder Ereignis. Jeder Lauf erstellt eine Aufgabe und speichert das Ergebnis; Folgeaufgaben können die Bearbeitung fortsetzen.','Execução por horário ou evento. Cada execução cria uma tarefa e regista o resultado; tarefas de seguimento podem continuar o tratamento.'],
  ['attention.v2.description','查看待审批、待补充资料和待核对的事项，并决定下一步处理。','查看待審批、待補充資料和待核對的事項，並決定下一步處理。','Review items awaiting approval, materials, or verification and decide what to do next.','承認、資料追加、確認が必要な項目を確認し、次の対応を決めます。','승인, 자료 보완 또는 확인이 필요한 항목을 보고 다음 조치를 결정하세요.','Xem các mục chờ phê duyệt, bổ sung tài liệu hoặc xác minh và quyết định bước xử lý tiếp theo.','Revisa los elementos pendientes de aprobación, documentos o verificación y decide el siguiente paso.','Consultez les éléments en attente d’approbation, de documents ou de vérification et décidez de la suite.','Prüfen Sie Einträge, die auf Freigabe, Unterlagen oder Prüfung warten, und entscheiden Sie über den nächsten Schritt.','Reveja os itens que aguardam aprovação, documentos ou verificação e decida o próximo passo.'],
  ['attention.v2.filter','按类型查看','按類型查看','View by type','種類で表示','유형별 보기','Xem theo loại','Ver por tipo','Afficher par type','Nach Typ anzeigen','Ver por tipo'],
  ['attention.v2.eyebrow','待处理事项','待處理事項','Pending items','対応待ちの項目','처리 대기 항목','Mục cần xử lý','Elementos pendientes','Éléments à traiter','Offene Einträge','Itens pendentes'],
  ['attention.v2.count','{count} 项','{count} 項','{count} items','{count} 件','{count}개','{count} mục','{count} elementos','{count} éléments','{count} Punkte','{count} itens'],
  ['attention.v2.search','搜索名称、对象编号或产物','搜尋名稱、物件編號或產物','Search names, object IDs, or outputs','名前、対象ID、または成果物を検索','이름, 객체 ID 또는 결과물 검색','Tìm theo tên, mã đối tượng hoặc kết quả','Busca nombres, ID de objeto o resultados','Recherchez un nom, un identifiant ou un résultat','Namen, Objekt-IDs oder Ergebnisse suchen','Pesquise nomes, IDs de objetos ou resultados'],
  ['attention.partial','部分待办暂时无法加载，列表可能不完整。请重试。','部分待辦暫時無法載入，清單可能不完整。請重試。','Some pending items could not be loaded. The list may be incomplete. Please retry.','一部の対応事項を読み込めませんでした。一覧が不完全な可能性があります。再試行してください。','일부 할 일을 불러올 수 없어 목록이 불완전할 수 있습니다. 다시 시도하세요.','Không tải được một số mục cần xử lý. Danh sách có thể chưa đầy đủ. Hãy thử lại.','No se pudieron cargar algunos pendientes. La lista puede estar incompleta. Vuelve a intentarlo.','Certains éléments à traiter n’ont pas pu être chargés. La liste peut être incomplète. Réessayez.','Einige offene Einträge konnten nicht geladen werden. Die Liste ist möglicherweise unvollständig. Versuchen Sie es erneut.','Não foi possível carregar alguns itens pendentes. A lista pode estar incompleta. Tente novamente.'],
  ['attention.partial.retry','重试','重試','Retry','再試行','다시 시도','Thử lại','Reintentar','Réessayer','Erneut versuchen','Tentar novamente'],
  ['attention.count.partial','至少 {count} 项','至少 {count} 項','At least {count} items','少なくとも{count}件','최소 {count}개','Ít nhất {count} mục','Al menos {count} elementos','Au moins {count} éléments','Mindestens {count} Punkte','Pelo menos {count} itens'],
  ['attention.empty.none','没有需要你处理的事项','沒有需要你處理的事項','Nothing needs your action','対応が必要な項目はありません','처리할 항목이 없습니다','Không có mục nào cần bạn xử lý','No hay nada que requiera tu acción','Aucun élément ne nécessite votre intervention','Nichts erfordert Ihre Aktion','Nada precisa da sua ação'],
  ['attention.empty.description','有需要你决定、补充或核对的事项时，会出现在这里。','有需要你決定、補充或核對的事項時，會顯示在這裡。','Items that need your decision, input, or review will appear here.','判断、補足、確認が必要な項目はここに表示されます。','결정, 보완 또는 확인이 필요한 항목이 여기에 표시됩니다.','Các mục cần bạn quyết định, bổ sung hoặc kiểm tra sẽ xuất hiện tại đây.','Aquí aparecerán los elementos que necesiten tu decisión, aportación o revisión.','Les éléments nécessitant votre décision, un complément ou une vérification apparaîtront ici.','Punkte, die Ihre Entscheidung, Ergänzung oder Prüfung benötigen, erscheinen hier.','Os itens que precisarem da sua decisão, informação ou revisão aparecerão aqui.'],
  ['task.empty.description','交办第一项任务，目标、负责人和进度会保留在这里。','交辦第一項任務，目標、負責人和進度會保留在這裡。','Assign the first task. Its goal, owner, and progress will stay here.','最初のタスクを依頼すると、目標・担当者・進捗がここに保存されます。','첫 작업을 맡기면 목표, 담당자, 진행 상황이 여기에 보관됩니다.','Giao nhiệm vụ đầu tiên; mục tiêu, người phụ trách và tiến độ sẽ được lưu tại đây.','Asigna la primera tarea; aquí se guardarán su objetivo, responsable y progreso.','Confiez la première tâche ; son objectif, son responsable et son avancement resteront ici.','Weisen Sie die erste Aufgabe zu; Ziel, Verantwortliche und Fortschritt bleiben hier erhalten.','Atribua a primeira tarefa; o objetivo, responsável e progresso ficarão aqui.'],
  ['task.empty.noMatchDescription','调整搜索词或业务范围，查看其他任务。','調整搜尋詞或業務範圍，查看其他任務。','Try another search or business scope.','検索語や業務範囲を変更してください。','검색어나 업무 범위를 변경해 보세요.','Thử từ khóa hoặc phạm vi nghiệp vụ khác.','Prueba otra búsqueda o ámbito de negocio.','Essayez une autre recherche ou un autre périmètre métier.','Versuchen Sie einen anderen Suchbegriff oder Geschäftsbereich.','Tente outra pesquisa ou âmbito de negócio.'],
  ['team.recoverAssignment','核对未完成交办','核對未完成交辦','Review pending assignment','未完了の依頼を確認','미완료 요청 검토','Kiểm tra công việc chưa hoàn tất','Revisar encargo pendiente','Vérifier la mission en attente','Offenen Auftrag prüfen','Rever atribuição pendente'],
  ['team.continueCreation','继续核对员工创建','繼續核對員工建立','Continue reviewing employee','従業員の作成確認を続ける','직원 생성 검토 계속','Tiếp tục kiểm tra nhân viên','Continuar revisando el empleado','Poursuivre la vérification du employé','Prüfung des Mitarbeiters fortsetzen','Continuar a rever o funcionário'],
  ['team.loading','正在读取员工…','正在讀取員工…','Loading employees…','従業員を読み込み中…','직원을 불러오는 중…','Đang tải nhân viên…','Cargando empleados…','Chargement des employés…','Mitarbeiter werden geladen…','A carregar funcionários…'],
  ['team.refresh','刷新已保存员工','重新整理已儲存員工','Refresh saved employees','保存済みの従業員を更新','저장된 직원 새로고침','Làm mới nhân viên đã lưu','Actualizar empleados guardados','Actualiser les employés enregistrés','Gespeicherte Mitarbeiter aktualisieren','Atualizar funcionários guardados'],
  ['team.stateFilter','员工状态','員工狀態','Employee status','従業員の状態','직원 상태','Trạng thái nhân viên','Estado del empleado','État du employé','Status der Mitarbeiter','Estado do funcionário'],
  ['team.landingTitle','员工管理','員工管理','Employee management','担当者の管理','직원 관리','Quản lý nhân viên','Gestión de empleados','Gestion des employés','Mitarbeiterverwaltung','Gestão de funcionários'],
  ['team.landingDescription','查看员工职责、授权范围和任务，管理在岗状态。分身用于代拟；暂停或退役后仍可查看历史记录。','查看員工職責、授權範圍和任務，管理在崗狀態。分身用於代擬；暫停或退役後仍可查看歷史記錄。','View employees’ duties, permissions, and tasks, and manage their status. Your double drafts on your behalf. History remains available after pausing or retiring an employee.','担当者の職責、権限、タスクを確認し、稼働状態を管理します。分身は下書きを作成します。一時停止や退役後も履歴を確認できます。','직원의 업무, 권한 및 작업을 확인하고 활동 상태를 관리하세요. 분신은 초안을 작성합니다. 직원을 일시 중지하거나 퇴역시킨 후에도 기록을 볼 수 있습니다.','Xem trách nhiệm, quyền và nhiệm vụ của nhân viên, quản lý trạng thái hoạt động. Bản sao soạn thảo giúp bạn. Vẫn xem được lịch sử sau khi tạm dừng hoặc cho nghỉ.','Consulta las responsabilidades, los permisos y las tareas de los empleados y gestiona su estado. Tu doble prepara borradores. El historial sigue disponible tras pausar o retirar a un empleado.','Consultez les responsabilités, autorisations et tâches des employés et gérez leur statut. Votre double prépare les brouillons. L’historique reste disponible après la suspension ou le retrait d’un employé.','Sehen Sie Aufgaben, Berechtigungen und Tätigkeiten der Mitarbeiter an und verwalten Sie ihren Status. Ihr Doppelgänger erstellt Entwürfe. Der Verlauf bleibt nach dem Pausieren oder Stilllegen verfügbar.','Veja as responsabilidades, permissões e tarefas dos funcionários e gira o estado. O seu duplo prepara rascunhos. O histórico continua disponível após pausar ou retirar um funcionário.'],
  ['task.directory.attention','待办目录','待辦目錄','Attention directory','要対応一覧','확인할 항목','Danh mục cần xử lý','Directorio pendiente','Répertoire des éléments à traiter','Offene Punkte','Diretório pendente'],
  ['task.directory.all','任务目录','任務目錄','Task directory','タスク一覧','작업 목록','Danh mục nhiệm vụ','Directorio de tareas','Répertoire des tâches','Aufgabenverzeichnis','Diretório de tarefas'],
  ['task.scopeFilter','任务业务范围','任務業務範圍','Task business scope','タスクの業務範囲','작업 업무 범위','Phạm vi nghiệp vụ của nhiệm vụ','Ámbito de la tarea','Périmètre métier de la tâche','Aufgabenbereich','Âmbito da tarefa'],
  ['task.table.owner','负责人','負責人','Owner','担当者','담당자','Người phụ trách','Responsable','Responsable','Verantwortlich','Responsável'],
  ['task.table.attention','需要你','需要你','Needs your attention','要確認','내 확인 필요','Cần bạn xử lý','Te necesita','Votre intervention','Ihre Mitwirkung','Precisa de si'],
  ['task.attention.unverified','尚未核对','尚未核對','Not yet verified','未確認','아직 확인되지 않음','Chưa được kiểm tra','Sin verificar','Non vérifié','Noch nicht geprüft','Ainda não verificado'],
  ['task.attention.recover','核对未完成状态','核對未完成狀態','Review pending state','未完了の状態を確認','미완료 상태 검토','Kiểm tra trạng thái chưa hoàn tất','Revisar estado pendiente','Vérifier l’état en attente','Offenen Status prüfen','Rever estado pendente'],
  ['task.filter.reset','重置筛选','重設篩選','Reset filters','絞り込みをリセット','필터 초기화','Đặt lại bộ lọc','Restablecer filtros','Réinitialiser les filtres','Filter zurücksetzen','Repor filtros'],
  ['continuous.loading','正在读取计划…','正在讀取計畫…','Loading plans…','計画を読み込み中…','계획을 불러오는 중…','Đang tải kế hoạch…','Cargando planes…','Chargement des plans…','Pläne werden geladen…','A carregar planos…'],
  ['continuous.recovery.pending','尚未确认上次自动化修改是否保存。请先核对结果，再进行其他修改。','尚未確認上次自動化修改是否儲存。請先核對結果，再進行其他修改。','The last automation change is not yet confirmed as saved. Check the result before making other changes.','前回の自動化の変更が保存されたか未確認です。結果を確認してから別の変更を行ってください。','이전 자동화 변경의 저장 여부가 확인되지 않았습니다. 결과를 확인한 후 다른 변경을 하세요.','Chưa xác nhận thay đổi tự động hóa trước đã được lưu hay chưa. Kiểm tra kết quả trước khi chỉnh sửa tiếp.','Aún no se ha confirmado si se guardó el último cambio de automatización. Comprueba el resultado antes de hacer otros cambios.','L’enregistrement de la dernière modification d’automatisation n’est pas confirmé. Vérifiez le résultat avant toute autre modification.','Ob die letzte Automatisierungsänderung gespeichert wurde, ist noch nicht bestätigt. Prüfen Sie das Ergebnis vor weiteren Änderungen.','Ainda não foi confirmado se a última alteração de automação foi guardada. Verifique o resultado antes de fazer outras alterações.'],
  ['continuous.recovery.triggerPending','尚未确认上次「立即运行」的结果。核对后会打开原任务，不会再次运行。','尚未確認上次「立即執行」的結果。核對後會開啟原任務，不會再次執行。','The last “Run now” result is not yet confirmed. Checking it opens the original task without running it again.','前回の「今すぐ実行」の結果は未確認です。確認すると元のタスクを開き、再実行はしません。','이전 “지금 실행” 결과가 확인되지 않았습니다. 확인하면 원래 작업을 열며 다시 실행하지 않습니다.','Chưa xác nhận kết quả lần “Chạy ngay” trước. Kiểm tra sẽ mở nhiệm vụ gốc mà không chạy lại.','El resultado de «Ejecutar ahora» aún no está confirmado. La comprobación abre la tarea original sin volver a ejecutarla.','Le dernier résultat de « Exécuter maintenant » n’est pas confirmé. La vérification ouvre la tâche initiale sans la relancer.','Das letzte Ergebnis von „Jetzt ausführen“ ist noch nicht bestätigt. Die Prüfung öffnet die ursprüngliche Aufgabe ohne erneute Ausführung.','O último resultado de «Executar agora» ainda não foi confirmado. A verificação abre a tarefa original sem voltar a executá-la.'],
  ['continuous.recovery.checking','正在核对…','正在核對…','Reviewing…','確認中…','검토 중…','Đang kiểm tra…','Revisando…','Vérification…','Prüfung läuft…','A rever…'],
  ['continuous.recovery.action','核对未完成计划请求','核对未完成計畫請求','Review pending plan request','未完了の計画リクエストを確認','미완료 계획 요청 검토','Kiểm tra yêu cầu kế hoạch chưa hoàn tất','Revisar solicitud de plan pendiente','Vérifier la demande de plan en attente','Offene Plananfrage prüfen','Rever pedido de plano pendente'],
  ['continuous.loading.retry','重试读取计划','重試讀取計畫','Retry loading plans','計画の読み込みを再試行','계획 불러오기 재시도','Thử tải lại kế hoạch','Reintentar la carga de planes','Réessayer de charger les plans','Pläne erneut laden','Tentar carregar os planos novamente'],
  ['continuous.detail.runTitle','每次执行详情','每次執行詳情','Run details','実行の詳細','실행 세부 정보','Chi tiết lần chạy','Detalles de la ejecución','Détails de l’exécution','Ausführungsdetails','Detalhes da execução'],
  ['continuous.detail.planTitle','持续计划详情','持續計畫詳情','Continuous plan details','継続計画の詳細','지속 계획 세부 정보','Chi tiết kế hoạch liên tục','Detalles del plan continuo','Détails du plan continu','Details des fortlaufenden Plans','Detalhes do plano contínuo'],
  ['continuous.detail.infoTitle','自动化说明','自動化說明','About automation','自動化について','자동화 안내','Giới thiệu tự động hóa','Acerca del automatización','À propos du automatisation','Informationen zur fortlaufenden Arbeit','Acerca do automação'],
  ['common.all','全部','全部','All','すべて','전체','Tất cả','Todo','Tout','Alle','Tudo'],
  ['status.ready','待开始','待開始','Ready','開始待ち','시작 대기','Sẵn sàng','Listo','Prêt','Bereit','Pronto'],
  ['status.waiting','等待处理','等待處理','Waiting','対応待ち','처리 대기','Đang chờ xử lý','En espera','En attente','Wartet','Em espera'],
  ['status.blocked','受阻','受阻','Blocked','ブロック中','차단됨','Bị chặn','Bloqueado','Bloqué','Blockiert','Bloqueado'],
  ['status.cancelled','已取消','已取消','Cancelled','キャンセル済み','취소됨','Đã hủy','Cancelado','Annulé','Abgebrochen','Cancelado'],
  ['attention.approval','审批','審批','Approval','承認','승인','Phê duyệt','Aprobación','Approbation','Genehmigung','Aprovação'],
  ['attention.materials','资料补充','資料補充','More material','資料の追加','자료 보완','Bổ sung tài liệu','Más material','Documents complémentaires','Weitere Unterlagen','Mais material'],
  ['attention.connection','待连接','待連接','Connection required','接続待ち','연결 필요','Cần kết nối','Requiere conexión','Connexion requise','Verbindung erforderlich','Ligação necessária'],
  ['attention.error','异常','異常','Error','エラー','오류','Lỗi','Error','Erreur','Fehler','Erro'],
  ['attention.review','待核对','待核對','Review','要確認','검토 필요','Cần kiểm tra','Revisión','À vérifier','Prüfung','Revisão'],
  ['attention.handoff','交接','交接','Handoff','引き継ぎ','인계','Bàn giao','Traspaso','Transmission','Übergabe','Transição'],
  ['attention.dispatch','待交办','待交辦','Assignment','依頼待ち','할당 대기','Chờ giao việc','Asignación','À attribuer','Zuweisung','Atribuição'],
  ['attention.home.description','审批、资料补充和执行核对','審批、資料補充和執行核對','Approvals, missing materials, and execution review','承認、資料補足、実行確認','승인, 자료 보완 및 실행 검토','Phê duyệt, bổ sung tài liệu và kiểm tra thực thi','Aprobaciones, material pendiente y revisión de ejecución','Approbations, documents manquants et vérification de l’exécution','Genehmigungen, fehlende Unterlagen und Ausführungsprüfung','Aprovações, materiais em falta e revisão da execução'],
  ['attention.home.checking','正在加载待办事项','正在載入待辦事項','Loading pending items','対応事項を読み込んでいます','할 일을 불러오는 중','Đang tải các mục cần xử lý','Cargando elementos pendientes','Chargement des éléments à traiter','Offene Einträge werden geladen','A carregar itens pendentes'],
  ['attention.persistence.example','示例','範例','Example','サンプル','예시','Ví dụ','Ejemplo','Exemple','Beispiel','Exemplo'],
  ['attention.recovery.taskMaterial','任务资料添加尚待核对。','任務資料新增尚待核對。','The task material addition still needs review.','タスク資料の追加は確認待ちです。','작업 자료 추가를 확인해야 합니다.','Việc thêm tài liệu tác vụ vẫn cần được xác minh.','La adición de material de tarea aún requiere revisión.','L’ajout de document de tâche doit encore être vérifié.','Die Aufgabenmaterial-Ergänzung muss noch geprüft werden.','A adição de material da tarefa ainda precisa de revisão.'],
  ['attention.recovery.artifact','成果保存尚待核对。','成果儲存尚待核對。','Saving the output still needs review.','成果の保存は確認待ちです。','성과 저장을 확인해야 합니다.','Việc lưu kết quả vẫn cần được xác minh.','El guardado del resultado aún requiere revisión.','L’enregistrement du livrable doit encore être vérifié.','Das Speichern des Ergebnisses muss noch geprüft werden.','O salvamento do resultado ainda precisa de revisão.'],
  ['attention.recovery.group','群协作写入尚待核对。','群組協作寫入尚待核對。','The group collaboration update still needs review.','グループ共同作業の更新は確認待ちです。','그룹 협업 변경을 확인해야 합니다.','Việc ghi cộng tác nhóm vẫn cần được xác minh.','La actualización de colaboración de grupo aún requiere revisión.','La mise à jour de collaboration de groupe doit encore être vérifiée.','Die Gruppenaktualisierung muss noch geprüft werden.','A atualização de colaboração em grupo ainda precisa de revisão.'],
  ['attention.recovery.industryLoad','行业模板加载尚待核对。','行業範本載入尚待核對。','The industry template load still needs review.','業界テンプレートの読み込みは確認待ちです。','산업 템플릿 로드를 확인해야 합니다.','Việc tải mẫu ngành vẫn cần được xác minh.','La carga de la plantilla de industria aún requiere revisión.','Le chargement du modèle sectoriel doit encore être vérifié.','Das Laden der Branchenvorlage muss noch geprüft werden.','O carregamento do modelo setorial ainda precisa de revisão.'],
  ['attention.recovery.skillInstall','技能安装尚待核对。','技能安裝尚待核對。','The Skill installation still needs review.','スキルのインストールは確認待ちです。','스킬 설치를 확인해야 합니다.','Việc cài đặt kỹ năng vẫn cần được xác minh.','La instalación de habilidad aún requiere revisión.','L’installation de la compétence doit encore être vérifiée.','Die Skill-Installation muss noch geprüft werden.','A instalação da competência ainda precisa de revisão.'],
  ['attention.recovery.serverRequest','一项已保存的工作请求尚待核对。','一項已儲存的工作請求尚待核對。','A saved work request still needs review.','保存済みの作業リクエストを確認する必要があります。','저장된 작업 요청을 확인해야 합니다.','Một yêu cầu công việc đã lưu vẫn cần được xác minh.','Una solicitud de trabajo guardada aún requiere revisión.','Une demande de travail enregistrée doit encore être vérifiée.','Eine gespeicherte Arbeitsanfrage muss noch geprüft werden.','Um pedido de trabalho guardado ainda precisa de revisão.'],
  ['attention.recovery.ackUnknown','原请求已核对，但尚未收到答复。请以刷新后的目录为准。','原請求已核對，但尚未收到答覆。請以重新整理後的目錄為準。','The original request was recovered, but no response has been received yet. Check the refreshed list.','元のリクエストは復元されましたが、まだ応答がありません。更新後の一覧をご確認ください。','원래 요청은 복구되었지만 아직 회신을 받지 못했습니다. 새로고침된 목록을 확인하세요.','Yêu cầu gốc đã được khôi phục nhưng chưa nhận được phản hồi. Hãy kiểm tra danh sách đã cập nhật.','La solicitud original se ha recuperado, pero aún no se ha recibido respuesta. Consulta la lista actualizada.','La demande initiale a été récupérée, mais aucune réponse n’a encore été reçue. Consultez la liste actualisée.','Die ursprüngliche Anfrage wurde wiederhergestellt, eine Rückmeldung steht jedoch noch aus. Prüfen Sie die aktualisierte Liste.','O pedido original foi recuperado, mas ainda não foi recebida resposta. Consulte a lista atualizada.'],
  ['attention.recovery.serverTitle','已保存的工作请求','已儲存的工作請求','Saved work request','保存済みの作業リクエスト','저장된 작업 요청','Yêu cầu công việc đã lưu','Solicitud de trabajo guardada','Demande de travail enregistrée','Gespeicherte Arbeitsanfrage','Pedido de trabalho guardado'],
  ['attention.recovery.localTime','待核对','待核對','Awaiting review','確認待ち','검토 대기','Đang chờ xác minh','Pendiente de revisión','En attente de vérification','Prüfung ausstehend','A aguardar revisão'],
  ['attention.persistence.serverRecovery','已保存','已儲存','Saved','保存済み','저장됨','Đã lưu','Guardada','Enregistrée','Gespeichert','Guardado'],
  ['attention.source.task','任务','任務','Task','タスク','작업','Nhiệm vụ','Tarea','Tâche','Aufgabe','Tarefa'],
  ['attention.source.handoff','任务交接','任務交接','Task handoff','タスクの引き継ぎ','작업 인계','Bàn giao nhiệm vụ','Traspaso de tarea','Transmission de tâche','Aufgabenübergabe','Transferência de tarefa'],
  ['attention.source.business','业务对象','業務物件','Business object','業務オブジェクト','업무 객체','Đối tượng nghiệp vụ','Objeto de negocio','Objet métier','Geschäftsobjekt','Objeto de negócio'],
  ['attention.source.plan','持续计划','持續計畫','Continuous plan','継続計画','지속 계획','Kế hoạch liên tục','Plan continuo','Plan continu','Fortlaufender Plan','Plano contínuo'],
  ['attention.source.binding','能力绑定','能力綁定','Capability binding','機能バインド','기능 바인딩','Liên kết năng lực','Vinculación de capacidad','Association de capacité','Fähigkeitsbindung','Vinculação de capacidade'],
  ['attention.source.installation','安装','安裝','Installation','インストール','설치','Cài đặt','Instalación','Installation','Installation','Instalação'],
  ['attention.source.localRecovery','本机待核对','本機待核對','Local review needed','ローカル確認待ち','로컬 확인 대기','Cần xác minh cục bộ','Revisión local pendiente','Vérification locale requise','Lokale Prüfung erforderlich','Revisão local pendente'],
  ['attention.source.serverRecovery','已保存待核对','已儲存待核對','Saved review needed','保存済みの確認待ち','저장된 검토 대기','Cần xác minh đã lưu','Revisión guardada pendiente','Vérification enregistrée requise','Gespeicherte Prüfung ausstehend','Revisão guardada pendente'],
  ['continuous.default.dataScope','本次工作明确提供并获准读取的资料。','本次工作明確提供並獲准讀取的資料。','Materials explicitly provided and approved for this work.','この作業で明示的に提供され、参照が許可された資料。','이번 작업에 명시적으로 제공되고 읽기 승인을 받은 자료입니다.','Tài liệu được cung cấp rõ ràng và cho phép đọc trong công việc này.','Material proporcionado explícitamente y autorizado para este trabajo.','Documents explicitement fournis et autorisés pour ce travail.','Für diese Arbeit ausdrücklich bereitgestellte und freigegebene Unterlagen.','Materiais fornecidos explicitamente e autorizados para este trabalho.'],
  ['continuous.default.delivery','可审阅工作成果与来源说明。','可審閱工作成果與來源說明。','Reviewable work output with source notes.','確認できる作業成果と出典の説明。','검토 가능한 작업 결과와 출처 설명입니다.','Kết quả có thể xem xét kèm mô tả nguồn.','Resultado revisable con notas de procedencia.','Résultat vérifiable accompagné des sources.','Prüfbares Arbeitsergebnis mit Quellenangaben.','Resultado verificável com indicação das fontes.'],
  ['continuous.saved.description','查看已保存的自动化及其执行记录','查看已儲存的自動化及其執行記錄','View saved automations and their run history','保存済みの自動化と実行履歴を確認','저장된 자동화 및 실행 기록 보기','Xem tự động hóa đã lưu và lịch sử chạy','Ver las automatizaciones guardadas y su historial','Consulter les automatisations enregistrées et leur historique','Gespeicherte Automatisierungen und ihren Verlauf ansehen','Ver automações guardadas e o seu histórico'],
  ['continuous.trigger.event','事件 · {source} · {event}','事件 · {source} · {event}','Event · {source} · {event}','イベント · {source} · {event}','이벤트 · {source} · {event}','Sự kiện · {source} · {event}','Evento · {source} · {event}','Événement · {source} · {event}','Ereignis · {source} · {event}','Evento · {source} · {event}'],
  ['continuous.trigger.daily','每天 {time} · {timezone}','每天 {time} · {timezone}','Daily at {time} · {timezone}','毎日 {time} · {timezone}','매일 {time} · {timezone}','Hằng ngày lúc {time} · {timezone}','Cada día a las {time} · {timezone}','Tous les jours à {time} · {timezone}','Täglich um {time} · {timezone}','Todos os dias às {time} · {timezone}'],
  ['continuous.trigger.weekly','每周{weekday} {time} · {timezone}','每週{weekday} {time} · {timezone}','Every {weekday} at {time} · {timezone}','毎週{weekday} {time} · {timezone}','매주 {weekday} {time} · {timezone}','Mỗi {weekday} lúc {time} · {timezone}','Cada {weekday} a las {time} · {timezone}','Chaque {weekday} à {time} · {timezone}','Jeden {weekday} um {time} · {timezone}','Todas as {weekday} às {time} · {timezone}'],
  ...TEAM_DETAIL_MESSAGE_ROWS,
  ...TASK_DETAIL_MESSAGE_ROWS,
  ...CONTINUOUS_DETAIL_MESSAGE_ROWS,
  ...BUSINESS_PAGE_MESSAGE_ROWS,
  ...BUSINESS_DETAILS_MESSAGE_ROWS,
  ...PROJECT_WORKSPACE_MESSAGE_ROWS,
  ...ARTIFACT_PANEL_MESSAGE_ROWS,
  ...CONVERSATION_DIALOG_MESSAGE_ROWS,
  ...APPROVAL_CARD_MESSAGE_ROWS,
  ...KNOWLEDGE_DIRECTORY_MESSAGE_ROWS,
  ...KNOWLEDGE_DOCUMENT_MESSAGE_ROWS,
  ...ADOPT_DIALOG_MESSAGE_ROWS,
  ...MARKET_PAGE_MESSAGE_ROWS,
  ...MARKET_INDUSTRY_MESSAGE_ROWS,
  ...MARKET_SOLUTION_MESSAGE_ROWS,
  ...INDUSTRY_COMPOSITION_MESSAGE_ROWS,
  ...MARKET_SKILL_CONTROL_MESSAGE_ROWS,
  ...MARKET_INSTALLATION_MESSAGE_ROWS,
  ...MARKET_FORM_MESSAGE_ROWS,
  ...MARKET_CATALOG_MESSAGE_ROWS,
  ...CONNECTOR_MESSAGE_ROWS,
  ...WORKSPACE_SETTINGS_MESSAGE_ROWS,
  ...COLLABORATION_MESSAGE_ROWS,
  ...CAPABILITY_BINDINGS_MESSAGE_ROWS,
  ...WORK_DIRECTORY_MESSAGE_ROWS,
  ...TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS,
  ...WORKSPACE_SEARCH_MESSAGE_ROWS,
  ...CONVERSATION_STATUS_MESSAGE_ROWS,
  ...EXAMPLE_DIRECTORY_MESSAGE_ROWS,
  ...FORMAL_UI_RESIDUAL_MESSAGE_ROWS,
  ...BUSINESS_FORM_MESSAGE_ROWS,
  ...ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS,
  ...HOME_SECONDARY_MESSAGE_ROWS,
  ...FORMAL_UI_P5_MESSAGE_ROWS,
  ...FORMAL_UI_P6_MESSAGE_ROWS,
  ...PRESENTATION_HELPER_MESSAGE_ROWS,
  ...PRESENTATION_SECONDARY_MESSAGE_ROWS,
  ...INDUSTRY_UPDATE_PREVIEW_MESSAGE_ROWS,
  ...EDITION_MESSAGE_ROWS,
  ...ATTENTION_DECISION_MESSAGE_ROWS,
  ...SECURITY_RECOVERY_MESSAGE_ROWS,
  ...RECOVERY_DISCARD_MESSAGE_ROWS,
  ...BUSINESS_DEFINITION_MESSAGE_ROWS,
  ...BUSINESS_CUSTOMIZATION_MESSAGE_ROWS,
  ...BUSINESS_DASHBOARD_MESSAGE_ROWS,
  ...PAGE_CREATE_MESSAGE_ROWS,
  ...BUSINESS_SHARE_MESSAGE_ROWS,
  ...BUSINESS_SHORTCUT_MESSAGE_ROWS,
  ...SUBAGENT_DELEGATION_MESSAGE_ROWS,
  ...ABOUT_PLAN_MESSAGE_ROWS,
  ...MARKET_SAVED_RESTORED_ROWS,
  ...MARKET_SKILL_UPGRADE_RESTORED_ROWS,
  ...AUTO_DREAM_MESSAGE_ROWS,
  ...GROUP_MENTION_MESSAGE_ROWS,
  ...GROUP_ATTACHMENT_MESSAGE_ROWS,
  ...GROUP_REACTION_MESSAGE_ROWS,
  ...WEB_ACCESS_MESSAGE_ROWS,
  ...MARKET_TAXONOMY_MESSAGE_ROWS,
  ...IM_CHANNELS_MESSAGE_ROWS,
  ...CREDENTIAL_STORE_MESSAGE_ROWS,
  ...BUNDLED_EXTENSIONS_MESSAGE_ROWS,
  ...SESSION_BROWSER_STOP_MESSAGE_ROWS,
] as const

export type CorePageMessageKey = typeof CORE_PAGE_MESSAGE_ROWS[number][0]
const localeIndexes = {'zh-CN':1,'zh-Hant':2,en:3,ja:4,ko:5,vi:6,es:7,fr:8,de:9,pt:10} as const

export const corePageMessages = Object.fromEntries(Object.entries(localeIndexes).map(([locale,index])=>[
  locale,
  Object.fromEntries(CORE_PAGE_MESSAGE_ROWS.map(row=>[row[0],row[index]])),
])) as Readonly<Record<keyof typeof localeIndexes,Readonly<Record<CorePageMessageKey,string>>>>
