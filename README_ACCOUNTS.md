# Steel Frontier — система аккаунтов

## Что добавлено в код

- Гостевой режим без обязательной регистрации.
- Экран приветствия, регистрации и входа в стиле Steel Frontier.
- Регистрация по email/паролю, вход и восстановление сессии.
- Google Sign-In для браузера и Credential Manager для Android APK.
- Серверные сессии; в базе хранится только хеш сессионного токена.
- Хеширование паролей через crypto.scrypt.
- Облачные сохранения монет, рекорда, открытых танков и выбранного танка.
- Синхронизация и объединение гостевого прогресса при первом входе.
- Смена никнейма и выход из аккаунта.

## Что нужно настроить перед использованием

Репозиторий теперь содержит серверные API и клиентский интерфейс, но production-авторизация требует двух переменных в окружении Render:

- DATABASE_URL — строка подключения к постоянной PostgreSQL-базе.
- GOOGLE_CLIENT_ID — Google OAuth Web Client ID. Без него email/пароль может работать после подключения базы, а Google-вход будет отключён.

Не используй Render Free Postgres для реальных аккаунтов: бесплатные базы Render истекают через 30 дней. Подключи постоянную PostgreSQL-базу или провайдера с подходящим долгосрочным тарифом и регулярно делай резервные копии. Не публикуй пароль базы в GitHub.

## Настройка

1. Создай постоянную PostgreSQL-базу и получи строку подключения.
2. В Render открой Web Service steel-frontier → Environment и добавь DATABASE_URL.
3. Создай OAuth Client ID типа Web application в Google Cloud Console; добавь домены, с которых открывается игра, в Authorized JavaScript origins. Укажи Web Client ID в GOOGLE_CLIENT_ID на Render.
4. Для Android зарегистрируй OAuth client приложения с package ID com.ammambouy.steelfrontier и SHA-1 сертификата подписи APK в том же Google Cloud project.
5. После деплоя открой https://steel-frontier.onrender.com/api/auth/config. Значения databaseConfigured и googleEnabled должны быть true.
6. Проверь регистрацию, вход, повторный запуск, синхронизацию на втором устройстве, гостевой перенос и работу без интернета.

## API

- GET /api/auth/config — состояние PostgreSQL и Google OAuth.
- POST /api/auth/register — регистрация.
- POST /api/auth/login — вход по email/паролю.
- POST /api/auth/google — проверка Google ID token.
- GET /api/auth/me — восстановление сессии.
- POST /api/auth/profile — изменение никнейма.
- POST /api/auth/logout — завершение сессии.
- GET и PUT /api/auth/save — облачные сохранения.

Пароль не хранится в открытом виде. Вход и сохранения требуют серверной сессии, однако текущая игра остаётся клиент-авторитетной: проверка прогресса на сервере ограничивает формат данных, но не заменяет полноценную античит-систему.
