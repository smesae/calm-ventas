// CALM B2B — Service Worker DESACTIVADO durante desarrollo.
// Se auto-elimina y limpia cachés para que siempre se sirva el código más nuevo.
// (El caché offline se reactiva recién al publicar la versión final.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', async (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll();
    clients.forEach(c => c.navigate(c.url));
  })());
});
