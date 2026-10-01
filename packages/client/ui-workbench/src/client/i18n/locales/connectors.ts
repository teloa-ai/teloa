// 显式标注行类型：与 market-installations.ts 同样的写法，避免逐行字面量推断撞上 TS7056。
type Row=readonly [string,string,string,string,string,string,string,string,string,string,string]
/** 数据源、MCP 连接、执行工具在用户侧统称「连接器」；契约与代码内部的落点名不受影响。 */
export const CONNECTOR_MESSAGE_ROWS:readonly Row[]=[
 ['connector.label','连接','連線','Connection','接続','연결','Kết nối','Conexión','Connexion','Verbindung','Ligação'],
 ['connector.test','测试连接','測試連線','Test connection','接続をテスト','연결 테스트','Kiểm tra kết nối','Probar conexión','Tester la connexion','Verbindung testen','Testar ligação'],
 ['connector.testing','正在测试连接…','正在測試連線…','Testing connection…','接続をテスト中…','연결을 테스트하는 중…','Đang kiểm tra kết nối…','Probando la conexión…','Test de la connexion…','Verbindung wird getestet…','A testar a ligação…'],
 ['connector.ok','连接正常，{at} 试过一次。','連線正常，{at} 試過一次。','Connection works; last tested {at}.','接続は正常です。最終テストは {at}。','연결이 정상입니다. 마지막 테스트 {at}.','Kết nối bình thường, đã thử lúc {at}.','La conexión funciona; última prueba {at}.','La connexion fonctionne ; dernier test {at}.','Verbindung funktioniert; zuletzt getestet {at}.','A ligação funciona; último teste {at}.'],
 ['connector.failed','连接不通：{reason}','連線不通：{reason}','Connection failed: {reason}','接続できません：{reason}','연결하지 못했습니다: {reason}','Không kết nối được: {reason}','No se pudo conectar: {reason}','Échec de la connexion : {reason}','Verbindung fehlgeschlagen: {reason}','Não foi possível ligar: {reason}'],
 ['connector.neverTested','还没试过这条连接。','還沒試過這條連線。','This connection has not been tested yet.','この接続はまだテストしていません。','이 연결은 아직 테스트하지 않았습니다.','Chưa thử kết nối này.','Aún no se ha probado esta conexión.','Cette connexion n’a pas encore été testée.','Diese Verbindung wurde noch nicht getestet.','Esta ligação ainda não foi testada.'],
 // 受管连接器凭据表单（规格 2026-09-27 §7.1）：header 变量的头名说明、basic 用户名输入与发送方式说明。
 ['connector.credential.headerNote','将作为请求头 {name} 发送','將作為請求標頭 {name} 傳送','Sent as the {name} request header','リクエストヘッダー {name} として送信されます','{name} 요청 헤더로 전송됩니다','Được gửi dưới dạng tiêu đề yêu cầu {name}','Se envía como la cabecera de solicitud {name}','Envoyé comme en-tête de requête {name}','Wird als Request-Header {name} gesendet','Enviado como o cabeçalho de pedido {name}'],
 ['connector.credential.username','用户名','使用者名稱','Username','ユーザー名','사용자 이름','Tên người dùng','Nombre de usuario','Nom d’utilisateur','Benutzername','Nome de utilizador'],
 ['connector.credential.basicNote','用户名与密码将以 HTTP Basic 认证发送','使用者名稱與密碼將以 HTTP Basic 驗證傳送','The username and password are sent with HTTP Basic authentication','ユーザー名とパスワードは HTTP Basic 認証で送信されます','사용자 이름과 비밀번호는 HTTP Basic 인증으로 전송됩니다','Tên người dùng và mật khẩu được gửi bằng xác thực HTTP Basic','El nombre de usuario y la contraseña se envían con autenticación HTTP Basic','Le nom d’utilisateur et le mot de passe sont envoyés via l’authentification HTTP Basic','Benutzername und Passwort werden per HTTP-Basic-Authentifizierung gesendet','O nome de utilizador e a palavra-passe são enviados com autenticação HTTP Basic'],
]
