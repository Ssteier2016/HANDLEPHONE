const CACHE_NAME = 'handyhandle-cache-v2'; // Cambié a v2 para forzar actualización
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/templates/aero.png',
  '/templates/airport.png',
  '/templates/logoutred.png',
  '/templates/icon-192x192.png',
  '/templates/icon-512x512.png'
];

// Cola para mensajes pendientes (audio, grupo, etc.)
const MESSAGE_QUEUE = 'handyhandle-message-queue';
const SYNC_TAG = 'handyhandle-sync';

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
  // Forzar activación inmediata
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
  return self.clients.claim();
});

// Interceptar solicitudes y responder con recursos cacheados o de la red
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);

  // No cachear WebSocket ni rutas dinámicas
  if (requestUrl.protocol === 'wss:' || 
      requestUrl.pathname === '/opensky' || 
      requestUrl.pathname === '/aa2000_flights' || 
      requestUrl.pathname === '/history') {
    return fetch(event.request).catch(err => {
      console.error('Error en fetch de red:', err);
      return new Response('Offline', { status: 503 });
    });
  }

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
            // Cachear recursos nuevos
            return caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, networkResponse.clone());
              return networkResponse;
            });
          })
          .catch(err => {
            console.error('Error al obtener recurso:', event.request.url, err);
            return caches.match('/index.html'); // Fallback offline
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
  await store.add(message);
  await tx.done;
  console.log('Mensaje encolado:', message);
}

// Sincronizar mensajes pendientes
async function syncMessages() {
  const db = await openDB();
  const tx = db.transaction(MESSAGE_QUEUE, 'readwrite');
  const store = tx.objectStore(MESSAGE_QUEUE);
  const messages = await store.getAll();

  for (const message of messages) {
    try {
      const wsUrl = `wss://${self.location.host}/ws/${message.sessionToken}`;
      // Simular envío (el WebSocket real se maneja en script.js)
      await notifyClient(message);
      // Eliminar mensaje si se envió con éxito
      await store.delete(message.id);
    } catch (err) {
      console.error('Error al sincronizar mensaje:', err);
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

// Notificar al cliente para manejar WebSocket
async function notifyClient(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
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
