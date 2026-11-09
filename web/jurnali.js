// Jurnali — a lighter front end for the onlineschool.emis.ge teacher journal.
//
// Runs inside an already logged-in onlineschool page (the Android app injects it,
// on desktop it's loaded by a bookmarklet) and talks to the same API the site uses.
// It never handles passwords; it reuses the session token the site keeps in localStorage.
//
// Attendance rules mirror the official web app (see docs/how-it-works.md):
//   - a lesson can be edited from the moment it starts until N days later,
//     N coming from gradebook/definitiveassessment/thresholddays
//   - a pupil who already has a grade in a lesson can't be marked absent
//   - pupils who moved schools or are locked can't be edited at all

(function () {
  "use strict";

  if (window.Jurnali) return;

  const VERSION = 2;
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
      editWindow: "gradebook/definitiveassessment/thresholddays",
    },
    fields: {
      day: ["date", "events"],
      event: ["startTime", "endTime", "eventType", "subjectName", "classGroups"],
      classGroup: ["classGroupId", "name", "number"],
      lesson: ["lessonId", "startDateTime", "readonly", "pupil"],
      pupil: ["pupilId", "pupilName", "present"],
    },
    // Used only if the edit-window endpoint fails. The server enforces the real limit.
    fallbackEditDays: 1,
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
        remote.message = remote.message || "გამოვიდა ახალი ვერსია. ჩამოტვირთეთ თავიდან: tatomodrekilaze.github.io/Jurnali";
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

  const DAY_MS = 864e5;
  const pad2 = (n) => String(n).padStart(2, "0");
  const formatDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
  const timeOf = (s) => (String(s || "").match(/\d{2}:\d{2}/) || [""])[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fillPath = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k]).replace(/%2F/g, "/"));

  // "09/11/2026 09:50:00" -> Date
  function parseDateTime(s) {
    const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})\D+(\d{2}):(\d{2})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : null;
  }

  // Browsers don't reliably ship Georgian locale data, so no toLocaleDateString here.
  const WEEKDAYS = ["კვირა", "ორშაბათი", "სამშაბათი", "ოთხშაბათი", "ხუთშაბათი", "პარასკევი", "შაბათი"];
  const MONTHS = ["იანვარი", "თებერვალი", "მარტი", "აპრილი", "მაისი", "ივნისი", "ივლისი", "აგვისტო", "სექტემბერი", "ოქტომბერი", "ნოემბერი", "დეკემბერი"];
  const SHORT_WEEKDAYS = ["კვ", "ორშ", "სამ", "ოთხ", "ხუთ", "პარ", "შაბ"];
  const longDate =(d) => `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;

  // Error codes the API returns on 409, with the wording the official site uses.
  const SERVER_ERRORS = {
    assessment_exists: "ნიშანი უკვე უწერია, გაცდენას ვერ ჩაუწერთ",
    past_absence_error: "ამ გაკვეთილის შეცვლის დრო გავიდა",
    future_absence_error: "გაკვეთილი ჯერ არ დაწყებულა",
    moved_pupil_attendance_error: "მოსწავლე სხვა სკოლაშია გადასული",
    pupil_moved_to_other_school: "მოსწავლე სხვა სკოლაშია გადასული",
    pupil_is_exam_restoration_participant: "მოსწავლე აღდგენით გამოცდაზეა ჩაწერილი",
  };

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
  class NotLoggedIn extends Error {}
  class Rejected extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  function expectFields(obj, keys, what) {
    if (!obj || typeof obj !== "object") throw new ApiChanged(`${what} is not an object`);
    const missing = keys.filter((k) => !(k in obj));
    if (missing.length) throw new ApiChanged(`${what}: missing ${missing.join(", ")}`);
  }

  // --- session ---------------------------------------------------------------
  //
  // onlineschool hands out a 10-minute access token and a 30-minute refresh token
  // (Keycloak on auth.emis.ge). The site only refreshes when it makes a request, so
  // any break longer than half an hour logs the teacher out. We refresh the same way
  // the site does, a little earlier, and keep doing it while the page is in front.

  const REFRESH_PATH = "keycloak/refresh";
  let refreshing = null;

  function accessSecondsLeft() {
    try {
      const exp = new Date(localStorage.accessTokenExpirationDate).getTime();
      return Number.isFinite(exp) ? (exp - Date.now()) / 1000 : 0;
    } catch (_) {
      return 0;
    }
  }

  function refreshSecondsLeft() {
    try {
      const part = localStorage.getItem("refresh_token").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const { exp } = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
      return exp - Date.now() / 1000;
    } catch (_) {
      return 0;
    }
  }

  // Same request and same localStorage keys as the site's own HTTP interceptor,
  // so both stay in sync whichever one refreshes first.
  function refreshSession() {
    refreshing ||= (async () => {
      let refreshToken;
      try {
        refreshToken = localStorage.getItem("refresh_token");
      } catch (_) {}
      if (!refreshToken || refreshSecondsLeft() <= 0) return false;
      try {
        const res = await fetch(config.apiBase + REFRESH_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "refresh_token=" + encodeURIComponent(refreshToken),
        });
        if (!res.ok) return false;
        const t = await res.json();
        if (!t || !t.access_token || !t.refresh_token) return false;
        localStorage.refresh_token = t.refresh_token;
        localStorage.access_token = t.access_token;
        localStorage.expires_in = t.expires_in;
        localStorage.accessTokenExpirationDate = new Date(Date.now() + 1000 * t.expires_in).toString();
        reportSession();
        return true;
      } catch (_) {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function ensureFreshToken(minSeconds) {
    if (accessSecondsLeft() < minSeconds) await refreshSession();
  }

  // While the page is visible, renew a couple of minutes before the access token runs
  // out; each renewal also resets the 30-minute idle clock on the refresh token.
  // Phones pause timers in the background, so also renew as soon as we come back.
  function keepSessionAlive() {
    const tick = () => {
      if (document.visibilityState === "visible" && readToken()) ensureFreshToken(120);
    };
    setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    tick();
  }

  // The site's other way of logging people out: after 10 minutes with no mouse or touch
  // it asks "continue working?" and, 10 seconds later, calls keycloak/logout and wipes
  // localStorage. Teachers leave the journal open between lessons, so this is most of
  // the logouts they see. Its idle watcher (bn-ng-idle) resets on any mousemove on the
  // document, synthetic ones included.
  function stayActive() {
    const nudge = () => {
      if (readToken()) document.dispatchEvent(new MouseEvent("mousemove"));
    };
    setInterval(nudge, 60000);
    document.addEventListener("visibilitychange", nudge);
  }

  // Timers can catch up all at once when a phone wakes, so the question may still pop
  // up before the first nudge. Answer it.
  function answerIdlePrompt() {
    const popup = document.querySelector("user-session-popup");
    if (!popup) return;
    const button = [...popup.querySelectorAll("button")].find((b) => b.textContent.includes("გაგრძელება"));
    if (button) button.click();
  }

  // --- Android app hand-off ---
  //
  // The app renews the session while the phone is locked, which JS can't do because the
  // WebView is paused. We tell it about every new token and about an explicit logout;
  // it puts fresher tokens back into localStorage when the teacher returns.
  // jurnaliNative only exists inside the app, and only on this origin.

  let reportedToken = null;

  function reportSession() {
    const native = window.jurnaliNative;
    if (!native) return;
    let session;
    try {
      session = {
        type: "session",
        access_token: localStorage.access_token,
        refresh_token: localStorage.refresh_token,
        expires_in: Number(localStorage.expires_in) || 600,
        access_expires_at: new Date(localStorage.accessTokenExpirationDate).getTime() || 0,
      };
    } catch (_) {
      return;
    }
    // The site writes the string "undefined" when its own refresh fails.
    const token = session.refresh_token;
    if (!token || token === "undefined" || token === reportedToken) return;
    reportedToken = token;
    native.postMessage(JSON.stringify(session));
  }

  // Both the logout button and the idle prompt go through this request.
  function watchLogout() {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (window.jurnaliNative && String(url).includes("keycloak/logout")) {
        reportedToken = null;
        window.jurnaliNative.postMessage(JSON.stringify({ type: "logout" }));
      }
      return open.apply(this, arguments);
    };
  }

  // The login page renders the password as type="text" with autocomplete="off"
  // (their template only uses type="password" in dev mode), so no password manager
  // ever offers to save it. Mark the fields properly and let the phone's own
  // password manager handle it. Jurnali never reads the values.
  function fixLoginForm() {
    if (!location.pathname.startsWith("/auth")) return;
    const user = document.querySelector('input[name="username"], input#userName');
    const pass = document.querySelector('input[name="password"]#password');
    if (user && user.getAttribute("autocomplete") !== "username") user.setAttribute("autocomplete", "username");
    if (!pass || pass.dataset.jurnali) return;
    pass.dataset.jurnali = "1";
    pass.setAttribute("autocomplete", "current-password");
    pass.type = "password";
    // Their eye icon shows the password by flipping a CSS class, not the type,
    // so follow it ourselves.
    const eye = pass.parentElement && pass.parentElement.querySelector(".password-visible-icon");
    if (eye) eye.addEventListener("click", () => setTimeout(() => (pass.type = pass.type === "password" ? "text" : "password")));
  }

  async function request(method, path) {
    await ensureFreshToken(30);
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
    const text = res.status === 204 ? "" : await res.text();
    if (res.status === 409) {
      let code = "conflict";
      try {
        code = JSON.parse(text).errorCode || code;
      } catch (_) {}
      throw new Rejected(String(code).toLowerCase());
    }
    if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  // --- journal ---------------------------------------------------------------

  let editWindow = null; // { LESSON: days, ..., other: days }

  async function loadEditWindow() {
    if (editWindow) return;
    try {
      const data = (await request("GET", config.paths.editWindow)) || {};
      // Same mapping the official journal does: lesson type -> days it stays editable.
      editWindow = {
        SUMMARY_EXAM: data.daysAfterSummary,
        SUMMARY_EXAM_RESTORATION: data.daysAfterSummaryRestore,
        other: data.daysAfterLesson,
      };
    } catch (e) {
      if (e instanceof NotLoggedIn) throw e;
      editWindow = {};
    }
  }

  const editDaysFor = (type) => {
    const v = editWindow?.[type] ?? editWindow?.other;
    return typeof v === "number" ? v : config.fallbackEditDays;
  };

  // Same check the official app runs before letting a teacher touch attendance.
  function lessonStatus(lesson, now = new Date()) {
    if (lesson.id == null || lesson.readonly) return "locked";
    if (now < lesson.startsAt) return "upcoming";
    const daysSince = Math.round((now - lesson.startsAt) / DAY_MS);
    return daysSince <= editDaysFor(lesson.type) ? "open" : "closed";
  }

  // The teacher's lessons on a given day, grouped by class (e.g. "1ბ"), with every
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
        slots.push({ subject: ev.subjectName, start: timeOf(ev.startTime), classKey: `${cg.number}${cg.name}` });
        slotsByGroup.set(cg.classGroupId, slots);
      }
    }

    // One request per class group, and a homeroom teacher can have half a dozen,
    // so send them together rather than one after another.
    const groups = [...slotsByGroup];
    const weeks = await Promise.all(
      groups.map(([classGroupId]) => request("GET", fillPath(config.paths.week, { classGroupId, date: dateStr }))),
    );

    const classes = new Map();
    for (const [i, [classGroupId, slots]] of groups.entries()) {
      const week = weeks[i];
      if (!Array.isArray(week)) throw new ApiChanged("journal week is not a list");
      week.forEach((l) => expectFields(l, f.lesson, "journal lesson"));

      for (const slot of slots) {
        const cls = classes.get(slot.classKey) || { key: slot.classKey, lessons: [], names: new Map(), groupIds: new Set() };
        classes.set(slot.classKey, cls);
        cls.groupIds.add(classGroupId);

        const match = week.find(
          (l) => String(l.startDateTime).startsWith(dateStr) && timeOf(l.startDateTime) === slot.start,
        );
        const lesson = {
          key: `${classGroupId}@${slot.start}`,
          id: match ? match.lessonId : null,
          subject: slot.subject,
          start: slot.start,
          startsAt: (match && parseDateTime(match.startDateTime)) || parseDateTime(`${dateStr} ${slot.start}`),
          type: (match && match.type) || "LESSON",
          readonly: match ? Boolean(match.readonly) : true,
          pupils: new Map(),
        };
        for (const p of match ? match.pupil : []) {
          expectFields(p, f.pupil, "pupil");
          lesson.pupils.set(p.pupilId, {
            present: Boolean(p.present),
            touched: Boolean(p.absenceModified),
            excused: Boolean(p.excusable),
            graded: Array.isArray(p.definitiveAssessments) && p.definitiveAssessments.length > 0,
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
          groupIds: [...c.groupIds],
          lessons: c.lessons.sort((a, b) => a.startsAt - b.startsAt),
          pupils: [...c.names].map(([id, name]) => ({ id, name })).sort((a, b) => byGeorgian(a.name, b.name)),
        }))
        .sort((a, b) => byGeorgian(a.key, b.key)),
    };
  }

  const record = (lesson, pupilId) => lesson.pupils.get(pupilId);
  const isAbsent = (lesson, pupilId) => !record(lesson, pupilId).present;
  const canEdit = (lesson, pupilId) => Boolean(record(lesson, pupilId)?.editable);
  // An absence can't be added on top of a grade; removing one is always fine.
  const canMarkAbsent = (lesson, pupilId) => canEdit(lesson, pupilId) && !record(lesson, pupilId).graded;

  // --- hints -----------------------------------------------------------------
  //
  // Plain rules over the last few weeks of this class's journal, worked out on the
  // device. Each one says why it showed up, and none of them ever marks anybody:
  // they point things out, the teacher decides.

  const HISTORY_WEEKS = 4;
  const historyLoads = new Map(); // "1ბ|09/11/2026" -> Promise
  const histories = new Map(); // same key -> [{ date, roster:Set, absent:Set }], oldest first

  const historyKey = (cls, date) => `${cls.key}|${formatDate(date)}`;

  // School days before `anchor`, each with who was on the list and who missed at
  // least one of this teacher's lessons that day.
  async function loadHistory(cls, anchor) {
    const before = startOfDay(anchor);
    const dates = Array.from({ length: HISTORY_WEEKS + 1 }, (_, k) => formatDate(addDays(before, -7 * k)));
    const weeks = await Promise.all(
      cls.groupIds.flatMap((classGroupId) =>
        dates.map((date) => request("GET", fillPath(config.paths.week, { classGroupId, date })).catch(() => [])),
      ),
    );
    const seen = new Set();
    const days = new Map();
    for (const week of weeks) {
      if (!Array.isArray(week)) continue;
      for (const l of week) {
        if (!l || l.lessonId == null || seen.has(l.lessonId)) continue;
        seen.add(l.lessonId);
        const at = parseDateTime(l.startDateTime);
        if (!at || at >= before) continue;
        const key = formatDate(at);
        const day = days.get(key) || { date: startOfDay(at), roster: new Set(), absent: new Set() };
        days.set(key, day);
        for (const p of Array.isArray(l.pupil) ? l.pupil : []) {
          if (p.notInClass) continue;
          day.roster.add(p.pupilId);
          if (!p.present) day.absent.add(p.pupilId);
        }
      }
    }
    return [...days.values()].filter((d) => d.roster.size).sort((a, b) => a.date - b.date);
  }

  // Fetched after the day is on screen, so hints never slow the teacher down.
  function loadHints() {
    const cls = currentClass();
    if (!cls) return;
    const key = historyKey(cls, state.date);
    if (historyLoads.has(key)) return;
    historyLoads.set(
      key,
      loadHistory(cls, state.date)
        .catch(() => [])
        .then((days) => {
          histories.set(key, days);
          if (state.open && currentClass() && historyKey(currentClass(), state.date) === key) render();
        }),
    );
  }

  function forgetHistory() {
    historyLoads.clear();
    histories.clear();
  }

  const onDay = (d) => WEEKDAYS[d.getDay()] + "ს"; // ორშაბათს
  const onEvery = (d) => WEEKDAYS[d.getDay()] + "ობით"; // ორშაბათობით

  function pupilHints(days, pupilId, anchor) {
    const mine = days.filter((d) => d.roster.has(pupilId));
    const notes = [];
    let alert = null;
    if (!mine.length) return { notes, alert };

    let streak = 0;
    for (let i = mine.length - 1; i >= 0 && mine[i].absent.has(pupilId); i--) streak++;
    const last = mine[mine.length - 1].date;

    if (streak >= 3) alert = `${streak} დღეა ზედიზედ აკლია`;
    else if (streak === 2) notes.push("ბოლო 2 დღე აკლდა");
    else if (streak === 1) notes.push(sameDay(last, addDays(anchor, -1)) ? "გუშინ აკლდა" : `${onDay(last)} აკლდა`);

    // Same weekday missed again and again: a club, a doctor, a parent's schedule.
    const sameWeekday = mine.filter((d) => d.date.getDay() === anchor.getDay());
    const missedThen = sameWeekday.filter((d) => d.absent.has(pupilId)).length;
    if (sameWeekday.length >= 3 && missedThen >= 3 && missedThen / sameWeekday.length >= 0.75) {
      notes.push(`${onEvery(anchor)} ხშირად აკლია`);
    }

    const missed = mine.filter((d) => d.absent.has(pupilId)).length;
    if (!alert && mine.length >= 8 && missed >= 5 && missed / mine.length >= 0.3) {
      alert = `ბოლო ${HISTORY_WEEKS} კვირაში ${missed} დღე აკლდა`;
    }
    return { notes, alert };
  }

  // Days where nobody is marked absent and the lock is close. Usually that's a day
  // that hasn't been filled in yet, which is exactly the Friday catch-up risk.
  function unfilledDays(days) {
    const today = startOfDay(new Date());
    return days
      .filter((d) => d.absent.size === 0 && d.date < today)
      .map((d) => ({ date: d.date, left: editDaysFor("other") - Math.round((today - d.date) / DAY_MS) }))
      .filter((d) => d.left >= 0 && d.left <= 2);
  }

  // --- state -----------------------------------------------------------------

  const state = {
    open: false,
    loading: false,
    saving: false,
    confirming: false,
    error: null,
    apiChanged: null,
    holiday: false,
    date: startOfDay(new Date()),
    classes: [],
    classKey: null,
    excluded: new Set(), // lesson keys the teacher unticked
    overrides: new Map(), // pupilId -> "absent" | "present", set by tapping
    results: new Map(), // lesson key -> { ok, reason }
    progress: null,
  };

  const currentClass = () => state.classes.find((c) => c.key === state.classKey) || null;
  const openLessons = (cls) => cls.lessons.filter((l) => lessonStatus(l) === "open");
  const targetLessons = (cls) => openLessons(cls).filter((l) => !state.excluded.has(l.key));

  // Absences carry forward: a pupil marked absent in an earlier open lesson is
  // assumed absent in later ones too, unless someone already set that lesson by hand.
  function wanted(cls, lesson, pupilId) {
    const o = state.overrides.get(pupilId);
    if (o) return o;
    const rec = record(lesson, pupilId);
    if (rec.touched) return rec.present ? "present" : "absent";
    const absentEarlier = openLessons(cls).some(
      (l) => l.startsAt < lesson.startsAt && l.pupils.has(pupilId) && isAbsent(l, pupilId),
    );
    return absentEarlier || !rec.present ? "absent" : "present";
  }

  function pupilView(cls, pupilId) {
    const lessons = targetLessons(cls).filter((l) => canEdit(l, pupilId));
    if (!lessons.length) {
      const anyAbsent = cls.lessons.some((l) => l.pupils.has(pupilId) && isAbsent(l, pupilId));
      return { status: anyAbsent ? "absent" : "present", excused: false, graded: false, carried: false };
    }
    const states = lessons.map((l) => wanted(cls, l, pupilId));
    const absentIn = states.filter((s) => s === "absent").length;
    return {
      status: absentIn === 0 ? "present" : absentIn === lessons.length ? "absent" : "mixed",
      excused: lessons.some((l) => record(l, pupilId).excused),
      graded: lessons.some((l) => record(l, pupilId).graded),
      carried: !state.overrides.has(pupilId) && lessons.some((l, i) => states[i] === "absent" && !isAbsent(l, pupilId)),
    };
  }

  function pendingWrites() {
    const cls = currentClass();
    if (!cls) return [];
    const writes = [];
    for (const lesson of targetLessons(cls)) {
      for (const p of cls.pupils) {
        if (!lesson.pupils.has(p.id) || !canEdit(lesson, p.id)) continue;
        const want = wanted(cls, lesson, p.id);
        const absent = isAbsent(lesson, p.id);
        if (want === "absent" && !absent && canMarkAbsent(lesson, p.id)) writes.push({ lesson, pupilId: p.id, method: "POST" });
        if (want === "present" && absent) writes.push({ lesson, pupilId: p.id, method: "DELETE" });
      }
    }
    return writes;
  }

  // Open on the class whose lesson is running now, or the one that started most recently.
  function bestClassKey() {
    const now = new Date();
    let best = null;
    for (const c of state.classes) {
      for (const l of c.lessons) {
        if (l.startsAt <= now && (!best || l.startsAt > best.at)) best = { key: c.key, at: l.startsAt };
      }
    }
    return best ? best.key : state.classes[0]?.key ?? null;
  }

  function selectClass(key) {
    state.classKey = key;
    state.overrides.clear();
    state.excluded.clear();
    state.results.clear();
    state.confirming = false;
    loadHints();
  }

  // Ordinary lessons decide how far back the teacher can go; summary exams stay open
  // for most of a year, which would only make the day list endless.
  const oldestEditableDay = () => addDays(startOfDay(new Date()), -editDaysFor("other"));

  // The school days the teacher can still fill in, oldest first. Many write the week's
  // absences on paper and enter them all on Friday, so these are one tap away.
  function recentDays() {
    const today = startOfDay(new Date());
    const oldest = oldestEditableDay();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      if (d >= oldest && d.getDay() !== 0) days.push(d);
    }
    return days;
  }

  // --- actions ---------------------------------------------------------------

  async function refresh() {
    await loadEditWindow();
    const day = await loadDay(state.date);
    state.holiday = day.holiday;
    state.classes = day.classes;
  }

  async function load(keepClass) {
    Object.assign(state, { loading: true, error: null, apiChanged: null, confirming: false });
    state.results.clear();
    render();
    try {
      await refresh();
      const keep = keepClass && state.classes.some((c) => c.key === state.classKey);
      selectClass(keep ? state.classKey : sameDay(state.date, new Date()) ? bestClassKey() : state.classes[0]?.key ?? null);
    } catch (e) {
      handleError(e);
    }
    state.loading = false;
    render();
  }

  async function open() {
    if (!readToken()) return;
    state.open = true;
    state.date = startOfDay(new Date());
    render();
    await loadConfig();
    await load(true);
  }

  function goToDay(next) {
    if (next > startOfDay(new Date()) || next < oldestEditableDay() || sameDay(next, state.date)) return;
    if (pendingWrites().length && !window.confirm("ამ დღის მონიშვნები ჯერ არ ჩაწერილა. მაინც გადავიდეთ?")) return;
    state.date = next;
    load(true); // stay on the same class, the teacher is usually going through one class's week
  }

  const changeDay = (delta) => goToDay(addDays(state.date, delta));

  function handleError(e) {
    if (e instanceof ApiChanged) state.apiChanged = e.message;
    else if (e instanceof NotLoggedIn) state.error = { text: "საიტიდან გამოგიყვანათ. შედით თავიდან." };
    else state.error = { text: "ვერ ჩაიტვირთა. შეამოწმეთ ინტერნეტი.", detail: e.message, retry: true };
  }

  async function save() {
    const writes = pendingWrites();
    const failures = new Map(); // lesson key -> reason
    const expected = writes.map((w) => ({ key: w.lesson.key, pupilId: w.pupilId, absent: w.method === "POST" }));

    Object.assign(state, { saving: true, confirming: false });
    state.results.clear();
    render();

    for (const [i, w] of writes.entries()) {
      state.progress = `${i + 1}/${writes.length}`;
      render();
      try {
        await request(w.method, fillPath(config.paths.absence, { lessonId: w.lesson.id, pupilId: w.pupilId }));
      } catch (e) {
        if (e instanceof NotLoggedIn) {
          state.error = { text: "საიტიდან გამოგიყვანათ. შედით თავიდან და ისევ ჩაწერეთ." };
          break;
        }
        failures.set(w.lesson.key, e instanceof Rejected ? SERVER_ERRORS[e.code] || e.code : e.message);
      }
      await sleep(config.writeDelayMs);
    }

    // Don't trust the writes; read the journal back and compare.
    state.progress = "ვამოწმებ";
    render();
    const touchedLessons = [...new Set(writes.map((w) => w.lesson.key))];
    try {
      await refresh();
      const cls = currentClass();
      for (const key of touchedLessons) {
        const lesson = cls?.lessons.find((l) => l.key === key);
        const ok =
          lesson &&
          expected.filter((x) => x.key === key).every((x) => !lesson.pupils.has(x.pupilId) || isAbsent(lesson, x.pupilId) === x.absent);
        state.results.set(key, { ok: Boolean(ok) && !failures.has(key), reason: failures.get(key) });
      }
      state.overrides.clear();
      forgetHistory(); // a past day may have changed, and with it the streaks
      loadHints();
    } catch (e) {
      state.error = { text: "ჩაწერა დასრულდა, მაგრამ ვერ შევამოწმე. ნახეთ საიტზე, ჩაიწერა თუ არა.", retry: true };
    }
    state.saving = false;
    render();
  }

  function togglePupil(pupilId) {
    const cls = currentClass();
    const next = pupilView(cls, pupilId).status === "absent" ? "present" : "absent";
    state.overrides.set(pupilId, next);
    // Drop the override if it matches what would happen anyway.
    const lessons = targetLessons(cls).filter((l) => canEdit(l, pupilId));
    state.overrides.delete(pupilId);
    if (lessons.some((l) => wanted(cls, l, pupilId) !== next)) state.overrides.set(pupilId, next);
    state.results.clear();
    state.confirming = false;
  }

  function toggleLesson(key) {
    if (state.excluded.has(key)) state.excluded.delete(key);
    else state.excluded.add(key);
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
      background: #2f5d4e; color: #fff; font-size: 17px; font-weight: 700;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
    }

    .panel {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; flex-direction: column;
      background: #fbfcf9; color: #1d2a24;
      padding-top: env(safe-area-inset-top, 0px);
    }
    .head { display: grid; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #d6ddd6; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .day { display: flex; align-items: center; gap: 4px; }
    .day span { min-width: 0; font-size: 15px; font-weight: 600; }
    .nav { width: 42px; height: 42px; border: 1px solid #d6ddd6; border-radius: 10px; background: none; font-size: 16px; }
    .nav:disabled { opacity: .3; }
    h1 { margin: 0; font-size: 21px; }
    .close { flex: none; width: 44px; height: 44px; border: 0; border-radius: 999px; background: #e9ece6; font-size: 18px; }
    .badge { padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #dfeae4; color: #2f5d4e; white-space: nowrap; }
    .badge.warn { background: #fbefd9; color: #b7791f; }
    .days { display: flex; gap: 6px; margin: 8px 0 4px; }
    .dayBtn { flex: 1; min-width: 0; min-height: 52px; padding: 4px 0; border: 1px solid #d6ddd6; border-radius: 12px; background: none; font-size: 13px; line-height: 1.2; color: inherit; }
    .dayBtn b { display: block; font-size: 18px; }
    .dayBtn.on { background: #2f5d4e; border-color: #2f5d4e; color: #fff; }
    .classes { display: flex; flex-wrap: wrap; gap: 8px; }
    .class { padding: 10px 18px; border: 1px solid #d6ddd6; border-radius: 999px; background: none; font-size: 16px; font-weight: 600; }
    .class.on { background: #2f5d4e; border-color: #2f5d4e; color: #fff; }

    .body { flex: 1; overflow-y: auto; padding: 8px 16px 150px; }
    .label { margin: 14px 0 8px; font-size: 14px; font-weight: 700; color: #5f6d66; }

    .lessons { display: grid; gap: 6px; }
    .lesson {
      display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 10px;
      min-height: 50px; padding: 10px 12px; border: 1px solid #d6ddd6; border-radius: 12px; background: none; text-align: left; font-size: 16px;
    }
    .check { display: grid; place-items: center; width: 20px; height: 20px; border: 2px solid #d6ddd6; border-radius: 6px; color: #fff; font-size: 13px; }
    .lesson.on .check { background: #2f5d4e; border-color: #2f5d4e; }
    .lesson:disabled { opacity: .6; }
    .lesson .side { font-size: 14px; color: #5f6d66; text-align: right; font-variant-numeric: tabular-nums; }
    .ok { font-weight: 700; color: #2e7d4f; }
    .fail { font-weight: 700; color: #c4472f; }
    .reason { grid-column: 2 / -1; font-size: 14px; color: #c4472f; }

    .tally { display: flex; gap: 16px; margin: 4px 0 8px; font-size: 16px; }
    .tally .absent b { color: #c4472f; }
    .pupil {
      display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 10px;
      width: 100%; min-height: 58px; padding: 10px 4px;
      border: 0; border-bottom: 1px solid #d6ddd6; background: none; text-align: left; font-size: 17px;
    }
    .pupil:disabled { cursor: default; }
    .num { font-size: 13px; color: #5f6d66; font-variant-numeric: tabular-nums; }
    .who { display: grid; gap: 2px; min-width: 0; }
    .note { font-size: 13px; color: #5f6d66; }
    .note.alert { font-weight: 700; color: #b7791f; }
    .remind { display: block; width: 100%; margin: 8px 0; padding: 12px 14px; border: 1px solid #f0d9a8; border-radius: 12px; background: #fbefd9; color: #1d2a24; font-size: 15px; line-height: 1.5; text-align: left; }
    .remind b { display: block; }
    .remind u { font-weight: 700; color: #b7791f; }
    .tag { padding: 6px 12px; border-radius: 999px; background: #dfeae4; color: #2f5d4e; font-size: 14px; font-weight: 600; white-space: nowrap; }
    .pupil.absent { background: #f8e1da; }
    .pupil.absent .tag { background: #c4472f; color: #fff; }
    .pupil.mixed .tag { background: #fbefd9; color: #b7791f; }

    .footer {
      position: fixed; left: 0; right: 0; bottom: 0;
      padding: 12px 16px calc(18px + env(safe-area-inset-bottom, 0px));
      background: linear-gradient(to top, #fbfcf9 75%, rgba(251, 252, 249, 0));
    }
    .save { width: 100%; padding: 16px; border: 0; border-radius: 16px; background: #2f5d4e; color: #fff; font-size: 18px; font-weight: 700; }
    .save:disabled { opacity: .45; }
    .hint { margin-top: 7px; font-size: 14px; line-height: 1.4; color: #5f6d66; text-align: center; }

    .notice { margin: 8px 0; padding: 16px; border-radius: 14px; background: #fbefd9; font-size: 16px; line-height: 1.5; }
    .retry { display: block; width: 100%; margin-top: 12px; padding: 14px; border: 0; border-radius: 12px; background: #2f5d4e; color: #fff; font-size: 16px; font-weight: 700; }
    .notice b { color: #b7791f; }
    .notice small { display: block; margin-top: 8px; font-size: 12px; color: #5f6d66; word-break: break-word; }
    .info { margin: 8px 0; padding: 12px 14px; border-radius: 12px; background: #dfeae4; color: #1d2a24; font-size: 15px; line-height: 1.5; }
    .empty { padding: 30px 6px; text-align: center; font-size: 17px; line-height: 1.6; color: #5f6d66; }

    .confirm { display: grid; gap: 10px; padding: 14px; border: 1px solid #d6ddd6; border-radius: 16px; background: #fbfcf9; box-shadow: 0 -6px 20px rgba(0, 0, 0, .08); font-size: 17px; line-height: 1.5; }
    .confirm p { margin: 0; }
    .confirm .buttons { display: flex; gap: 8px; }
    .confirm button { flex: 1; padding: 15px; border: 1px solid #d6ddd6; border-radius: 12px; background: none; font-size: 17px; font-weight: 700; }
    .confirm .go { background: #c4472f; border-color: #c4472f; color: #fff; }
  `;

  const host = document.createElement("div");
  host.id = "jurnali";
  const root = host.attachShadow({ mode: "open" });

  function viewLesson(l) {
    const status = lessonStatus(l);
    const usable = status === "open" && !state.saving;
    const on = status === "open" && !state.excluded.has(l.key);
    const result = state.results.get(l.key);
    let side;
    if (result) side = result.ok ? `<span class="ok">✓ ჩაიწერა</span>` : `<span class="fail">✗ არ ჩაიწერა</span>`;
    else if (status === "upcoming") side = `იწყება ${l.start}-ზე`;
    else if (status === "closed") side = `🔒 დრო გავიდა`;
    else if (status === "locked") side = `🔒 ${l.start}`;
    else side = l.start;
    return `<button class="lesson ${on ? "on" : ""}" data-action="lesson" data-key="${escapeHtml(l.key)}" ${usable ? "" : "disabled"}>
      <span class="check">${on ? "✓" : ""}</span><span>${escapeHtml(l.subject)}</span><span class="side">${side}</span>
      ${result && result.reason ? `<span class="reason">${escapeHtml(result.reason)}</span>` : ""}
    </button>`;
  }

  function viewPupils(cls) {
    const editable = targetLessons(cls).length > 0 && !state.saving;
    const views = cls.pupils.map((p) => [p, pupilView(cls, p.id)]);
    const absent = views.filter(([, v]) => v.status === "absent").length;
    const tags = { absent: "აკლია", present: "ესწრება", mixed: "ზოგან აკლია" };
    const days = histories.get(historyKey(cls, state.date)) || [];
    const rows = views.map(([p, v], i) => {
      const hints = pupilHints(days, p.id, state.date);
      const notes = [];
      if (v.carried) notes.push("წინა გაკვეთილზეც აკლდა");
      if (v.graded) notes.push("ნიშანი უწერია");
      notes.push(...hints.notes);
      const lines = [
        hints.alert ? `<span class="note alert">⚠ ${hints.alert}</span>` : "",
        notes.length ? `<span class="note">${notes.join(" · ")}</span>` : "",
      ].join("");
      const tag = v.status === "absent" && v.excused ? "საპატიო" : tags[v.status];
      return `<button class="pupil ${v.status}" data-action="pupil" data-id="${p.id}" ${editable ? "" : "disabled"}>
        <span class="num">${pad2(i + 1)}</span>
        <span class="who"><span>${escapeHtml(p.name)}</span>${lines}</span>
        <span class="tag">${tag}</span>
      </button>`;
    });
    return `<div class="label">${editable ? "ვინც აკლია, დააჭირეთ" : "მოსწავლეები"}</div>
      <div class="tally"><span>ესწრება: <b>${cls.pupils.length - absent}</b></span><span class="absent">აკლია: <b>${absent}</b></span></div>
      ${rows.join("")}`;
  }

  function viewBody(cls) {
    if (state.loading) return `<div class="empty">იტვირთება…</div>`;
    if (config.disabled) {
      return `<div class="notice"><b>დროებით გამორთულია.</b> ${escapeHtml(config.message || "დღეს დასწრება საიტზე შეავსეთ, ჩვეულებრივად.")}</div>`;
    }
    if (state.apiChanged) {
      return `<div class="notice"><b>საიტი შეიცვალა.</b> ჩაწერა დროებით გამოვრთეთ, რომ ჟურნალში შეცდომა არ მოხვდეს. დღეს დასწრება საიტზე შეავსეთ, ჩვეულებრივად.
        <small>${escapeHtml(state.apiChanged)}</small></div>`;
    }
    if (state.error) {
      const { text, detail, retry } = state.error;
      return `<div class="notice">${escapeHtml(text)}
        ${retry ? `<button class="retry" data-action="retry">თავიდან ცდა</button>` : ""}
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
    }
    if (state.holiday) return `<div class="empty">ამ დღეს დასვენებაა.</div>`;
    if (!cls) return `<div class="empty">ამ დღეს გაკვეთილები არ გაქვთ.</div>`;

    let info = "";
    const upcoming = cls.lessons.filter((l) => lessonStatus(l) === "upcoming").length;
    if (!openLessons(cls).length && upcoming) {
      info = `<div class="info">დასწრებას გაკვეთილის დაწყების შემდეგ ჩაწერთ. ვისაც ახლა მონიშნავთ, მომდევნო გაკვეთილზეც მონიშნული დაგხვდებათ.</div>`;
    } else if (upcoming) {
      info = `<div class="info">ვინც დღეს აკლია, მომდევნო გაკვეთილზეც მონიშნული დაგხვდებათ. დარჩა ${upcoming} გაკვეთილი.</div>`;
    }
    return `${viewReminders(cls)}<div class="label">სად ჩაიწეროს</div><div class="lessons">${cls.lessons.map(viewLesson).join("")}</div>${info}${viewPupils(cls)}`;
  }

  // Only on today's screen: a nudge for a day that's about to lock with nobody marked.
  function viewReminders(cls) {
    if (!sameDay(state.date, new Date())) return "";
    const days = histories.get(historyKey(cls, state.date)) || [];
    return unfilledDays(days)
      .map(({ date, left }) => {
        const when = left === 0 ? "შევსება მხოლოდ დღეს შეიძლება" : `შევსება კიდევ ${left + 1} დღე შეიძლება`;
        return `<button class="remind" data-action="day" data-time="${date.getTime()}">
          <b>${escapeHtml(onDay(date))} (${date.getDate()} ${MONTHS[date.getMonth()]}) ${escapeHtml(cls.key)}-ში არავის აკლია.</b>
          თუ ჯერ არ შეგივსიათ, ${when}. <u>გადასვლა</u></button>`;
      })
      .join("");
  }

  function viewConfirm() {
    const writes = pendingWrites();
    const marks = writes.filter((w) => w.method === "POST").length;
    const unmarks = writes.length - marks;
    const lessons = new Set(writes.map((w) => w.lesson.key)).size;
    return `<div class="confirm">
      <p>${marks ? `ჩაიწერება <b>${marks}</b> გაცდენა` : ""}${marks && unmarks ? ", " : ""}${unmarks ? `წაიშლება <b>${unmarks}</b> გაცდენა` : ""}, ${lessons} გაკვეთილზე.</p>
      <div class="buttons"><button data-action="cancel">უკან</button><button class="go" data-action="confirm">დიახ, ჩაწერე</button></div>
    </div>`;
  }

  function viewFooter(cls) {
    if (!cls || state.loading || state.error || state.apiChanged || config.disabled) return "";
    if (state.confirming) return `<div class="footer">${viewConfirm()}</div>`;
    const n = pendingWrites().length;
    const label = state.saving ? `იწერება… ${state.progress || ""}` : n ? `ჟურნალში ჩაწერა (${n})` : "ყველაფერი ჩაწერილია ✓";
    return `<div class="footer">
      <button class="save" data-action="save" ${state.saving || !n ? "disabled" : ""}>${label}</button>
      <div class="hint">ვისაც არ დააჭერთ, ჟურნალში „ესწრება“ ეწერება</div>
    </div>`;
  }

  function render() {
    if (!state.open) {
      root.innerHTML = `<style>${STYLES}</style>` +
        (isLoggedIn() ? `<button class="launcher" data-action="open">✓ დასწრება</button>` : "");
      return;
    }

    const cls = currentClass();
    const broken = state.apiChanged || config.disabled;
    const isToday = sameDay(state.date, new Date());
    const canBack = !state.loading && !state.saving && addDays(state.date, -1) >= oldestEditableDay();
    const scroll = root.querySelector(".body")?.scrollTop || 0;

    root.innerHTML = `<style>${STYLES}</style>
      <div class="panel">
        <div class="head">
          <div class="row">
            <div class="day">
              <button class="nav" data-action="prev" aria-label="წინა დღე" ${canBack ? "" : "disabled"}>‹</button>
              <span>${isToday ? "დღეს · " : ""}${escapeHtml(longDate(state.date))}</span>
              <button class="nav" data-action="next" aria-label="შემდეგი დღე" ${!isToday && !state.loading && !state.saving ? "" : "disabled"}>›</button>
            </div>
            <button class="close" data-action="close" aria-label="დახურვა">✕</button>
          </div>
          <div class="days">${recentDays()
            .map((d) => `<button class="dayBtn ${sameDay(d, state.date) ? "on" : ""}" data-action="day" data-time="${d.getTime()}" ${state.loading || state.saving ? "disabled" : ""}>${SHORT_WEEKDAYS[d.getDay()]}<b>${d.getDate()}</b></button>`)
            .join("")}</div>
          <div class="row">
            <h1>დასწრება</h1>
            ${broken ? `<span class="badge warn">ჩაწერა გამორთულია</span>` : ""}
          </div>
          ${state.classes.length > 1 ? `<div class="classes">${state.classes
            .map((c) => `<button class="class ${c.key === state.classKey ? "on" : ""}" data-action="class" data-key="${escapeHtml(c.key)}">${escapeHtml(c.key)}</button>`)
            .join("")}</div>` : ""}
        </div>
        <div class="body">${viewBody(cls)}</div>
        ${viewFooter(cls)}
      </div>`;

    const body = root.querySelector(".body");
    if (body) body.scrollTop = scroll;
  }

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    switch (el.dataset.action) {
      case "open": open(); return;
      case "close": state.open = false; break;
      case "prev": changeDay(-1); return;
      case "next": changeDay(1); return;
      case "day": goToDay(new Date(Number(el.dataset.time))); return;
      case "class": selectClass(el.dataset.key); break;
      case "lesson": toggleLesson(el.dataset.key); break;
      case "pupil": togglePupil(Number(el.dataset.id)); break;
      case "save": state.confirming = true; break;
      case "cancel": state.confirming = false; break;
      case "confirm": save(); return;
      case "retry": load(true); return;
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
    fixLoginForm();
    answerIdlePrompt();
    reportSession();
    if (!host.isConnected) document.body.appendChild(host);
    const loggedIn = isLoggedIn();
    if (loggedIn === lastLoggedIn) return;
    lastLoggedIn = loggedIn;
    if (!loggedIn) state.open = false;
    render();
  }

  // Lessons open as the day goes on; refresh their status while the panel is up.
  setInterval(() => {
    if (state.open && !state.loading && !state.saving && !state.confirming) render();
  }, 30000);

  sync();
  setInterval(sync, 1500);
  watchLogout();
  keepSessionAlive();
  stayActive();

  window.Jurnali = { version: VERSION, open, refreshSession };
})();
