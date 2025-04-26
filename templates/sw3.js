// /sw.js
const CACHE_NAME = 'handyhandle-cache-v7';
const MESSAGE_QUEUE = 'handyhandle-message-queue';
const SYNC_TAG = 'handyhandle-sync';
const MAX_MESSAGE_AGE = 24 * 60 * 60 * 1000; // 24 horas
const FLIGHT_CACHE_TTL = 10 * 60 * 1000; // 10 minutos

const urlsToCache = [
    '/',
    '/templates/index.html',
    '/templates/style.css',
    '/templates/script.js',
    '/templates/manifest.json',
    '/templates/aero.png',
    '/templates/airport.png',
    '/templates/mic-off.png',
    '/templates/mic-on.png',
    '/templates/logo2.png',
    '/templates/icon-192x192.png',
    '/templates/icon-384x384.png',
    '/templates/icon-512x512.png',
    '/templates/icon-maskable-192x192.png',
    '/templates/introvideo.mp4'
];

self.addEventListener('install', event => {
    console.log('Instalando Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Cache abierto:', CACHE_NAME);
                return Promise.all(
                    urlsToCache.map(url => {
                        return fetch(url, { method: 'GET' })
                            .then(response => {
                                if (!response.ok) {
                                    console.warn(`No se pudo cachear ${url}: ${response.status} ${response.statusText}`);
                                    return;
                                }
                                return cache.put(url, response);
                            })
                            .catch(err => {
                                console.warn(`Error al cachear ${url}:`, err);
                            });
                    })
                );
            })
            .catch(err => {
                console.error('Error al abrir cache:', err);
            })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('Activando Service Worker...');
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

self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);
    console.log('Fetch:', requestUrl.pathname);

    if (
        requestUrl.protocol === 'wss:' ||
        requestUrl.pathname === '/opensky' ||
        requestUrl.pathname === '/aep_flights' ||
        requestUrl.pathname === '/history' ||
        requestUrl.pathname === '/login' ||
        requestUrl.pathname === '/register' ||
        requestUrl.pathname === '/subscribe'
    ) {
        event.respondWith(
            fetch(event.request).catch(err => {
                console.error('Error en fetch de red:', requestUrl.pathname, err);
                return new Response('No hay conexión a internet. Los datos en tiempo real no están disponibles.', { status: 503 });
            })
        );
        return;
    }

    if (requestUrl.pathname === '/aep_flights') {
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) {
                        const cachedTime = new Date(cachedResponse.headers.get('date')).getTime();
                        if (Date.now() - cachedTime < FLIGHT_CACHE_TTL) {
                            console.log('Sirviendo /aep_flights desde cache:', requestUrl.pathname);
                            return cachedResponse;
                        }
                    }
                    return fetch(event.request)
                        .then(networkResponse => {
                            if (!networkResponse || networkResponse.status !== 200) {
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
                            console.error('Error al obtener /aep_flights:', err);
                            return cachedResponse || new Response('No hay conexión a internet. Usando datos cacheados o sin datos disponibles.', { status: 503 });
                        });
                })
        );
        return;
    }

    if (requestUrl.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(
            caches.match(event.request)
                .then(response => {
                    if (response) {
                        console.log('Sirviendo tile de OpenStreetMap desde cache:', requestUrl.pathname);
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
                                    cleanOldTiles();
                                });
                            return networkResponse;
                        })
                        .catch(err => {
                            console.error('Error al obtener tile de OpenStreetMap:', err);
                            return new Response('No hay conexión a internet. Mapa sin tiles disponibles.', { status: 503 });
                        });
                })
        );
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    console.log('Sirviendo desde cache:', requestUrl.pathname);
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
                        console.error('Error al obtener recurso:', requestUrl.pathname, err);
                        if (event.request.destination === 'document') {
                            return caches.match('/templates/index.html');
                        }
                        return new Response('No hay conexión a internet. Algunos recursos no están disponibles.', { status: 503 });
                    });
            })
    );
});

async function cleanOldTiles() {
    console.log('Limpiando tiles antiguos de OpenStreetMap...');
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const now = Date.now();
    for (const request of requests) {
        if (request.url.includes('tile.openstreetmap.org')) {
            const response = await cache.match(request);
            const cachedTime = new Date(response.headers.get('date')).getTime();
            if (now - cachedTime > 60 * 60 * 1000) {
                await cache.delete(request);
                console.log('Eliminado tile antiguo de OpenStreetMap:', request.url);
            }
        }
    }
}

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'QUEUE_MESSAGE') {
        console.log('Recibiendo mensaje para encolar:', event.data.message);
        queueMessage(event.data.message);
    }
});

self.addEventListener('sync', event => {
    if (event.tag === SYNC_TAG) {
        console.log('Iniciando sincronización en segundo plano...');
        event.waitUntil(syncMessages());
    }
});

async function queueMessage(message) {
    console.log('Encolando mensaje:', message);
    try {
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
    } catch (err) {
        console.error('Error al encolar mensaje:', err);
    }
}

async function syncMessages() {
    console.log('Sincronizando mensajes pendientes...');
    try {
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
                if (message.type === 'logout') {
                    console.log('Sincronizando logout:', message);
                    await sendToServer(message, '/logout');
                    await store.delete(message.id);
                } else if (message.type === 'create_group') {
                    console.log('Sincronizando create_group:', message);
                    await sendToServer(message, '/create_group');
                    await store.delete(message.id);
                } else if (message.type === 'message' || message.type === 'group_message') {
                    console.log('Sincronizando mensaje de audio:', message);
                    await sendToServer(message, '/ws/' + message.session_token);
                    await store.delete(message.id);
                } else {
                    console.log('Sincronizando mensaje genérico:', message);
                    await sendToServer(message, '/generic');
                    await store.delete(message.id);
                }
                await notifyClient({ ...message, status: 'sent' });
            } catch (err) {
                console.error('Error al sincronizar mensaje:', message, err);
            }
        }
        await tx.done;

        self.clients.matchAll().then(clients => {
            clients.forEach(client => {
                client.postMessage({ type: 'SYNC_COMPLETE' });
            });
        });
    } catch (err) {
        console.error('Error en sincronización:', err);
    }
}

async function sendToServer(message, endpoint) {
    console.log('Enviando mensaje al servidor:', message, endpoint);
    if (message.type === 'message' || message.type === 'group_message') {
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                const ws = new WebSocket('wss://' + self.location.host + endpoint);
                return await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        ws.close();
                        reject(new Error('WebSocket timeout'));
                    }, 5000);
                    ws.onopen = () => {
                        ws.send(JSON.stringify(message));
                        clearTimeout(timeout);
                        ws.close();
                        resolve();
                    };
                    ws.onerror = err => {
                        clearTimeout(timeout);
                        reject(err);
                    };
                });
            } catch (err) {
                attempts++;
                console.error(`Intento ${attempts} fallido para WebSocket:`, err);
                if (attempts === maxAttempts) throw err;
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            }
        }
    } else {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(message)
            });
            if (!response.ok) {
                throw new Error('Error al enviar mensaje al servidor: ' + response.status);
            }
        } catch (err) {
            console.error('Error al enviar mensaje HTTP:', err);
            throw err;
        }
    }
}

async function notifyClient(message) {
    console.log('Notificando al cliente:', message);
    try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        if (clients.length === 0) {
            console.warn('No hay clientes activos para procesar mensaje:', message);
            return;
        }
        for (const client of clients) {
            client.postMessage({ type: 'SEND_MESSAGE', message });
        }
    } catch (err) {
        console.error('Error al notificar al cliente:', err);
    }
}

function openDB() {
    console.log('Abriendo base de datos IndexedDB...');
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
            console.error('Error al abrir IndexedDB:', event.target.error);
            reject(event.target.error);
        };
    });
}

self.addEventListener('push', event => {
    console.log('Recibiendo notificación push...');
    let data;
    try {
        data = event.data ? event.data.json() : { title: 'Handyhandle', body: 'Nuevo mensaje o vuelo recibido' };
    } catch (err) {
        console.error('Error al parsear datos de push:', err);
        data = { title: 'Handyhandle', body: 'Nuevo mensaje o vuelo recibido' };
    }
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/templates/icon-192x192.png',
            badge: '/templates/icon-192x192.png',
            data: { url: '/' }
        })
    );
});

self.addEventListener('notificationclick', event => {
    console.log('Notificación clickeada');
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});
