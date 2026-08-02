// Minimal service worker for the Anuanom 2016 Welfare Portal.
//
// This does NOT cache anything or provide offline support — the portal
// needs a live connection to Firebase to be useful anyway. Its only job is
// to satisfy the browser's technical requirement (a registered service
// worker with a fetch handler) for "Add to Home Screen" / install
// eligibility on Android and desktop Chrome/Edge.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally empty — pass every request straight through to the network.
});
