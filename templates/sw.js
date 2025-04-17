const CACHE_NAME = 'handyhandle-cache-v3'; // Mantengo v3 para nuevos recursos
const MESSAGE_QUEUE = 'handyhandle-message-queue';
const SYNC_TAG = 'handyhandle-sync';
const MAX_MESSAGE_AGE = 24 * 60 * 60 * 1000; // 24 horas en milisegundos

const urlsToCache = [
  '/',
  '/templates/index.html',
  '/templates/style.css',
  '/templates/script.js',
  '/templates/manifest.json',
  '/templates/aero.png',
  '/templates/airport.png',
  '/templates/logoutred.png',
  '/templates/walkie-talkie.png',
  '/templates/volver.png',
  '/templates/mic.png',
  '/templates/mute.png',
  '/templates/mic-off.png',
  '/templates/mic-on.png',
  '/templates/icon-96x96.png',
  '/templates/icon-192x192.png',
  '/templates/icon-384x384.png',
  '/templates/icon-512x512.png',
  '/templates/icon-maskable-192x192.png'
];

// Instalar el Service Worker y cachear los recursos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache abierto:', CACHE_NAME);
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
        console.error('Error al abrir cache:', err);
      })
  );
  self.skipWaiting();
});

// Activar el Service Worker y eliminar caches antiguos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Eliminando cache antiguo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interceptar solicitudes y responder con recursos cacheados o de la red
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);

  // No cachear WebSocket ni rutas dinámicas
  if (requestUrl.protocol === 'wss:' ||
      requestUrl.pathname === '/opensky' ||
      requestUrl.pathname === '/aa2000_flights' ||
      requestUrl.pathname === '/history') {
    event.respondWith(
      fetch(event.request).catch(err => {
        console.error('Error en fetch de red:', err);
        return new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // Cachear tiles de Mapbox dinámicamente
  if (requestUrl.hostname.includes('api.mapbox.com')) {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          if (response) {
            console.log('Sirviendo tile de Mapbox desde cache:', event.request.url);
            return response;
          }
          return fetch(event.request)
            .then(networkResponse => {
              if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                return networkResponse;
              }
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, responseToCache);
                });
              return networkResponse;
            })
            .catch(err => {
              console.error('Error al obtener tile de Mapbox:', err);
              return new Response('Offline', { status: 503 });
            });
        })
    );
    return;
  }

  // Estrategia cache-first para recursos estáticos
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          console.log('Sirviendo desde cache:', event.request.url);
          return response;
        }
        return fetch(event.request)
          .then(networkResponse => {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              return networkResponse;
            }
            return caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, networkResponse.clone());
              return networkResponse;
            });
          })
          .catch(err => {
            console.error('Error al obtener recurso:', event.request.url, err);
            // Fallback a index.html para rutas HTML, o error para otros recursos
            if (event.request.destination === 'document') {
              return caches.match('/templates/index.html');
            }
            return new Response('Offline', { status: 503 });
          });
      })
  );
});

// Manejar mensajes desde script.js
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'QUEUE_MESSAGE') {
    queueMessage(event.data.message);
  }
});

// Sincronización en segundo plano
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncMessages());
  }
});

// Almacenar mensaje en IndexedDB
async function queueMessage(message) {
  const db = await openDB();
  const tx = db.transaction(MESSAGE_QUEUE, 'readwrite');
  const store = tx.objectStore(MESSAGE_QUEUE);
  const messageWithTimestamp = {
    ...message,
    timestamp: Date.now()
  };
  await store.add(messageWithTimestamp);
  await tx.done;
  console.log('Mensaje encolado:', messageWithTimestamp);
}

// Sincronizar mensajes pendientes
async function syncMessages() {
  const db = await openDB();
  const tx = db.transaction(MESSAGE_QUEUE, 'readwrite');
  const store = tx.objectStore(MESSAGE_QUEUE);
  const messages = await store.getAll();
  const now = Date.now();

  for (const message of messages) {
    if (now - message.timestamp > MAX_MESSAGE_AGE) {
      console.log('Descartando mensaje antiguo:', message);
      await store.delete(message.id);
      continue;
    }

    try {
      // Enviar mensajes al servidor según su tipo
      if (message.type === 'logout') {
        console.log('Sincronizando logout:', message);
        await sendToServer(message, '/logout'); // Ajustar según tu API
        await store.delete(message.id);
      } else if (message.type === 'create_group') {
        console.log('Sincronizando create_group:', message);
        await sendToServer(message, '/create_group'); // Ajustar según tu API
        await store.delete(message.id);
      } else if (message.type === 'message' || message.type === 'group_message') {
        console.log('Sincronizando mensaje de audio:', message);
        await sendToServer(message, '/ws/' + message.session_token); // Enviar vía WebSocket
        await store.delete(message.id);
      } else {
        console.log('Sincronizando mensaje genérico:', message);
        await sendToServer(message, '/generic'); // Ajustar según tu API
        await store.delete(message.id);
      }
      await notifyClient({ ...message, status: 'sent' });
    } catch (err) {
      console.error('Error al sincronizar mensaje:', message, err);
      // Mantener el mensaje para reintentar
    }
  }
  await tx.done;

  // Notificar a los clientes
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_COMPLETE' });
    });
  });
}

// Enviar mensaje al servidor
async function sendToServer(message, endpoint) {
  if (message.type === 'message' || message.type === 'group_message') {
    // Enviar vía WebSocket (simulado, ajustar según tu implementación)
    const ws = new WebSocket('wss://' + self.location.host + endpoint);
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify(message));
        ws.close();
        resolve();
      };
      ws.onerror = err => reject(err);
    });
  } else {
    // Enviar vía HTTP
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
    if (!response.ok) {
      throw new Error('Error al enviar mensaje al servidor');
    }
  }
}

// Notificar al cliente
async function notifyClient(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  if (clients.length === 0) {
    console.warn('No hay clientes activos para procesar mensaje:', message);
    return;
  }
  for (const client of clients) {
    client.postMessage({ type: 'SEND_MESSAGE', message });
  }
}

// Abrir base de datos IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('handyhandle-db', 1);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      db.createObjectStore(MESSAGE_QUEUE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = event => {
      resolve(event.target.result);
    };
    request.onerror = event => {
      reject(event.target.error);
    };
  });
}

// Manejo de notificaciones push (descomentar cuando tengas VAPID)
/*
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'Handyhandle', body: 'Nuevo mensaje recibido' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/templates/icon-192x192.png',
      badge: '/templates/icon-192x192.png'
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
*/
