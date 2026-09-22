// Чтение контента из Google-таблицы. Используется и тестом, и страницами документов.
window.SheetLoader = (function () {
  "use strict";

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const keys = rows[0].map(h => h.trim());
    return rows.slice(1)
      .filter(r => r.some(v => v.trim() !== ""))
      .map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || "").trim()])));
  }

  async function fetchSheet(sheetId, name, signal) {
    const url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(sheetId) +
      "/gviz/tq?tqx=out:csv&headers=1&sheet=" + encodeURIComponent(name);
    const res = await fetch(url, { signal, cache: "no-store" });
    if (!res.ok) throw new Error(name + ": HTTP " + res.status);
    return parseCSV(await res.text());
  }

  async function fetchSheets(sheetId, names, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 5000);
    try {
      const entries = await Promise.all(
        Object.entries(names).map(async ([key, name]) => [key, await fetchSheet(sheetId, name, ctrl.signal)]));
      return Object.fromEntries(entries);
    } finally {
      clearTimeout(timer);
    }
  }

  return { parseCSV, fetchSheet, fetchSheets };
})();
