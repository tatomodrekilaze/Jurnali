// Jurnali — a lighter front end for the onlineschool.emis.ge teacher journal.
//
// Runs inside an already logged-in onlineschool page (the Android app injects it,
// on desktop it's loaded by a bookmarklet) and talks to the same API the site uses.
// It never handles passwords; it reuses the session token the site keeps in localStorage.

(function () {
  "use strict";

  if (window.Jurnali) return;

  const VERSION = 1;
  const CONFIG_URL = "https://tatomodrekilaze.github.io/Jurnali/config.json";

  // Defaults. config.json can override any of these without shipping a new APK.
  let config = {
    disabled: false,
    message: null,
    apiBase: "/school-lms-back/resources/school/",
    tokenKey: "access_token",
    paths: {
      schedule: "dashboard/schedule?date={date}",
      week: "gradebook/classgroup/{classGroupId}/week?accessAs=TEACHER&startDate={date}&endDate={date}",
      absence: "gradebook/{lessonId}/pupils/{pupilId}/absence",
    },
    fields: {
      day: ["date", "events"],
      event: ["startTime", "endTime", "eventType", "subjectName", "classGroups"],
      classGroup: ["classGroupId", "name", "number"],
      lesson: ["lessonId", "startDateTime", "readonly", "pupil"],
      pupil: ["pupilId", "pupilName", "present"],
    },
    writeDelayMs: 250,
  };

  async function loadConfig() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(CONFIG_URL + "?t=" + Date.now(), { signal: ctrl.signal });
      if (!res.ok) return;
      const remote = await res.json();
      if ((remote.minVersion || 0) > VERSION) {
        remote.disabled = true;
        remote.message = remote.message || "ახალი ვერსიაა საჭირო. განაახლეთ აპლიკაცია.";
      }
      config = {
        ...config,
        ...remote,
        paths: { ...config.paths, ...remote.paths },
        fields: { ...config.fields, ...remote.fields },
      };
    } catch (_) {
      // Offline or Pages is down: built-in defaults are fine.
    } finally {
      clearTimeout(timer);
    }
  }

  // --- helpers ---------------------------------------------------------------

  const pad2 = (n) => String(n).padStart(2, "0");
  const formatDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const timeOf = (s) => (String(s || "").match(/\d{2}:\d{2}/) || [""])[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fillPath = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k]).replace(/%2F/g, "/"));

  function readToken() {
    try {
      return localStorage.getItem(config.tokenKey);
    } catch (_) {
      return null;
    }
  }

  // Thrown when the API answers with something we don't recognise. We'd rather
  // stop than write to the journal based on a guess.
  class ApiChanged extends Error {}

  function expectFields(obj, keys, what) {
    if (!obj || typeof obj !== "object") throw new ApiChanged(`${what} is not an object`);
    const missing = keys.filter((k) => !(k in obj));
    if (missing.length) throw new ApiChanged(`${what}: missing ${missing.join(", ")}`);
  }

  class NotLoggedIn extends Error {}

  async function request(method, path) {
    const token = readToken();
    if (!token) throw new NotLoggedIn();

    if (method !== "GET" && window.JURNALI_DRY_RUN) {
      (window.JURNALI_DRY_LOG ||= []).push(`${method} ${path}`);
      return null;
    }

    const res = await fetch(config.apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      credentials: "same-origin",
    });
    if (res.status === 401) throw new NotLoggedIn();
    if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → ${res.status}`);
    const text = res.status === 204 ? "" : await res.text();
    return text ? JSON.parse(text) : null;
  }

  // --- journal ---------------------------------------------------------------

  // Today's lessons for this teacher, grouped by class (e.g. "1ბ"), with every
  // pupil's attendance per lesson.
  async function loadDay(date) {
    const dateStr = formatDate(date);
    const f = config.fields;

    const days = await request("GET", fillPath(config.paths.schedule, { date: dateStr }));
    if (!Array.isArray(days)) throw new ApiChanged("schedule is not a list");
    const day = days[0];
    if (!day) return { holiday: false, classes: [] };
    expectFields(day, f.day, "schedule day");
    if (day.holiday) return { holiday: true, classes: [] };

    // The schedule knows when lessons are; the journal knows lesson ids and
    // pupils. Collect slots per class group, then match them by start time.
    const slotsByGroup = new Map();
    for (const ev of day.events) {
      expectFields(ev, f.event, "schedule event");
      if (ev.eventType !== "LESSON") continue;
      for (const cg of ev.classGroups) {
        expectFields(cg, f.classGroup, "class group");
        const slots = slotsByGroup.get(cg.classGroupId) || [];
        slots.push({
          subject: ev.subjectName,
          start: timeOf(ev.startTime),
          classKey: `${cg.number}${cg.name}`,
        });
        slotsByGroup.set(cg.classGroupId, slots);
      }
    }

    const classes = new Map();
    for (const [classGroupId, slots] of slotsByGroup) {
      const week = await request("GET", fillPath(config.paths.week, { classGroupId, date: dateStr }));
      if (!Array.isArray(week)) throw new ApiChanged("journal week is not a list");
      week.forEach((l) => expectFields(l, f.lesson, "journal lesson"));

      for (const slot of slots) {
        const cls = classes.get(slot.classKey) || { key: slot.classKey, lessons: [], names: new Map() };
        classes.set(slot.classKey, cls);

        const match = week.find(
          (l) => String(l.startDateTime).startsWith(dateStr) && timeOf(l.startDateTime) === slot.start,
        );
        const lesson = {
          id: match ? match.lessonId : null,
          subject: slot.subject,
          start: slot.start,
          readonly: match ? Boolean(match.readonly) : true,
          pupils: new Map(),
        };
        for (const p of match ? match.pupil : []) {
          expectFields(p, f.pupil, "pupil");
          lesson.pupils.set(p.pupilId, {
            present: Boolean(p.present),
            editable: !p.notInClass && !p.locked,
          });
          if (!p.notInClass) cls.names.set(p.pupilId, p.pupilName);
        }
        cls.lessons.push(lesson);
      }
    }

    const byGeorgian = (a, b) => a.localeCompare(b, "ka");
    return {
      holiday: false,
      classes: [...classes.values()]
        .map((c) => ({
          key: c.key,
          lessons: c.lessons.sort((a, b) => a.start.localeCompare(b.start)),
          pupils: [...c.names].map(([id, name]) => ({ id, name })).sort((a, b) => byGeorgian(a.name, b.name)),
        }))
        .sort((a, b) => byGeorgian(a.key, b.key)),
    };
  }

  const canEdit = (lesson, pupilId) =>
    lesson.id != null && !lesson.readonly && Boolean(lesson.pupils.get(pupilId)?.editable);

  const isAbsent = (lesson, pupilId) => !lesson.pupils.get(pupilId).present;

  // --- state -----------------------------------------------------------------

  const state = {
    open: false,
    loading: false,
    saving: false,
    confirming: false,
    error: null,
    apiChanged: null,
    holiday: false,
    classes: [],
    classKey: null,
    selectedLessons: new Set(), // lesson start times
    changes: new Map(), // pupilId -> "absent" | "present"
    results: new Map(), // lesson start -> true/false after save
  };

  const currentClass = () => state.classes.find((c) => c.key === state.classKey) || null;
  const selectedLessons = (cls) => cls.lessons.filter((l) => state.selectedLessons.has(l.start));

  // What the journal currently says for a pupil across the selected lessons.
  function journalStatus(cls, pupilId) {
    const lessons = selectedLessons(cls).filter((l) => canEdit(l, pupilId));
    const absentIn = lessons.filter((l) => isAbsent(l, pupilId)).length;
    if (absentIn === 0) return "present";
    return absentIn === lessons.length ? "absent" : "mixed";
  }

  const displayStatus = (cls, pupilId) => state.changes.get(pupilId) || journalStatus(cls, pupilId);

  function selectClass(key) {
    state.classKey = key;
    state.changes.clear();
    state.results.clear();
    state.confirming = false;
    const cls = currentClass();
    state.selectedLessons = new Set(cls ? cls.lessons.filter((l) => l.id != null && !l.readonly).map((l) => l.start) : []);
  }

  function pendingWrites() {
    const cls = currentClass();
    if (!cls) return [];
    const writes = [];
    for (const lesson of selectedLessons(cls)) {
      for (const [pupilId, wanted] of state.changes) {
        if (!canEdit(lesson, pupilId)) continue;
        const absent = isAbsent(lesson, pupilId);
        if (wanted === "absent" && !absent) writes.push({ lesson, pupilId, method: "POST" });
        if (wanted === "present" && absent) writes.push({ lesson, pupilId, method: "DELETE" });
      }
    }
    return writes;
  }

  // --- actions ---------------------------------------------------------------

  async function refresh() {
    const day = await loadDay(new Date());
    state.holiday = day.holiday;
    state.classes = day.classes;
  }

  async function open() {
    if (!readToken()) return;
    Object.assign(state, { open: true, loading: true, error: null, apiChanged: null });
    render();
    await loadConfig();
    try {
      await refresh();
      const keep = state.classes.some((c) => c.key === state.classKey);
      selectClass(keep ? state.classKey : state.classes[0]?.key ?? null);
    } catch (e) {
      handleError(e);
    }
    state.loading = false;
    render();
  }

  function handleError(e) {
    if (e instanceof ApiChanged) state.apiChanged = e.message;
    else if (e instanceof NotLoggedIn) state.error = "სესია ამოიწურა. შედით onlineschool-ში თავიდან.";
    else state.error = `ვერ ჩაიტვირთა (${e.message}).`;
  }

  async function save() {
    const writes = pendingWrites();
    const wanted = new Map(state.changes);
    const lessons = new Set(state.selectedLessons);
    const failed = new Set();

    Object.assign(state, { saving: true, confirming: false });
    state.results.clear();
    render();

    for (const w of writes) {
      try {
        await request(w.method, fillPath(config.paths.absence, { lessonId: w.lesson.id, pupilId: w.pupilId }));
      } catch (_) {
        failed.add(w.lesson.start);
      }
      await sleep(config.writeDelayMs);
    }

    // Don't trust the writes; read the journal back and compare.
    try {
      await refresh();
      const cls = currentClass();
      for (const lesson of cls ? cls.lessons : []) {
        if (!lessons.has(lesson.start)) continue;
        const ok = [...wanted].every(
          ([pupilId, status]) => !canEdit(lesson, pupilId) || isAbsent(lesson, pupilId) === (status === "absent"),
        );
        state.results.set(lesson.start, ok && !failed.has(lesson.start));
      }
      state.changes.clear();
    } catch (e) {
      state.error = "შენახვის შემდეგ ჟურნალი ვერ შემოწმდა. გადაამოწმეთ საიტზე.";
    }
    state.saving = false;
    render();
  }

  function togglePupil(pupilId) {
    const cls = currentClass();
    const next = displayStatus(cls, pupilId) === "absent" ? "present" : "absent";
    if (next === journalStatus(cls, pupilId)) state.changes.delete(pupilId);
    else state.changes.set(pupilId, next);
    state.results.clear();
    state.confirming = false;
  }

  function toggleLesson(start) {
    if (state.selectedLessons.has(start)) state.selectedLessons.delete(start);
    else state.selectedLessons.add(start);
    state.results.clear();
    state.confirming = false;
  }

  // --- view ------------------------------------------------------------------

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Noto Sans Georgian", system-ui, sans-serif; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:disabled { cursor: default; }

    .launcher {
      position: fixed; z-index: 2147483646;
      right: max(16px, env(safe-area-inset-right, 0px));
      bottom: calc(20px + env(safe-area-inset-bottom, 0px));
      border: 0; border-radius: 999px; padding: 14px 18px;
      background: #2f5d4e; color: #fff; font-size: 15px; font-weight: 700;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
    }

    .panel {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; flex-direction: column;
      background: #fbfcf9; color: #1d2a24;
      padding-top: env(safe-area-inset-top, 0px);
    }
    .head { display: grid; gap: 8px; padding: 14px 16px 12px; border-bottom: 1px solid #d6ddd6; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .date { font-size: 13px; color: #5f6d66; }
    h1 { margin: 0; font-size: 22px; }
    .close { width: 38px; height: 38px; border: 0; border-radius: 999px; background: #e9ece6; font-size: 18px; }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #dfeae4; color: #2f5d4e; }
    .badge.warn { background: #fbefd9; color: #b7791f; }
    .classes { display: flex; flex-wrap: wrap; gap: 8px; }
    .class { padding: 7px 14px; border: 1px solid #d6ddd6; border-radius: 999px; background: none; font-size: 14px; font-weight: 600; }
    .class.on { background: #2f5d4e; border-color: #2f5d4e; color: #fff; }

    .body { flex: 1; overflow-y: auto; padding: 12px 16px 130px; }
    .label { margin: 10px 0 8px; font-size: 12px; font-weight: 600; color: #5f6d66; text-transform: uppercase; letter-spacing: .06em; }

    .lessons { display: grid; gap: 6px; }
    .lesson {
      display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 10px;
      padding: 10px 12px; border: 1px solid #d6ddd6; border-radius: 12px; background: none; text-align: left; font-size: 14px;
    }
    .check { display: grid; place-items: center; width: 20px; height: 20px; border: 2px solid #d6ddd6; border-radius: 6px; color: #fff; font-size: 13px; }
    .lesson.on .check { background: #2f5d4e; border-color: #2f5d4e; }
    .lesson:disabled { opacity: .55; }
    .time { font-size: 12px; color: #5f6d66; font-variant-numeric: tabular-nums; }
    .ok { font-size: 13px; font-weight: 700; color: #2e7d4f; }
    .fail { font-size: 13px; font-weight: 700; color: #c4472f; }

    .tally { display: flex; gap: 14px; margin: 4px 0 8px; font-size: 14px; }
    .tally .absent b { color: #c4472f; }
    .pupil {
      display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 10px;
      width: 100%; min-height: 50px; padding: 10px 4px;
      border: 0; border-bottom: 1px solid #d6ddd6; background: none; text-align: left; font-size: 16px;
    }
    .num { font-size: 12px; color: #5f6d66; font-variant-numeric: tabular-nums; }
    .tag { padding: 4px 10px; border-radius: 999px; background: #dfeae4; color: #2f5d4e; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .pupil.absent { background: #f8e1da; }
    .pupil.absent .tag { background: #c4472f; color: #fff; }
    .pupil.mixed .tag { background: #fbefd9; color: #b7791f; }

    .footer {
      position: fixed; left: 0; right: 0; bottom: 0;
      padding: 12px 16px calc(18px + env(safe-area-inset-bottom, 0px));
      background: linear-gradient(to top, #fbfcf9 75%, rgba(251, 252, 249, 0));
    }
    .save { width: 100%; padding: 16px; border: 0; border-radius: 16px; background: #2f5d4e; color: #fff; font-size: 17px; font-weight: 700; }
    .save:disabled { opacity: .45; }
    .hint { margin-top: 7px; font-size: 12px; color: #5f6d66; text-align: center; }

    .notice { margin-bottom: 10px; padding: 14px; border-radius: 14px; background: #fbefd9; font-size: 14px; line-height: 1.5; }
    .notice b { color: #b7791f; }
    .notice small { display: block; margin-top: 6px; font-size: 11px; color: #5f6d66; word-break: break-word; }
    .empty { padding: 30px 6px; text-align: center; font-size: 15px; line-height: 1.6; color: #5f6d66; }

    .confirm { display: grid; gap: 8px; margin-top: 12px; padding: 14px; border: 1px solid #d6ddd6; border-radius: 14px; font-size: 14px; line-height: 1.5; }
    .confirm .buttons { display: flex; gap: 8px; }
    .confirm button { flex: 1; padding: 12px; border: 1px solid #d6ddd6; border-radius: 12px; background: none; font-size: 15px; font-weight: 700; }
    .confirm .go { background: #c4472f; border-color: #c4472f; color: #fff; }
  `;

  const host = document.createElement("div");
  host.id = "jurnali";
  const root = host.attachShadow({ mode: "open" });

  function viewLessons(cls) {
    const items = cls.lessons.map((l) => {
      const usable = l.id != null && !l.readonly && !state.saving;
      const on = state.selectedLessons.has(l.start);
      const result = state.results.get(l.start);
      const right =
        result === true ? `<span class="ok">✓ შენახულია</span>`
        : result === false ? `<span class="fail">✗ შეამოწმეთ</span>`
        : `<span class="time">${l.readonly ? "🔒 " : ""}${l.start}</span>`;
      return `<button class="lesson ${on ? "on" : ""}" data-action="lesson" data-start="${l.start}" ${usable ? "" : "disabled"}>
        <span class="check">${on ? "✓" : ""}</span><span>${escapeHtml(l.subject)}</span>${right}
      </button>`;
    });
    return `<div class="label">დღევანდელი გაკვეთილები</div><div class="lessons">${items.join("")}</div>`;
  }

  function viewPupils(cls) {
    const absent = cls.pupils.filter((p) => displayStatus(cls, p.id) === "absent").length;
    const tags = { absent: "აკლია", present: "ესწრება", mixed: "ნაწილობრივ" };
    const rows = cls.pupils.map((p, i) => {
      const status = displayStatus(cls, p.id);
      return `<button class="pupil ${status}" data-action="pupil" data-id="${p.id}" ${state.saving ? "disabled" : ""}>
        <span class="num">${pad2(i + 1)}</span><span>${escapeHtml(p.name)}</span><span class="tag">${tags[status]}</span>
      </button>`;
    });
    return `<div class="label">შეეხეთ მოსწავლეს, თუ აკლია</div>
      <div class="tally"><span>ესწრება: <b>${cls.pupils.length - absent}</b></span><span class="absent">აკლია: <b>${absent}</b></span></div>
      ${rows.join("")}`;
  }

  function viewConfirm() {
    const writes = pendingWrites();
    const marks = writes.filter((w) => w.method === "POST").length;
    const unmarks = writes.length - marks;
    return `<div class="confirm">
      ჟურნალში ჩაიწერება: <b>${marks}</b> გაცდენა${unmarks ? `, <b>${unmarks}</b> გაცდენის მოხსნა` : ""}, ${state.selectedLessons.size} გაკვეთილში.
      <div class="buttons"><button data-action="cancel">გაუქმება</button><button class="go" data-action="confirm">დიახ, შენახვა</button></div>
    </div>`;
  }

  function viewBody(cls) {
    if (state.loading) return `<div class="empty">იტვირთება…</div>`;
    if (config.disabled) {
      return `<div class="notice"><b>დროებით გამორთულია.</b> ${escapeHtml(config.message || "გამოიყენეთ საიტი ჩვეულებრივად.")}</div>`;
    }
    if (state.apiChanged) {
      return `<div class="notice"><b>onlineschool შეიცვალა.</b> შენახვა გამორთულია, რომ ჟურნალში შეცდომა არ მოხვდეს. დღეს გამოიყენეთ საიტი ჩვეულებრივად.
        <small>${escapeHtml(state.apiChanged)}</small></div>`;
    }
    if (state.error) return `<div class="notice"><b>შეცდომა.</b> ${escapeHtml(state.error)}</div>`;
    if (state.holiday) return `<div class="empty">დღეს დასვენების დღეა.</div>`;
    if (!cls) return `<div class="empty">დღეს გაკვეთილები არ გაქვთ.</div>`;
    return viewLessons(cls) + viewPupils(cls) + (state.confirming ? viewConfirm() : "");
  }

  function viewFooter(cls) {
    if (!cls || state.loading || state.error || state.apiChanged || config.disabled) return "";
    const n = pendingWrites().length;
    const label = state.saving ? "ინახება…" : n ? `შენახვა (${n} ცვლილება)` : "ცვლილება არ არის";
    return `<div class="footer">
      <button class="save" data-action="save" ${state.saving || state.confirming || !n ? "disabled" : ""}>${label}</button>
      <div class="hint">დანარჩენები ჟურნალში უკვე „კი“-ზეა</div>
    </div>`;
  }

  function render() {
    if (!state.open) {
      root.innerHTML = `<style>${STYLES}</style>` +
        (isLoggedIn() ? `<button class="launcher" data-action="open">✓ დღის გაცდენები</button>` : "");
      return;
    }

    const cls = currentClass();
    const today = new Date().toLocaleDateString("ka-GE", { weekday: "long", day: "numeric", month: "long" });
    const broken = state.apiChanged || config.disabled;
    const scroll = root.querySelector(".body")?.scrollTop || 0;

    root.innerHTML = `<style>${STYLES}</style>
      <div class="panel">
        <div class="head">
          <div class="row">
            <span class="date">${escapeHtml(today)}</span>
            <span class="badge ${broken ? "warn" : ""}">${broken ? "შენახვა გამორთულია" : "onlineschool ✓"}</span>
            <button class="close" data-action="close" aria-label="დახურვა">✕</button>
          </div>
          <h1>დღის გაცდენები</h1>
          <div class="classes">${state.classes
            .map((c) => `<button class="class ${c.key === state.classKey ? "on" : ""}" data-action="class" data-key="${escapeHtml(c.key)}">${escapeHtml(c.key)} კლასი</button>`)
            .join("")}</div>
        </div>
        <div class="body">${viewBody(cls)}</div>
        ${viewFooter(cls)}
      </div>`;

    const body = root.querySelector(".body");
    if (body) body.scrollTop = scroll;
  }

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    switch (el.dataset.action) {
      case "open": open(); return;
      case "close": state.open = false; break;
      case "class": selectClass(el.dataset.key); break;
      case "lesson": toggleLesson(el.dataset.start); break;
      case "pupil": togglePupil(Number(el.dataset.id)); break;
      case "save": state.confirming = true; break;
      case "cancel": state.confirming = false; break;
      case "confirm": save(); return;
    }
    render();
  });

  // --- mount -----------------------------------------------------------------

  const isLoggedIn = () => Boolean(readToken()) && !location.pathname.startsWith("/auth");

  // The site is a SPA, so login/logout doesn't reload the page. Poll cheaply and
  // only re-render the launcher when the login state actually flips.
  let lastLoggedIn = null;
  function sync() {
    if (!document.body) return;
    if (!host.isConnected) document.body.appendChild(host);
    const loggedIn = isLoggedIn();
    if (loggedIn === lastLoggedIn) return;
    lastLoggedIn = loggedIn;
    if (!loggedIn) state.open = false;
    render();
  }

  sync();
  setInterval(sync, 1500);

  window.Jurnali = { version: VERSION, open };
})();
