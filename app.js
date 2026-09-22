(function () {
  "use strict";

  const CFG = window.TEST_CONFIG || {};
  const FALLBACK = window.TEST_CONTENT;
  const SHEETS = { questions: "Вопросы", scenarios: "Сценарии", variants: "Варианты", texts: "Тексты", settings: "Настройки" };

  const METHODS = {
    telegram: { label: "Telegram", ph: "form.ph_telegram", err: "нужен @username или номер телефона.",
      check: v => /^@?[A-Za-z0-9_]{5,32}$/.test(v) || isPhone(v) },
    whatsapp: { label: "WhatsApp", ph: "form.ph_whatsapp", err: "нужен номер телефона.", check: v => isPhone(v) },
    vk: { label: "ВКонтакте", ph: "form.ph_vk", err: "укажи ссылку или короткое имя страницы.", check: v => v.length >= 3 }
  };
  const CHANNEL_LINKS = [["telegram", "Telegram"], ["whatsapp", "WhatsApp"], ["vk", "ВКонтакте"]];

  let C = FALLBACK;
  let source = "fallback";
  let order = [];
  let answers = {};
  let idx = 0;
  let locked = false;
  let method = "telegram";

  const $ = s => document.querySelector(s);
  const t = k => String((C.texts && C.texts[k]) || "").trim();

  function isPhone(v) {
    const d = v.replace(/\D/g, "");
    return /^[+\d\s()-]+$/.test(v) && d.length >= 10 && d.length <= 15;
  }

  function isBlank(v) {
    const x = String(v || "").trim().toLowerCase();
    return !x || x.startsWith("будет дописан") || x.startsWith("см. отдельный лист") || x.startsWith("→");
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fill(node, text) {
    node.innerHTML = "";
    String(text || "").split(/\n+/).map(p => p.trim()).filter(Boolean).forEach(p => node.appendChild(el("p", null, p)));
  }

  function setText(sel, key) {
    const node = $(sel);
    node.textContent = t(key);
    node.hidden = isBlank(t(key));
  }

  function normLink(kind, v) {
    v = String(v || "").trim();
    if (!v) return "";
    if (kind === "whatsapp" && !/^https?:/i.test(v)) {
      let d = v.replace(/\D/g, "");
      if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
      return d ? "https://wa.me/" + d : "";
    }
    return /^https?:\/\//i.test(v) ? v : "https://" + v.replace(/^\/+/, "");
  }

  // ── Загрузка контента из Google-таблицы ──

  const num = v => {
    const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const yes = v => ["да", "yes", "1", "true"].includes(String(v).trim().toLowerCase());

  function fromSheets(s) {
    const questions = s.questions.map(r => {
      const scored = yes(r["Участвует в расчёте"]);
      const w = num(r["Вес"]);
      return { n: num(r["№"]), text: r["Текст вопроса"], scenario: scored ? r["Сценарий"] : "",
        weight: scored ? (w == null ? 1 : w) : 0, reverse: yes(r["Обратный вопрос"]), scored };
    }).filter(q => q.n != null && q.text);
    const scenarios = s.scenarios.map((r, i) => ({
      order: num(r["Порядок"]) ?? i + 1, name: r["Сценарий"], program: r["Внутренняя программа"], focus: r["Фокус"],
      explanation: r["Короткое объяснение"], question: r["Вопрос для размышления"]
    })).filter(x => x.name);
    const variants = s.variants.map(r => ({
      scenario: r["Сценарий"], name: r["Вариант"], type: String(r["Тип"] || "").trim().toLowerCase(),
      questions: String(r["Вопросы"] || "").split(/\D+/).map(Number).filter(Boolean),
      program: r["Внутренняя программа"], focus: r["Фокус"], explanation: r["Короткое объяснение"],
      question: r["Вопрос для размышления"]
    })).filter(v => v.scenario && v.name);
    const texts = {};
    s.texts.forEach(r => { if (r["Ключ"]) texts[r["Ключ"]] = r["Текст"] || ""; });
    const settings = {};
    s.settings.forEach(r => { const v = num(r["Значение"]); if (r["Ключ"] && v != null) settings[r["Ключ"]] = v; });
    return {
      settings: Object.assign({}, FALLBACK.settings, settings),
      questions, scenarios, variants,
      texts: Object.assign({}, FALLBACK.texts, texts)
    };
  }

  async function loadContent() {
    if (!CFG.sheetId) {
      source = "config";
      return FALLBACK;
    }
    try {
      const data = await window.SheetLoader.fetchSheets(CFG.sheetId, SHEETS, CFG.sheetTimeoutMs);
      const content = fromSheets(data);
      if (!content.questions.length || !content.scenarios.length) throw new Error("в таблице нет вопросов или сценариев");
      source = "sheet";
      return content;
    } catch (e) {
      console.warn("Контент из Google-таблицы не загружен, используется встроенный:", e);
      source = "fallback";
      return FALLBACK;
    }
  }

  // ── Подсчёт ──

  function computeResult(c, ans) {
    const S = c.settings;
    const strongAt = S.strong_answer ?? 4;
    const minStrong = S.min_strong ?? 2;
    const threshold = S.threshold ?? 0.5;
    const maxResults = S.max_results ?? 3;
    const value = q => (ans[q.n] == null ? null : q.reverse ? 6 - ans[q.n] : ans[q.n]);
    const qByN = new Map(c.questions.map(q => [q.n, q]));

    const stats = c.scenarios.map(sc => ({ sc, sumW: 0, sumWV: 0, strong: 0 }));
    const byName = new Map(stats.map(s => [s.sc.name, s]));
    c.questions.forEach(q => {
      if (!q.scored || !(q.weight > 0)) return;
      const st = byName.get(q.scenario);
      const v = value(q);
      if (!st || v == null) return;
      st.sumW += q.weight;
      st.sumWV += q.weight * v;
      if (v >= strongAt) st.strong++;
    });
    stats.forEach(s => {
      s.mean = s.sumW ? s.sumWV / s.sumW : 0;
      s.confirmed = s.strong >= minStrong;
    });

    const r6 = x => Math.round(x * 1e6);
    const confirmed = stats.filter(s => s.confirmed)
      .sort((a, b) => (r6(b.mean) - r6(a.mean)) || (a.sc.order - b.sc.order));
    if (!confirmed.length) return { neutral: true, shown: [], stats };

    const lead = confirmed[0].mean;
    const shown = confirmed
      .filter(s => r6(lead - s.mean) <= r6(threshold))
      .slice(0, maxResults)
      .map(s => Object.assign({}, s, { variant: pickVariant(c, s.sc.name, value, qByN, strongAt) }));
    return { neutral: false, shown, stats };
  }

  function pickVariant(c, name, value, qByN, strongAt) {
    const vs = c.variants.filter(v => v.scenario === name);
    if (!vs.length) return null;
    const hits = vs.filter(v => v.type === "подтип" && v.questions.length && v.questions.every(n => {
      const q = qByN.get(n);
      const v2 = q ? value(q) : null;
      return v2 != null && v2 >= strongAt;
    }));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return vs.find(v => v.type === "все подтипы") || hits[0];
    return vs.find(v => v.type === "общий") || null;
  }

  function resultLabels(r) {
    if (r.neutral) return ["Нейтральный результат"];
    return r.shown.map(s => s.sc.name + (s.variant && s.variant.type !== "общий" ? " (" + s.variant.name + ")" : ""));
  }

  // ── Экраны ──

  function show(id) {
    ["#s-start", "#s-question", "#s-form", "#s-result"].forEach(s => { $(s).hidden = s !== id; });
    $("#loading").hidden = true;
    $("#footer").hidden = false;
    window.scrollTo(0, 0);
  }

  function renderStatic() {
    document.title = t("start.title") || document.title;
    setText("#start-marker", "start.marker");
    setText("#start-title", "start.title");
    setText("#start-subtitle", "start.subtitle");
    fill($("#start-texts"), ["start.text1", "start.text2", "start.text3"].map(t).filter(x => !isBlank(x)).join("\n"));
    const chips = $("#start-chips");
    chips.innerHTML = "";
    t("start.duration").split("·").map(x => x.trim()).filter(Boolean).forEach(x => chips.appendChild(el("span", "chip", x)));
    chips.hidden = !chips.children.length;
    setText("#start-accent", "start.accent");
    $("#start-btn").textContent = t("start.button");
    setText("#start-instruction", "start.instruction");

    $("#q-back").textContent = "← " + t("question.back");

    setText("#form-title", "form.title");
    fill($("#form-text"), t("form.text"));
    $("#form-name").textContent = t("form.name");
    $("#form-channel").textContent = t("form.channel");
    $("#form-contact").textContent = t("form.contact");
    $("#form-consent").textContent = t("form.consent");
    $("#form-consent-link").textContent = t("form.consent_link");
    $("#form-btn").textContent = t("form.button");
    $("#form-back").textContent = "← " + t("question.back");
    renderMethods();

    setText("#footer-policy", "footer.policy");
    setText("#footer-consent", "footer.consent");
    setText("#footer-copyright", "footer.copyright");
  }

  function renderQuestion() {
    const q = order[idx];
    $("#q-counter").textContent = t("question.counter").replace("{n}", idx + 1).replace("{total}", order.length);
    $("#q-bar").style.width = (idx / order.length * 100) + "%";
    $("#q-text").textContent = q.text;
    const box = $("#q-options");
    box.innerHTML = "";
    [1, 2, 3, 4, 5].forEach(v => {
      const b = el("button", "opt" + (answers[q.n] === v ? " sel" : ""));
      b.type = "button";
      b.append(el("b", null, String(v)), el("span", null, t("scale." + v)));
      b.addEventListener("click", () => choose(v));
      box.appendChild(b);
    });
    locked = false;
  }

  function choose(v) {
    if (locked) return;
    locked = true;
    answers[order[idx].n] = v;
    document.querySelectorAll("#q-options .opt").forEach((b, i) => b.classList.toggle("sel", i + 1 === v));
    setTimeout(() => {
      if (idx < order.length - 1) {
        idx++;
        renderQuestion();
      } else {
        show("#s-form");
      }
    }, 220);
  }

  function renderMethods() {
    const box = $("#f-methods");
    box.innerHTML = "";
    Object.entries(METHODS).forEach(([key, m]) => {
      const b = el("button", key === method ? "sel" : "", m.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(key === method));
      b.addEventListener("click", () => {
        method = key;
        renderMethods();
        $("#f-error").textContent = "";
        $("#f-contact").focus();
      });
      box.appendChild(b);
    });
    $("#f-contact").placeholder = t(METHODS[method].ph);
  }

  function field(label, text, cls) {
    const wrap = el("div");
    if (!isBlank(label)) wrap.appendChild(el("p", "label", label));
    const p = el("p", cls, text);
    wrap.appendChild(p);
    return wrap;
  }

  function renderResult(r) {
    const n = r.shown.length;
    $("#r-title").textContent = r.neutral ? t("result.neutral_title") : t(n === 1 ? "result.one" : n === 2 ? "result.two" : "result.three");
    fill($("#r-intro"), r.neutral ? t("result.neutral_text") : "");

    const cards = $("#r-cards");
    cards.innerHTML = "";
    r.shown.forEach(s => {
      const src = s.variant || s.sc;
      const card = el("article", "card");
      card.appendChild(el("h3", null, s.sc.name));
      if (!isBlank(src.program)) {
        card.appendChild(el("p", "label", t("result.label_program")));
        card.appendChild(el("p", "program", src.program));
      }
      if (!isBlank(src.focus)) card.appendChild(field(t("result.label_focus"), src.focus));
      if (!isBlank(src.explanation)) fill(card.appendChild(el("div", "prose")), src.explanation);
      if (!isBlank(src.question)) {
        const box = el("div", "reflect");
        box.appendChild(el("p", "label", t("result.label_question")));
        box.appendChild(el("p", null, src.question));
        card.appendChild(box);
      }
      cards.appendChild(card);
    });

    const trans = r.neutral ? "" : t(n === 1 ? "result.transition_one" : "result.transition_many");
    $("#r-transition").textContent = trans;
    $("#r-transition").hidden = isBlank(trans);

    setText("#c-title", "consult.title");
    const ctext = r.neutral ? t("consult.neutral_text") : t("consult.text");
    fill($("#c-text"), isBlank(ctext) ? "" : ctext);
    setText("#c-price", "consult.price");
    $("#c-btn").textContent = t("consult.button");
    $("#c-btn").setAttribute("aria-expanded", "false");
    $("#c-channels").hidden = true;
    setText("#c-choose", "consult.choose");
    const links = $("#c-links");
    links.innerHTML = "";
    CHANNEL_LINKS.forEach(([kind, label]) => {
      const href = normLink(kind, t("link." + kind));
      if (!href) return;
      const a = el("a", null, label);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      links.appendChild(a);
    });

    const ch = $("#r-channel");
    ch.textContent = t("result.channel_text");
    ch.href = normLink("channel", t("link.channel"));
    ch.parentElement.hidden = isBlank(t("result.channel_text")) || !t("link.channel");
    $("#r-restart").textContent = t("result.restart");
    $("#r-restart").parentElement.hidden = isBlank(t("result.restart"));
  }

  async function submitLead(payload) {
    if (!CFG.submitUrl) {
      console.warn("Адрес хранилища не задан — заявка не отправлена (демо-режим).");
      return true;
    }
    try {
      const res = await fetch(CFG.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      return res.ok;
    } catch (e) {
      console.warn("Заявка не отправлена:", e);
      return false;
    }
  }

  // ── События ──

  function bind() {
    $("#start-btn").addEventListener("click", () => {
      idx = 0;
      renderQuestion();
      show("#s-question");
    });

    $("#q-back").addEventListener("click", () => {
      if (idx > 0) {
        idx--;
        renderQuestion();
      } else {
        show("#s-start");
      }
    });

    $("#form-back").addEventListener("click", () => {
      idx = order.length - 1;
      renderQuestion();
      show("#s-question");
    });

    document.addEventListener("keydown", e => {
      if ($("#s-question").hidden || e.target.tagName === "INPUT") return;
      if (e.key >= "1" && e.key <= "5") choose(Number(e.key));
    });

    $("#lead-form").addEventListener("submit", async e => {
      e.preventDefault();
      const name = $("#f-name").value.trim();
      const contact = $("#f-contact").value.trim();
      let err = "";
      if (!name) err = "Напиши, как к тебе обращаться.";
      else if (!METHODS[method].check(contact)) err = "Проверь контакт: " + METHODS[method].err;
      else if (!$("#f-consent").checked) err = "Нужно согласие на обработку персональных данных.";
      $("#f-error").textContent = err;
      if (err) return;

      const btn = $("#form-btn");
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = t("form.sending") || "Отправляем…";

      const r = computeResult(C, answers);
      const sent = await submitLead({
        date: new Date().toISOString(),
        name,
        channel: METHODS[method].label,
        contact,
        scenarios: resultLabels(r),
        consent: true
      });

      btn.disabled = false;
      btn.textContent = label;
      if (!sent) {
        $("#f-error").textContent = t("form.error") ||
          "Не удалось отправить заявку. Проверь подключение к интернету и попробуй ещё раз.";
        return;
      }
      renderResult(r);
      show("#s-result");
    });

    $("#c-btn").addEventListener("click", () => {
      const box = $("#c-channels");
      box.hidden = !box.hidden;
      $("#c-btn").setAttribute("aria-expanded", String(!box.hidden));
    });

    $("#r-restart").addEventListener("click", () => {
      answers = {};
      idx = 0;
      $("#f-consent").checked = false;
      show("#s-start");
    });

  }

  async function init() {
    C = await loadContent();
    order = C.questions.slice().sort((a, b) => a.n - b.n);
    renderStatic();
    bind();
    show("#s-start");
  }

  const ready = init();

  window.TestApp = {
    computeResult, resultLabels, fromSheets, ready,
    get content() { return C; },
    get source() { return source; }
  };
})();
