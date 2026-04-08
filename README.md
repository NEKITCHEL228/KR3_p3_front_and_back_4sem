# Практика 17 — PWA: отложенные Push‑уведомления (шаблон)

Этот репозиторий — **учебная заготовка** под **Практику 17**.

**База:** проект практик **13–14** (PWA + Service Worker + Cache API) и практик **15–16** (HTTPS + Web Push/VAPID + WebSocket).  
В этом стартере главное новое — **отложенная отправка push‑уведомлений** (server‑side scheduling) и заготовка под кнопку **«Отложить на 5 минут»**.

> Важно: часть кода намеренно оставлена как **TODO для студентов**. Это НЕ «готовое решение».

---

## 1) Что внутри

### Клиент (обычный HTML + JS)

- `index.html`, `styles.css`, `app.js` — интерфейс демо.
- `manifest.json` — манифест.
- `sw.js` — Service Worker:
  - кэширование App Shell (из практик 13–14);
  - обработчик `push` (показ уведомления);
  - обработчик `notificationclick` (заготовка под «Отложить»).
- `content/` — HTML‑фрагменты для подгрузки без перезагрузки (App Shell идея из ПР15).
- `assets/icons/` — иконки PWA.

### Сервер (Node.js + HTTPS + Push + WS)

- `server/src/server.js` — HTTPS сервер Express:
  - раздаёт статику проекта (чтобы PWA работал на https);
  - endpoints для push (`/api/push/...`);
  - **новое в ПР17:** endpoints для **отложенных уведомлений** (`/api/reminders/...`).
- `server/src/push.js` — настройка web‑push и отправка уведомлений.

---

## 2) Запуск проекта (macOS / Linux / Windows)

### 2.1 Установка зависимостей

```bash
cd server
npm i
```

### 2.2 HTTPS сертификаты (обязательно)

Service Worker и Push требуют **secure context**, поэтому проект запускается на **https://localhost**. Это было в прошлом репо (ПР 15-16). Здесь для повторения (п 2-3).

Нужны файлы:

- `server/certs/localhost-key.pem`
- `server/certs/localhost-cert.pem`

#### Вариант A: mkcert (рекомендуется)

```bash
# 1) установка mkcert (пример для macOS)
brew install mkcert
mkcert -install

# 2) генерация сертификатов
cd server
mkdir -p certs
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost-cert.pem localhost
```

#### Вариант B: OpenSSL (если mkcert нет)

```bash
cd server
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/localhost-key.pem \
  -out certs/localhost-cert.pem \
  -days 365 \
  -subj "/CN=localhost"
```

> Если сертификат самоподписанный — браузер предупредит. Это нормально для учебного проекта.

---

## 3) Настройка Push (VAPID) — один раз

### 3.1 Сгенерировать VAPID ключи

```bash
cd server
npm run vapid
```

В выводе будут две строки:

- `VAPID_PUBLIC_KEY=...`
- `VAPID_PRIVATE_KEY=...`

### 3.2 Создать `server/.env`

Создайте файл `server/.env` (имя начинается с точки) и вставьте:

```env
PORT=3443
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
# необязательно, но можно:
VAPID_SUBJECT=mailto:teacher@example.com
```

---

## 4) Запуск сервера

```bash
cd server
npm run dev
```

Открыть в браузере:

- `https://localhost:3443`

Проверка здоровья:

- `https://localhost:3443/api/health`

---

## 5) Что добавлено именно для Практики 17

### 5.1 Server‑side «отложенная отправка»

Сервер принимает команду «запланировать уведомление» и ставит `setTimeout(...)`.

Endpoints:

- `GET /api/push/vapid-public-key` — отдать public ключ клиенту
- `POST /api/push/subscribe` — сохранить подписку браузера
- `POST /api/push/test` — отправить тестовое уведомление всем подписчикам

**Новое (ПР17):**

- `POST /api/reminders/schedule` — запланировать уведомление на `delaySeconds`
- `POST /api/reminders/snooze` — заготовка под «Отложить на 5 минут»

> В учебной версии напоминания и подписки хранятся в памяти процесса (после перезапуска всё исчезает) — это нормально для практики.

### 5.2 Service Worker: кнопка «Отложить»

В `sw.js`:

- `self.addEventListener('push', ...)` показывает уведомление;
- `self.addEventListener('notificationclick', ...)` ловит клики по действиям (actions).

Заготовка: если пользователь нажал action `snooze_5m`, Service Worker должен отправить запрос на сервер, чтобы перепланировать уведомление.

---

## 6) TODO студентам

Полный чек‑лист — в `docs/student-handout.md`.

Коротко:

- на клиенте: подписка на push + кнопки «тест push» и «запланировать на N секунд»;
- на сервере: нормальная модель напоминания (id, title, body, fireAt), обработка удаления/перезапуска;
- в Service Worker: обработка action `snooze_5m` и перепланирование.

---

## 7) Что НЕ надо коммитить в репозиторий

Проверьте, что в git не попали:

- `node_modules/`
- `server/.env`
- `server/certs/*.pem`

Они уже добавлены в `.gitignore`.
