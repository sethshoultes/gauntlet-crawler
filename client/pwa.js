// PWA glue (#33): registers the service worker, captures the install prompt and shows an
// "Install app" button when the browser offers one, and shows a small "reload for the latest
// version?" toast after a new service worker takes over. Nothing else lives here — see README
// "Install as an app".
//
// Every HTML page under client/ loads this as `<script type="module" src="/pwa.js">` right after
// its manifest link in <head>. Pass `?nosw=1` in the URL to opt a page load out entirely: the
// smoke/e2e test harnesses use this so a cached shell from a previous run can never mask the very
// code change those tests exist to catch. The dedicated PWA e2e scenario (test/e2e.mjs) is the one
// page load that omits it, to exercise registration and offline for real.

const params = new URLSearchParams(location.search);
const disabled = params.get('nosw') === '1';
const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';

function showInstallButton(promptEvent) {
  if (document.getElementById('pwa-install')) return; // beforeinstallprompt can fire more than once
  const slot = document.getElementById('pwa-install-slot');
  const btn = document.createElement('button');
  btn.id = 'pwa-install';
  btn.type = 'button';
  btn.textContent = 'Install app';
  if (!slot) {
    // No page currently reserves a slot for this — append a small self-contained fixed button
    // rather than editing any page's markup.
    btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;';
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    promptEvent.prompt();
    try { await promptEvent.userChoice; } finally { btn.remove(); }
  });
  (slot || document.body).appendChild(btn);
}

function showUpdateToast() {
  if (document.getElementById('pwa-update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'pwa-update-toast';
  toast.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;'
    + 'display:flex;gap:10px;align-items:center;background:#15151f;border:2px solid #2b2b3d;'
    + 'color:#e8e6d8;padding:10px 14px;font:12px "Courier New",Courier,monospace;';
  const msg = document.createElement('span');
  msg.textContent = 'Updated — reload for the latest version.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  toast.append(msg, btn);
  document.body.appendChild(toast);
}

if (!disabled) {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    showInstallButton(event);
  });
  window.addEventListener('appinstalled', () => {
    document.getElementById('pwa-install')?.remove();
  });

  // Service workers require a secure context: real HTTPS in production, or localhost/127.0.0.1
  // in dev (Playwright's e2e harness runs on http://127.0.0.1, which browsers also treat as
  // secure — hence the ?nosw=1 escape hatch above for the tests that don't want it).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || isLocalhost)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { type: 'module' }).then(() => {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'gauntlet-sw-updated') showUpdateToast();
        });
      }).catch(() => {}); // offline support is a nice-to-have; never block the app on it
    });
  }
}
