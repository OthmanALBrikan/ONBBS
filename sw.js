// ONBBS MACHINE SHOP - Offline-First & Background Notification Service Worker (sw.js)
const APP_SHELL_CACHE = "onbbs-app-shell-v11";
const SNAP_CACHE = "onbbs-bg-state-v1";
const SHELL_ASSETS = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== APP_SHELL_CACHE && k !== SNAP_CACHE) {
            return caches.delete(k);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Serve index.html instantaneously from cache on startup (prevents 500 & ERR_NAME_NOT_RESOLVED)
// and refresh cache silently in background when network is ready
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Only cache same-origin app shell files; let Firebase/ntfy/Sheets go straight to network
  if (url.origin === self.location.origin && (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html"))) {
    event.respondWith(
      caches.open(APP_SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match("./index.html") || await cache.match(req);
        const networkFetch = fetch(req).then((networkRes) => {
          if (networkRes && networkRes.ok && networkRes.status === 200) {
            cache.put("./index.html", networkRes.clone()).catch(() => {});
          }
          return networkRes;
        }).catch(() => null);

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }
        const net = await networkFetch;
        return net || new Response("<h1>ONBBS MACHINE SHOP</h1><p>جاري إعادة الاتصال...</p>", {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      })
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    })
  );
});

async function runBackgroundAlertScan() {
  try {
    const cache = await caches.open(SNAP_CACHE);
    const resp = await cache.match("https://onbbs-local-state/snapshot.json");
    if (!resp) return;
    const snap = await resp.json();
    const todayISO = new Date().toISOString().slice(0, 10);
    const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
    const notified = snap.notifiedMap || {};
    const acked = snap.acknowledgedAlerts || {};
    let dirty = false;

    if (snap.syncConfig && snap.syncConfig.enabled && snap.syncConfig.provider === "firebase" && snap.syncConfig.firebaseUrl) {
      try {
        const base = String(snap.syncConfig.firebaseUrl).trim().replace(/\/+$/, "");
        const room = String(snap.syncConfig.firebaseRoom || "onbbs_main_workshop").replace(/[.#$\/\[\]\s]+/g, "_");
        const r = await fetch(base + "/" + room + ".json");
        if (r.ok) {
          const remote = await r.json();
          if (remote) {
            if (Array.isArray(remote.items)) snap.inventory = remote.items;
            if (Array.isArray(remote.payments)) snap.payments = remote.payments;
            if (Array.isArray(remote.schedules)) snap.schedules = remote.schedules;
          }
        }
      } catch (netErr) {}
    }

    (snap.schedules || []).forEach((s) => {
      if (!s || s.status === "completed" || s.status === "in_progress" || !s.startDate) return;
      const parts = String(s.startDate).split("-").map(Number);
      if (parts.length !== 3) return;
      const target = new Date(parts[0], parts[1] - 1, parts[2]);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diff = Math.round((target - today) / 86400000);
      const remWin = Number(s.remindDays ?? 1);
      if (diff <= remWin) {
        if (diff === 0 && s.startTime) {
          const [hh, mm] = String(s.startTime).split(":").map(Number);
          if (!isNaN(hh) && nowMins < (hh * 60 + (mm || 0) - 30)) return;
        }
        const sig = ("sched_" + s.id + "_" + s.startDate + "_" + s.status).replace(/[.#$\/\[\]\s]+/g, "_");
        const dKey = sig + "_" + todayISO;
        if (!acked[sig] && !notified[dKey]) {
          notified[dKey] = Date.now();
          dirty = true;
          const dd = String(parts[2]).padStart(2, "0");
          const mmStr = String(parts[1]).padStart(2, "0");
          self.registration.showNotification("⏰ تذكير بدء عمل: " + s.title, {
            body: "التاريخ: " + dd + "/" + mmStr + "/" + parts[0] + (s.startTime ? " • الساعة " + s.startTime : ""),
            tag: dKey,
            renotify: true,
            requireInteraction: true,
            dir: "rtl",
            lang: "ar"
          });
        }
      }
    });

    (snap.payments || []).forEach((p) => {
      if (!p || p.paidForCycle || !p.dueDate) return;
      const due = new Date(p.dueDate + "T00:00:00");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diff = Math.round((due - today) / 86400000);
      if (diff <= Number(p.remindDays ?? 3)) {
        const sig = ("pay_" + p.id + "_" + p.dueDate + "_" + (p.paidInstallments || 0)).replace(/[.#$\/\[\]\s]+/g, "_");
        const dKey = sig + "_" + todayISO;
        if (!acked[sig] && !notified[dKey]) {
          notified[dKey] = Date.now();
          dirty = true;
          const dp = String(p.dueDate).split("-");
          const fmtDue = dp.length === 3 ? (dp[2] + "/" + dp[1] + "/" + dp[0]) : p.dueDate;
          self.registration.showNotification("💳 تذكير دفعة: " + p.title, {
            body: "المبلغ: " + p.amount + " ر.س • الاستحقاق: " + fmtDue,
            tag: dKey,
            renotify: true,
            requireInteraction: true,
            dir: "rtl",
            lang: "ar"
          });
        }
      }
    });

    (snap.inventory || []).forEach((it) => {
      if (!it) return;
      const q = Number(it.qty) || 0;
      const m = Number(it.minQty) || 0;
      if (q <= m) {
        const sig = ("low_" + it.code + "_" + q + "_" + m).replace(/[.#$\/\[\]\s]+/g, "_");
        const dKey = sig + "_" + todayISO;
        if (!acked[sig] && !notified[dKey]) {
          notified[dKey] = Date.now();
          dirty = true;
          self.registration.showNotification("📦 تنبيه نقص مخزون: " + it.name, {
            body: "الرمز: " + it.code + " • المتوفر: " + q + " (الحد الأدنى: " + m + ")",
            tag: dKey,
            renotify: true,
            dir: "rtl",
            lang: "ar"
          });
        }
      }
    });

    if (dirty) {
      snap.notifiedMap = notified;
      await cache.put(
        new Request("https://onbbs-local-state/snapshot.json"),
        new Response(JSON.stringify(snap), { headers: { "Content-Type": "application/json" } })
      );
    }
  } catch (err) {}
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "onbbs-periodic-alerts") {
    event.waitUntil(runBackgroundAlertScan());
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "onbbs-bg-check") {
    event.waitUntil(runBackgroundAlertScan());
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CHECK_ALERTS_NOW") {
    event.waitUntil(runBackgroundAlertScan());
  }
});
