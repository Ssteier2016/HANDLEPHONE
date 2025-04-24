// sw.js
// Service Worker para cacheo offline y sincronización

const CACHE_NAME = 'handyhandle-cache-v6'; // Incrementar versión para limpiar caché antigua
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
    // Nota: Eliminé recursos potencialmente inexistentes como logoutred.png, volver.png, mute.png, mic.png, airplane.png
    // Añade solo los que existan en /templates/
];

self.addEventListener('install', event => {
    console.log('Instalando Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Cache abierto:', CACHE_NAME);
                // Cachear recursos uno por uno para identificar fallos
                return Promise.all(
                    urlsToCache.map(url => {
                        return fetch(url, { method: 'GET' })
                            .then(response => {
                                if (!response.ok) {
                                    console.warn(`No se pudo cachear ${url}: ${response.status}`);
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

    // Excluir endpoints dinámicos y WebSocket
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

    // Manejo especial para /aep_flights
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

    // Manejo de tiles de OpenStreetMap
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

    // Manejo general de recursos
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
            if (now - cachedTime > 60 * 60 * 1000) { // 1 hora
                await cache.delete(request);
                console.log('Eliminado tile antiguo:', request.url);
            }
        }
    }
            }
