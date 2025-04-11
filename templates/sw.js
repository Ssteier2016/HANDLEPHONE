// Nombre del caché para esta versión del Service Worker
const CACHE_NAME = 'handlephone-cache-v1';

// Recursos que se cachearán para soporte offline
const urlsToCache = [
    '/',
    '/templates/index.html',
    '/templates/script.js',
    '/templates/style.css',
    '/templates/walkie-talkie.png',
    '/templates/airport.png',
    '/templates/aero.png'
];

// Evento 'install': Se ejecuta cuando el Service Worker se instala
self.addEventListener('install', (event) => {
    console.log('Service Worker instalado');
    // Cachear los recursos estáticos
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Cacheando recursos');
            return cache.addAll(urlsToCache);
        }).catch((err) => {
            console.error('Error al cachear recursos:', err);
        })
    );
    // Forzar la activación inmediata del Service Worker
    self.skipWaiting();
});

// Evento 'activate': Se ejecuta cuando el Service Worker se activa
self.addEventListener('activate', (event) => {
    console.log('Service Worker activado');
    // Limpiar cachés antiguos
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Eliminando caché antiguo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).catch((err) => {
            console.error('Error al limpiar cachés antiguos:', err);
        })
    );
    // Tomar control de las páginas inmediatamente
    self.clients.claim();
});

// Evento 'fetch': Maneja las solicitudes de red
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            if (response) {
                console.log('Sirviendo desde caché:', event.request.url);
                return response; // Devuelve el recurso desde el caché
            }
            return fetch(event.request).catch(() => {
                // Si no hay conexión y el recurso no está en caché, devuelve la página principal
                console.log('No hay conexión, sirviendo fallback:', event.request.url);
                return caches.match('/templates/index.html');
            });
        })
    );
});

// Evento 'push': Maneja las notificaciones push
self.addEventListener('push', (event) => {
    let data;
    try {
        data = event.data.json();
    } catch (err) {
        console.error('Error al parsear datos de notificación push:', err);
        return;
    }

    if (data.type === 'audio') {
        const title = 'Nuevo mensaje de voz';
        const options = {
            body: `${data.sender || 'Usuario'} (${data.function || 'Función desconocida'}): ${data.text || 'Mensaje de voz recibido'}`,
            icon: '/templates/walkie-talkie.png',
            badge: '/templates/walkie-talkie.png',
            data: {
                url: 'https://handlephone.onrender.com/'
            },
            tag: 'audio-message', // Agrupar notificaciones
            renotify: true // Hacer que la notificación vibre/sonide incluso si ya existe
        };
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
});

// Evento 'notificationclick': Maneja el clic en una notificación
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data.url || 'https://handlephone.onrender.com/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Si hay una ventana abierta, enfocarla
            for (const client of clientList) {
                if (client.url === url && 'focus' in client) {
                    return client.focus();
                }
            }
            // Si no hay ventanas abiertas, abrir una nueva
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

// Evento 'sync': Maneja la sincronización en segundo plano
self.addEventListener('sync', (event) => {
    if (event.tag === 'reconnect-websocket') {
        event.waitUntil(
            clients.matchAll({ type: 'window' }).then((clientList) => {
                for (const client of clientList) {
                    client.postMessage({ type: 'reconnect-websocket' });
                }
            })
        );
    }
});
