/**
 * app.js (Практика 17)
 *
 * Клиент — обычный HTML+JS (без React/Vite).
 *
 * Идея практики:
 * 1) PWA работает по HTTPS (сервер раздаёт эту статику).
 * 2) Браузер подписывается на Push (PushSubscription).
 * 3) Сервер умеет отправлять Push сразу (test) и с задержкой (reminder schedule).
 * 4) В уведомлении есть action "Отложить на 5 минут" → Service Worker вызывает /api/reminders/snooze.
 *
 * Важно: здесь намеренно минимальный UI.
 * TODO (студентам): улучшить вёрстку, валидацию, список напоминаний и т.п.
 */

const $ = (sel) => document.querySelector(sel);

// Адрес API относительный, потому что клиент открывается с сервера:
// https://localhost:3443/  →  /api/... это тот же origin
const API = {
  health: () => fetch('/api/health').then((r) => r.json()),

  // PUSH
  vapidPublicKey: () => fetch('/api/push/vapid-public-key').then((r) => r.json()),
  subscribe: (sub) => fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub),
  }).then((r) => r.json()),
  pushTest: () => fetch('/api/push/test', { method: 'POST' }).then((r) => r.json()),

  // ================================
  // ПР17: REMINDERS API (клиент → сервер)
  // ================================
  // scheduleReminder отправляет на сервер запрос:
  // POST /api/reminders/schedule
  // Сервер создаёт напоминание и ставит таймер (setTimeout).
  // Когда таймер сработает — сервер отправит push всем подписчикам.
  scheduleReminder: (payload) =>
  fetch('/api/reminders/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json()),
};

// --------------------------------------------------
// VAPID public key приходит с сервера как строка (base64url).
// Но pushManager.subscribe() требует applicationServerKey в виде Uint8Array.
// Поэтому мы делаем техническую конвертацию base64url -> Uint8Array.
// --------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// --------------------------------------------------
// База (ПР13–16): регистрируем Service Worker,
// потому что PUSH уведомления приходят именно в SW (а не в обычный JS на странице).
// --------------------------------------------------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    log('Service Worker не поддерживается в этом браузере.');
    return null;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  log('SW зарегистрирован.');
  return reg;
}

function log(msg) {
  const el = $('#log');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + el.textContent;
}

async function ensurePushPermission() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error('Разрешение на уведомления не выдано');
  }
}

// --------------------------------------------------
// База (ПР16) + нужна для ПР17:
// 1) просим разрешение Notifications
// 2) берём VAPID public key с сервера
// 3) создаём push-subscription в браузере
// 4) отправляем subscription на сервер
//
// Без этого шагa сервер НЕ сможет отправить push позже,
// потому что ему некуда отправлять (нет subscription).
// --------------------------------------------------

async function subscribePush(reg) {
  await ensurePushPermission();

  const { publicKey } = await API.vapidPublicKey();
  if (!publicKey) throw new Error('VAPID public key отсутствует. Проверьте server/.env');

  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  // Создаём подписку в браузере
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  // Сохраняем подписку на сервере
  const res = await API.subscribe(subscription.toJSON());

  log(`Подписка создана. На сервере подписок: ${res.count}`);
}

// --------------------------------------------------
// ПР17: планируем уведомление.
// Это НЕ отправка уведомления сейчас.
// Это просьба к серверу: "отправь через delaySeconds".
// Сервер вернёт reminder.id и рассчитает fireAt.
// --------------------------------------------------

async function scheduleReminder() {
  const title = $('#rem-title').value.trim() || 'Напоминание';
  const delaySeconds = Number($('#rem-delay').value || 30);

  const res = await API.scheduleReminder({
    title,
    body: 'Отложенное уведомление (ПР17)',
    delaySeconds,
  });

  if (res.error) {
    log(`Ошибка schedule: ${res.message || res.error}`);
    return;
  }

  log(`Запланировано: через ${delaySeconds} сек (id=${res.reminder.id})`);
}

// -----------------------
// Инициализация UI
// -----------------------

(async function init() {
  const reg = await registerServiceWorker();

  $('#btn-health').addEventListener('click', async () => {
    const data = await API.health();
    log(`Health: ok=${data.ok} ts=${data.ts}`);
  });

  $('#btn-subscribe').addEventListener('click', async () => {
    try {
      if (!reg) return;
      await subscribePush(reg);
    } catch (e) {
      log(`Subscribe error: ${e.message}`);
    }
  });

  $('#btn-push-test').addEventListener('click', async () => {
    const res = await API.pushTest();
    if (res.error) {
      log(`Push test error: ${res.message || res.error}`);
      return;
    }
    log(`Push test sent=${res.sent} total=${res.total}`);
  });

  $('#btn-schedule').addEventListener('click', async () => {
    try {
      await scheduleReminder();
    } catch (e) {
      log(`Schedule error: ${e.message}`);
    }
  });
})();
