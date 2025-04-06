self.addEventListener('install', (event) => {
    console.log('Service Worker instalado');
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activado');
});

self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
    const data = event.data.json();
    if (data.type === 'audio') {
        self.registration.showNotification('Nuevo mensaje de voz', {
            body: 'Tienes un nuevo mensaje de voz en HANDLEPHONE.',
            icon: '/templates/walkie-talkie.png'
        });
    }
});
