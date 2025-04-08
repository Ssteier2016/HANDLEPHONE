self.addEventListener('install', (event) => {
    console.log('Service Worker instalado');
    // Forzar la activación inmediata del Service Worker
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activado');
    // Tomar control de las páginas inmediatamente
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Manejar las solicitudes de red (fetch) de manera predeterminada
    event.respondWith(fetch(event.request));
});

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
            }
        };
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
});

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
