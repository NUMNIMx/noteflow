/* 110811 Room Note — Service Worker */
const CACHE_NAME = '110811-room-note-v4';
const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './firebase-config.js',
    './manifest.json',
    './icon-192.png',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Lora:ital,wght@0,400;0,600;1,400&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
];

// Install: Cache all static assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

// Activate: Clean old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Fetch: Cache-first for local assets, network-first for remote
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // Always network for non-GET
    if (e.request.method !== 'GET') return;

    if (url.origin === location.origin) {
        // Cache-first for local files
        e.respondWith(
            caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
                const clone = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                return res;
            }))
        );
    } else {
        // Network-first for fonts/CDN
        e.respondWith(
            fetch(e.request).catch(() => caches.match(e.request))
        );
    }
});
