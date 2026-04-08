/**
 * Service Worker (ПР17 — отложенные push‑уведомления)
 *
 * База (из ПР13–14):
 * - install/activate/fetch → кэшируем App Shell, чтобы работало офлайн.
 *
 * Новое (ПР17):
 * - push → показываем уведомление
 * - notificationclick → обрабатываем кнопку "Отложить на 5 минут" (snooze)
 */

const CACHE_NAME = 'pr17-cache-v1';

// App Shell: минимум файлов, которые нужны, чтобы открыть приложение офлайн
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
});

self.addEventListener('fetch', (event) => {
  // Cache First для App Shell
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// =====================================================
// Service Worker (SW) — база из ПР13–14/15–16 + НОВОЕ в ПР17
// =====================================================
//
// База (ПР13–14 / ПР15):
// - install/activate/fetch: кэширование App Shell (index.html, styles, app.js, icons и т.п.)
// - офлайн-режим (Cache API)
//   (эти части обычно выше в файле sw.js)
//
// База (ПР16):
// - push: получение push события и показ уведомления
// - notificationclick: реакция на клик по уведомлению
//
// НОВОЕ (ПР17):
// - в payload добавляем reminderId
// - показываем action-кнопку "Отложить на 5 минут"
// - по клику на action делаем fetch('/api/reminders/snooze')
//   чтобы сервер перепланировал уведомление

// ----------------------------
// ПР17: PUSH уведомления (+ часть уже из того что было ренее)
// ----------------------------

self.addEventListener('push', (event) => {
  // event.data — полезная нагрузка, которую сервер отправил через web-push.
  // Обычно это JSON строка → event.data.json()
  // Иногда event.data может быть пустым, поэтому защищаемся.
  const data = event.data ? event.data.json() : {};

  // То, что увидит пользователь в уведомлении
  const title = data.title || 'Напоминание';
  const body = data.body || 'У вас новое уведомление';

  // reminderId нужен для snooze — чтобы "отложить" именно конкретное напоминание
  const reminderId = data.reminderId || null;

  // actions: массив кнопок в уведомлении.
  // Сервер может передать data.actions = ['snooze_5m'].
  const actions = [];
  if (Array.isArray(data.actions) && data.actions.includes('snooze_5m')) {
    actions.push({ action: 'snooze_5m', title: 'Отложить на 5 минут' });
  }

  // options — настройки уведомления
  const options = {
    body,

    // data — это "встроенный контейнер", который мы можем прочитать в notificationclick
    // Туда кладём:
    // - url (куда открыть вкладку)
    // - reminderId (для snooze)
    data: {
      url: data.url || '/',
      reminderId,
    },

    actions,

    // TODO (студентам): добавить icon/badge из assets/icons
    // icon: '/assets/icons/favicon-128x128.png',
    // badge: '/assets/icons/favicon-48x48.png',
    // если еще не сделали на практике ранее))))
  };

  // event.waitUntil(...) — говорит браузеру:
  // "не завершай обработку события, пока showNotification не выполнится".
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  // Закрываем уведомление сразу, чтобы оно не висело
  event.notification.close();

  const { url, reminderId } = event.notification.data || {};

  // 1) НОВОЕ (ПР17): нажали action "Отложить на 5 минут"
  if (event.action === 'snooze_5m' && reminderId) {
    // Service Worker может делать fetch на тот же origin.
    // Мы открыты на https://localhost:3443 → значит fetch('/api/...') пойдёт туда же.
    event.waitUntil(
      fetch('/api/reminders/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderId, minutes: 5 }),
      }).catch(() => {
        // TODO (студентам): логировать или показывать пользователю ошибку (если нужно)
      })
    );
    return; // важно: не продолжаем открывать вкладку
  }

  // 2) База (ПР16): обычный клик по уведомлению → открыть/фокусировать вкладку
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Если вкладка уже открыта — фокусируем
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      // Иначе — открываем новую
      if (clients.openWindow) return clients.openWindow(url || '/');
    })
  );
});
