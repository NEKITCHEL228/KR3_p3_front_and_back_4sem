const fs = require('fs');
const path = require('path');
const https = require('https');

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const { configureWebPush, sendNotification } = require('./push');

/**
 * Практика 17 — Отложенные push‑уведомления (шаблон)
 *
 * Что делает этот сервер:
 * 1) Поднимает HTTPS (нужно для Service Worker и Push API).
 * 2) Раздаёт статику проекта (index.html, sw.js, manifest.json, content/*, assets/*).
 * 3) Даёт API для Push:
 *    - отдать VAPID public key
 *    - сохранить subscription
 *    - отправить тестовый push
 * 4) Новое в ПР17: планировщик напоминаний (отложенная отправка).
 *
 * ВАЖНО (учебно):
 * - subscriptions и reminders хранятся в памяти процесса → после перезапуска всё пропадёт.
 * - это нормально для практики; хранение в БД/Redis — как доп. задание. но если желания особо нет - то в следующих практиках у нас как раз это будет)))
 */

const app = express();
const PORT = Number(process.env.PORT || 3443);

app.use(cors());
app.use(express.json());

// --- Статика (клиент PWA) ---
// FRONTEND_DIR = корень репозитория (на два уровня выше server/src)
const FRONTEND_DIR = path.join(__dirname, '..', '..');
app.use(express.static(FRONTEND_DIR));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ----------------------------
// PUSH (VAPID + subscriptions)
// ----------------------------

// Учебное хранилище подписок (в памяти)
// TODO (студентам): заменить на БД/Redis/файл.
const subscriptions = new Set();

// Настройка web-push (если ключи есть)
let pushReady = false;
try {
  configureWebPush({
    subject: process.env.VAPID_SUBJECT,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  });
  pushReady = true;
} catch (e) {
  // Сервер можно запускать и без push — просто часть endpoints не будет работать.
  console.warn('[PUSH] Not configured:', e.message);
}

/**
 * GET /api/push/vapid-public-key
 * Клиенту нужен public key, чтобы сделать pushManager.subscribe(...)
 * уже делали это ранее в практиках
 */
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(400).json({ error: 'push_not_configured', message: 'Set VAPID_PUBLIC_KEY in server/.env' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY, pushReady });
});

/**
 * POST /api/push/subscribe
 * Клиент отправляет subscription (PushSubscription.toJSON())
 * и это делали тоже
 */
app.post('/api/push/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription) {
    return res.status(400).json({ error: 'subscription_required' });
  }

  // В Set кладём строку, чтобы Set корректно сравнивал объекты
  subscriptions.add(JSON.stringify(subscription));
  res.json({ ok: true, count: subscriptions.size, pushReady });
});

/**
 * POST /api/push/test
 * Отправить тестовый push всем подписчикам (сразу, без задержки)
 */
app.post('/api/push/test', async (req, res) => {
  if (!pushReady) {
    return res.status(400).json({ error: 'push_not_configured', message: 'Set VAPID keys in server/.env' });
  }

  const payload = JSON.stringify({
    title: 'PWA уведомление',
    body: 'Тестовое уведомление (ПР17)',
    url: '/',
    ts: Date.now(),
  });

  let sent = 0;
  for (const raw of Array.from(subscriptions)) {
    const subscription = JSON.parse(raw);
    try {
      await sendNotification(subscription, payload);
      sent++;
    } catch (e) {
      // TODO (студентам): при 410/404 удалять подписку
      console.warn('[PUSH] send failed:', e.statusCode || '', e.body || e.message);
    }
  }

  res.json({ ok: true, sent, total: subscriptions.size });
});

// ============================
// ПР17: ОТЛОЖЕННЫЕ PUSH УВЕДОМЛЕНИЯ
// ============================
//
// В ПР15–16 у нас была база для push:
// - подписка клиента (subscription)
// - хранение подписок на сервере (subscriptions)
// - функция sendNotification(subscription, payload)
//
// В ПР17 добавляем НОВОЕ:
// - планирование уведомления “через N секунд”
// - endpoint /api/reminders/schedule
// - endpoint /api/reminders/snooze (отложить на 5 минут по клику в уведомлении)
//
// Важно: здесь учебная реализация “в памяти”.
// После перезапуска сервера всё исчезнет (и подписки, и запланированные напоминания).

// reminders = "хранилище напоминаний" (как мини-БД в памяти процесса).
// Ключ: reminder.id, Значение: объект reminder.
const reminders = new Map();

// reminderTimers = хранилище активных таймеров setTimeout(...) по reminder.id.
// Зачем отдельно?
// - чтобы уметь перепланировать (snooze) и отменять/перезаписывать старый таймер.
const reminderTimers = new Map();

/**
 * scheduleReminderTimer(reminder)
 *
 * Делает ровно одну вещь:
 * - ставит setTimeout, который через delayMs отправит PUSH всем подписчикам.
 *
 * Почему это отдельной функцией:
 * - потому что она используется и в /schedule (первичное планирование),
 *   и в /snooze (перепланирование).
 */
function scheduleReminderTimer(reminder) {
  // 0) Если для этого reminder.id уже был таймер — удаляем его,
  // иначе получим ДВА уведомления: старое и новое.
  const prev = reminderTimers.get(reminder.id);
  if (prev) clearTimeout(prev);

  // 1) Считаем задержку до момента отправки
  // reminder.fireAt — это "время в миллисекундах" (timestamp), когда надо отправить
  const delayMs = Math.max(0, reminder.fireAt - Date.now());

  // 2) Ставим таймер. Когда он сработает — отправим push.
  const t = setTimeout(async () => {
    // 2.1) Если push не настроен (нет VAPID ключей) — НЕ падаем, просто логируем.
    if (!pushReady) {
      console.warn('[REMINDER] push not configured, skip send');
      return;
    }

    // 2.2) Формируем payload — то, что уйдёт в Service Worker через event.data.json()
    // Важно: это НЕ "чистый текст", а JSON строка.
    const payload = JSON.stringify({
      title: reminder.title,
      body: reminder.body,
      url: '/',            // куда вести пользователя по клику
      reminderId: reminder.id, // важно для "snooze" (отложить именно это уведомление)

      // actions — подсказка Service Worker'у: какие кнопки показать в уведомлении
      // В ПР17 добавляем action "snooze_5m" (Отложить на 5 минут)
      actions: ['snooze_5m'],

      ts: Date.now(),
    });

    // 2.3) Отправляем уведомление ВСЕМ подписчикам
    // subscriptions — Set с JSON строками подписок (из ПР15–16)
    let sent = 0;
    for (const raw of Array.from(subscriptions)) {
      const subscription = JSON.parse(raw);
      try {
        await sendNotification(subscription, payload);
        sent++;
      } catch (e) {
        // Здесь часто бывает "subscription умерла" (410/404).
        // В учебной версии мы просто логируем.
        // TODO (студентам): при 410 удалять подписку из subscriptions.
        console.warn('[PUSH] send failed:', e.statusCode || '', e.body || e.message);
      }
    }

    console.log(`[REMINDER] sent=${sent} id=${reminder.id}`);
  }, delayMs);

  // 3) Сохраняем таймер по id (чтобы можно было отменять/перепланировать)
  reminderTimers.set(reminder.id, t);
}

/**
 * POST /api/reminders/schedule
 *
 * ПР17: планирование отложенного уведомления.
 *
 * Вход:
 * {
 *   "title": "Сдать практику",
 *   "body": "ПР17: через 30 сек",
 *   "delaySeconds": 30
 * }
 *
 * Выход:
 * - { ok: true, reminder: {...} }
 * - reminder.fireAt — конкретное время в будущем (timestamp)
 */
app.post('/api/reminders/schedule', (req, res) => {
  const { title, body, delaySeconds } = req.body || {};

  // 1) Минимальная валидация входа
  // delaySeconds должен быть number, иначе расчёт fireAt невозможен.
  if (!title || typeof delaySeconds !== 'number') {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Нужны поля: title (string), delaySeconds (number). body (string) — опционально.',
    });
  }

  // 2) Создаём напоминание
  const id = nanoid(10);
  const now = Date.now();

  // fireAt — момент времени, когда отправить уведомление
  const fireAt = now + Math.max(0, delaySeconds) * 1000;

  const reminder = {
    id,
    title: String(title),
    body: body ? String(body) : 'Напоминание (ПР17)',
    createdAt: now,
    fireAt,
  };

  // 3) Сохраняем в "мини-БД" (Map)
  reminders.set(id, reminder);

  // 4) Ставим таймер (самое главное в ПР17)
  scheduleReminderTimer(reminder);

  // 5) Отдаём клиенту результат
  res.json({ ok: true, reminder });
});

/**
 * POST /api/reminders/snooze
 *
 * ПР17: перепланирование ("Отложить на 5 минут").
 *
 * Этот endpoint вызывается НЕ из app.js, а из Service Worker,
 * когда пользователь нажал кнопку в уведомлении.
 *
 * Вход:
 * {
 *   "reminderId": "abc123",
 *   "minutes": 5
 * }
 */
app.post('/api/reminders/snooze', (req, res) => {
  const { reminderId, minutes } = req.body || {};

  if (!reminderId) {
    return res.status(400).json({ error: 'validation_error', message: 'Нужно поле reminderId' });
  }

  const reminder = reminders.get(reminderId);
  if (!reminder) {
    return res.status(404).json({ error: 'not_found', message: 'Напоминание не найдено' });
  }

  // По умолчанию 5 минут (если minutes не передали)
  const m = typeof minutes === 'number' ? minutes : 5;

  // 1) Меняем время отправки (fireAt) на “сейчас + m минут”
  reminder.fireAt = Date.now() + Math.max(0, m) * 60 * 1000;

  // 2) Обновляем запись в Map (формально можно не делать, объект и так изменён,
  // но так понятнее студентам: "мы записали обновлённый reminder")
  reminders.set(reminder.id, reminder);

  // 3) Перепланируем таймер: старый будет очищен, новый поставлен
  scheduleReminderTimer(reminder);

  res.json({ ok: true, reminder });
});

/**
 * TODO (студентам): добавить эндпоинт списка напоминаний
 * GET /api/reminders
 */

// ----------------------------
// HTTPS + Socket.IO (optional)
// ----------------------------

const CERT_DIR = path.join(__dirname, '..', 'certs');
const keyPath = path.join(CERT_DIR, 'localhost-key.pem');
const certPath = path.join(CERT_DIR, 'localhost-cert.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('HTTPS certs not found. Create server/certs/localhost-key.pem and server/certs/localhost-cert.pem');
  console.error('See README.md (root)');
  process.exit(1);
}

const httpsServer = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  },
  app
);

// Socket.IO оставляем как «поддержку» предыдущих практик (можно использовать для live‑обновлений)
const io = new Server(httpsServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('[WS] connected:', socket.id);

  // TODO (студентам): события под UI, если захотите делать realtime
  socket.on('todo:event', (payload) => {
    socket.broadcast.emit('todo:event', payload);
  });

  socket.on('disconnect', () => {
    console.log('[WS] disconnected:', socket.id);
  });
});

httpsServer.listen(PORT, () => {
  console.log(`HTTPS server: https://localhost:${PORT}`);
  console.log(`Health: https://localhost:${PORT}/api/health`);
});
