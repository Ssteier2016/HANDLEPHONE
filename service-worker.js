self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    clients.claim();
});

self.addEventListener('fetch', event => {
    // Mantener conexión viva
    if (event.request.url.includes('/socket.io/')) {
        return;
    }
    event.respondWith(fetch(event.request));
});

// Notificaciones push (si se implementa en el futuro)
self.addEventListener('push', event => {
    const data = event.data ? event.data.text() : 'Mensaje nuevo';
    event.waitUntil(
        self.registration.showNotification('Walkie-Talkie', {
            body: data,
            icon: '/icon.png'
        })
    );
});
