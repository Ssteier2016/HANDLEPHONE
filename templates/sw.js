const CACHE_NAME = 'handyhandle-cache-v3';
const MESSAGE_QUEUE = 'handyhandle-message-queue';
const SYNC_TAG = 'sync-messages'; // Cambiado a 'sync-messages' para coincidir con el SW básico
const API_CACHE = 'api-cache';
const MAX_MESSAGE_AGE = 24 * 60 * 60 * 1000; // 24 horas

const urlsToCache = [
    '/',
    '/templates/index.html',
    '/templates/style.css',
    '/templates/script.js',
    '/templates/manifest.json',
    '/templates/aero.png',
    '/templates/airport.png',
    '/templates/logoutred.png',
    '/templates/icon-192x192.png',
    '/templates/icon-512x512.png',
    '/templates/walkie-talkie.png',
    '/templates/volver.png',
    '/templates/mic.png',
    '/templates/mute.png',
    '/templates/mic-off.png',
    '/templates/mic-on.png'
];

// Instalar el Service Worker
self.addEventListener('install', event => {
    console.log('Service Worker instalado');
    event.waitUntil(
        Promise.all([
            caches.open(CACHE_NAME).then(cache => {
                console.log('Cache abierto:', CACHE_NAME);
                return cache.addAll(urlsToCache);
            }),
            caches.open('v1').then(cache => {
                console.log('Cache v1 abierto para compatibilidad');
                return cache.addAll([
                    '/',
                    '/templates/index.html',
                    '/templates/style.css',
                    '/templates/script.js'
                ]);
            })
        ]).catch(err => {
            console.error('Error al abrir caches:', err);
        })
    );
    self.skipWaiting();
});

// Activar el Service Worker
self.addEventListener('activate', event => {
    console.log('Service Worker activado');
    event.waitUntil(
        Promise.all([
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME && cacheName !== API_CACHE && cacheName !== 'v1') {
                            console.log('Eliminando cache antiguo:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            self.clients.claim()
        ])
    );
});

// Interceptar solicitudes
self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);

    // No cachear WebSocket ni rutas dinámicas
    if (requestUrl.protocol === 'wss:' ||
        requestUrl.pathname === '/opensky' ||
        requestUrl.pathname === '/aa2000_flights' ||
        requestUrl.pathname === '/history' ||
        requestUrl.pathname === '/flightradar24') {
        event.respondWith(
            fetch(event.request).catch(err => {
                console.error('Error en fetch:', err);
                return new Response('Offline', { status: 503 });
            })
        );
        return;
    }

    // Manejar solicitudes a FlightRadar24
    if (requestUrl.href.includes('api.flightradar24.com')) {
        event.respondWith(
            caches.open(API_CACHE).then(cache => {
                return fetch(event.request).then(response => {
                    if (response.status === 200) {
                        cache.put(event.request, response.clone());
                        console.log('Cacheando Flightradar24:', requestUrl.href);
                    }
                    return response;
                }).catch(() => {
                    console.log('Sirviendo Flightradar24 desde caché:', requestUrl.href);
                    return cache.match(event.request) || new Response('Offline', { status: 503 });
                });
            })
        );
        return;
    }

    // Manejar otras solicitudes
    event.respondWith(
        caches.match(event.request).then(response => {
            if (response) {
                console.log('Sirviendo desde cache:', event.request.url);
                return response;
            }
            return fetch(event.request).then(networkResponse => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, networkResponse.clone());
                    return networkResponse;
                });
            }).catch(() => {
                console.error('Error al obtener recurso:', event.request.url);
                return caches.match('/templates/index.html') || new Response('Offline', { status: 503 });
            });
        })
    );
});

// Manejar mensajes desde script.js
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'QUEUE_MESSAGE') {
        queueMessage(event.data.message);
    } else if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Sincronización
self.addEventListener('sync', event => {
    if (event.tag === SYNC_TAG) {
        event.waitUntil(syncMessages());
    }
});

// Almacenar mensaje en IndexedDB
async function queueMessage(message) {
    try {
        const db = await openDB();
        const tx = db.transaction(MESSAGE_QUEUE, 'readwrite');
        const store = tx.objectStore(MESSAGE_QUEUE);
        const messageWithTimestamp = { ...message, timestamp: Date.now() };
        await store.add(messageWithTimestamp);
        await tx.done;
        console.log('Mensaje encolado:', messageWithTimestamp);
    } catch (err) {
        console.error('Error al encolar mensaje:', err);
    }
}

// Sincronizar mensajes
async function syncMessages() {
    try {
        console.log('Sincronizando mensajes');
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
                console.log('Sincronizando mensaje:', message);
                await notifyClient({ ...message, priority: message.priority || 'normal' });
                await store.delete(message.id);
            } catch (err) {
                console.error('Error al sincronizar mensaje:', message, err);
            }
        }
        await tx.done;

        const clients = await self.clients.matchAll();
        clients.forEach(client => {
            client.postMessage({ type: 'SYNC_COMPLETE' });
        });
    } catch (err) {
        console.error('Error en syncMessages:', err);
    }
}

// Notificar al cliente
async function notifyClient(message) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    if (clients.length === 0) {
        console.warn('No hay clientes activos:', message);
        return;
    }
    clients.forEach(client => {
        client.postMessage({ type: 'SEND_MESSAGE', message });
    });
}

// Abrir IndexedDB
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('handyhandle-db', 1);
        request.onupgradeneeded = event => {
            const db = event.target.result;
            db.createObjectStore(MESSAGE_QUEUE, { keyPath: 'id', autoIncrement: true });
        };
        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => reject(event.target.error);
    });
}

// Manejo de notificaciones push
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
    event.waitUntil(clients.openWindow('/'));
});
