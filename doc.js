// Страницы «Политика конфиденциальности» и «Согласие на обработку персональных данных».
(async function () {
  "use strict";

  const CFG = window.TEST_CONFIG || {};
  const kind = document.body.dataset.doc;
  const titleKey = kind === "policy" ? "footer.policy" : "footer.consent";
  const textKey = kind === "policy" ? "legal.policy" : "legal.consent";

  let texts = Object.assign({}, (window.TEST_CONTENT || {}).texts || {});
  if (CFG.sheetId) {
    try {
      const data = await window.SheetLoader.fetchSheets(CFG.sheetId, { texts: "Тексты" }, CFG.sheetTimeoutMs);
      data.texts.forEach(r => { if (r["Ключ"]) texts[r["Ключ"]] = r["Текст"] || ""; });
    } catch (e) {
      console.warn("Тексты из Google-таблицы не загружены, используется встроенная копия:", e);
    }
  }

  const title = (texts[titleKey] || "").trim();
  const body = (texts[textKey] || "").trim();
  document.title = title || document.title;
  document.getElementById("doc-title").textContent = title;

  const target = document.getElementById("doc-body");
  target.innerHTML = "";
  const content = body || "Текст будет добавлен в ближайшее время.";
  content.split(/\n+/).map(p => p.trim()).filter(Boolean).forEach(p => {
    const el = document.createElement("p");
    el.textContent = p;
    target.appendChild(el);
  });

  document.getElementById("loading").hidden = true;
  document.getElementById("doc").hidden = false;
})();
