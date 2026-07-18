const CACHE_NAME = 'handyhandle-cache-v15';
const MESSAGE_QUEUE = 'handyhandle-message-queue';
const SYNC_TAG = 'sync-messages';
const API_CACHE = 'api-cache-v15';
const MAX_MESSAGE_AGE = 24 * 60 * 60 * 1000;

const urlsToCache = [
    '/',
    '/templates/index.html',
    '/templates/style.css',
    '/templates/script.js',
    '/templates/manifest.json',
    '/templates/aero.png',
    '/templates/airport.png',
    '/templates/icon-192x192.png',
    '/templates/app-logo.png',
    '/templates/airplane.png'
];

self.addEventListener('install', event => {
    console.log('Service Worker v5 instalando...');
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Cache abierto:', CACHE_NAME);
            return cache.addAll(urlsToCache).catch(err => {
                console.warn('Error al precargar (no crítico):', err);
            });
        })
    );
    // Forzar activación inmediata sin esperar a que cierren tabs viejos
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('Service Worker v5 activado - limpiando caches antiguos');
    event.waitUntil(
        Promise.all([
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        // Delete ALL old caches - keep only the current versions
                        if (cacheName !== CACHE_NAME && cacheName !== API_CACHE) {
                            console.log('Eliminando cache antiguo:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            self.clients.claim() // Take control of all pages immediately
        ])
    );
});

self.addEventListener('fetch', event => {
    // Solo interceptar peticiones GET (evita errores con POST de login/registro)
    if (event.request.method !== 'GET') {
        return;
    }
    const requestUrl = new URL(event.request.url);
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
    // Network-First strategy for core application files and assets
    const isAppCoreFile = requestUrl.pathname === '/' || 
                          requestUrl.pathname.includes('/templates/script.js') || 
                          requestUrl.pathname.includes('/templates/style.css') || 
                          requestUrl.pathname.includes('/templates/index.html') ||
                          requestUrl.pathname.includes('/api/');

    if (isAppCoreFile) {
        event.respondWith(
            fetch(event.request).then(networkResponse => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            }).catch(() => {
                console.log('Sirviendo recurso principal desde cache offline:', event.request.url);
                return caches.match(event.request);
            })
        );
        return;
    }

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

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'QUEUE_MESSAGE') {
        queueMessage(event.data.message);
    } else if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('sync', event => {
    if (event.tag === SYNC_TAG) {
        event.waitUntil(syncMessages());
    }
});

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

// PWA Widget lifecycle handlers
self.addEventListener('widgetinstall', event => {
    console.log('Widget instalado:', event.widget.tag);
    event.waitUntil(
        self.widgets.updateByTag('ptt-widget', {
            template: 'ptt-widget-template',
            data: { title: 'HandlePhone PTT', status: 'Listo para grabar' }
        })
    );
});

self.addEventListener('widgetclick', event => {
    if (event.action === 'ptt-start') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window' }).then(windowClients => {
                if (windowClients.length > 0) {
                    windowClients[0].focus();
                    windowClients[0].postMessage({ type: 'PTT_WIDGET_START' });
                } else {
                    self.clients.openWindow('/#ptt-widget-action');
                }
            })
        );
    }
});
