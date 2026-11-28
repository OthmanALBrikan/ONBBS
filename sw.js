// ONBBS MACHINE SHOP - Background Notification Service Worker (sw.js)
const SNAP_CACHE = "onbbs-bg-state-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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

    // Pull latest data from Firebase while app is closed
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

    // 1. Work Start Schedules
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

    // 2. Monthly Payments & Installments
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

    // 3. Low Stock Items
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
