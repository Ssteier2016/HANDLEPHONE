// Nombre del caché. Debe actualizarse cada vez que cambies los archivos estáticos.
const CACHE_NAME = 'crypto-tracker-cache-v1';

// Lista de archivos para precargar al instalar la PWA
// Nota: 'crypto-tracker.html' se refiere al archivo principal (index) en el entorno Canvas.
const urlsToCache = [
    '/',
    '/index.html',
    '/manifest.json',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.tailwindcss.com'
];

// Instalación: Almacena todos los archivos necesarios en el caché.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Service Worker: Cache abierto.');
                // Precarga el contenido estático
                return cache.addAll(urlsToCache);
            })
            .catch(err => {
                console.error('Service Worker: Error al precargar archivos:', err);
            })
    );
});

// Activación: Elimina cachés antiguos para liberar espacio.
self.addEventListener('activate', (event) => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        console.log('Service Worker: Eliminando caché antiguo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Intercepta peticiones: Estrategia de "Cache-First, luego Network"
// Intenta responder con el caché; si falla, va a la red.
self.addEventListener('fetch', (event) => {
    // Excluir peticiones de API (CoinGecko, Alpha Vantage)
    if (event.request.url.includes('api.coingecko.com') || event.request.url.includes('alphavantage.co')) {
        return fetch(event.request);
    }

    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // Devuelve el recurso desde el caché si se encuentra.
                if (response) {
                    return response;
                }
                // Si no se encuentra en caché, intenta obtenerlo de la red.
                return fetch(event.request);
            })
            .catch(() => {
                // Esta parte se ejecuta si la red también falla (i.e., completamente offline)
                // Se podría servir una página offline aquí si tuviéramos una.
                console.log('Service Worker: Error de red y caché no encontrado.');
            })
    );
});

