/* DentPark — квиз-сайт по имплантации на 4–6 имплантах.
   Без зависимостей. Должно работать на телефоне 2018 года.

   Один файл обслуживает обе языковые версии. Ни одной русской или
   румынской строки здесь нет: всё, что видит человек, лежит в разметке
   (data-msg-*, data-recap). Перевод — это правка HTML, не правка кода.

   Шаги: вопросы по порядку в разметке · пауза расчёта · контакты. */

(function () {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ==========================================================
     META PIXEL

     ⚠️ Сюда вписать ID пикселя. Это НЕ секрет: он виден в коде
     любой страницы с пикселем, ему тут и место. Секрет — токен
     CAPI, он лежит в config.php вне webroot и в браузер не попадает.
     Пусто — пиксель просто не грузится, остальное работает.
     ========================================================== */

  var PIXEL_ID = '';

  /* Единый ID посетителя. Поднимает качество сопоставления в Meta
     и связывает браузерное событие с серверным. Не персональные
     данные — случайная строка, живёт в localStorage. */
  var externalId = '';
  try {
    externalId = localStorage.getItem('dp_xid') || '';
    if (!externalId) {
      externalId = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('dp_xid', externalId);
    }
  } catch (e) {}

  function loadPixel() {
    if (!PIXEL_ID || window.fbq) return;
    /* Официальный снипет Meta. Скрипт грузится асинхронно и разбор
       страницы не задерживает; сам quiz.js стоит с defer, поэтому
       к этому моменту разметка уже отрисована и LCP не страдает. */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    window.fbq('init', PIXEL_ID, externalId ? { external_id: externalId } : {});
    window.fbq('track', 'PageView');
  }

  loadPixel();

  /* ==========================================================
     Аналитика — одна точка входа.
     dataLayer для GTM/GA4, fbq для Meta. Имена событий в разметке
     не встречаются: разметка только помечает клики через data-ev.
     ========================================================== */

  window.dataLayer = window.dataLayer || [];

  /* Что уходит в Meta под каким именем. Lead — стандартное событие,
     на нём оптимизируется кампания; остальные кастомные, они нужны
     для воронки и аудиторий ретаргета. */
  var FB_EVENT = {
    quiz_view:       ['trackCustom', 'QuizView'],
    quiz_start:      ['trackCustom', 'QuizStart'],
    quiz_step:       ['trackCustom', 'QuizStep'],
    quiz_calc:       ['trackCustom', 'QuizComplete'],
    click_whatsapp:  ['trackCustom', 'ContactWhatsApp'],
    click_call:      ['trackCustom', 'ContactCall'],
    lead:            ['track',       'Lead']
  };

  function track(name, params, opts) {
    var p = params || {};
    window.dataLayer.push(Object.assign({ event: name }, p));

    var fb = FB_EVENT[name];
    if (window.fbq && fb) window.fbq(fb[0], fb[1], p, opts || {});
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-ev]');
    if (el) track(el.getAttribute('data-ev'));
  });

  /* ==========================================================
     UTM и рекламные метки. Забираем при заходе и держим:
     человек может уйти на звонок и вернуться на страницу.
     ========================================================== */

  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

  function cookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : '';
  }

  var marks = {};

  (function keepMarks() {
    var q = new URLSearchParams(location.search);
    try { marks = JSON.parse(sessionStorage.getItem('dp_marks') || '{}'); } catch (e) {}

    KEYS.forEach(function (k) { if (q.get(k)) marks[k] = q.get(k); });

    /* _fbp и _fbc ставит сам пиксель. Он грузится асинхронно, поэтому
       на первом кадре кук ещё нет — перечитываем их перед отправкой. */
    marks.page_url = location.href;

    try { sessionStorage.setItem('dp_marks', JSON.stringify(marks)); } catch (e) {}
  })();

  function freshMarks() {
    var out = {};
    Object.keys(marks).forEach(function (k) { out[k] = marks[k]; });
    out.fbp = cookie('_fbp');
    out.fbc = cookie('_fbc') || (marks.fbclid ? 'fb.1.' + Date.now() + '.' + marks.fbclid : '');
    out.external_id = externalId;
    return out;
  }

  /* ==========================================================
     Телефон: маска +373 XX XXX XXX
     ========================================================== */

  /** Из любого ввода достаём 8 местных цифр: 060…, +373…, 00373…, с пробелами.
      Поле уже начинается с «+373 », а человек по привычке набирает поверх
      «069…» или «+373 69…». Раньше ноль после кода страны оставался в номере:
      «069123456» превращалось в +373 06 912 345 — восемь цифр, проверка
      проходит, а перезвонить некуда. Поэтому код страны снимаем столько
      раз, сколько его набрали, и ноль после него тоже. */
  function localPart(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    while (d.indexOf('373') === 0) d = d.slice(3);
    if (d.charAt(0) === '0') d = d.slice(1);
    return d.slice(0, 8);
  }

  function formatPhone(raw) {
    var d = localPart(raw);
    // код страны остаётся на месте, пока в поле есть хоть одна цифра
    if (!d) return /\d/.test(String(raw)) ? '+373 ' : '';
    var out = '+373 ' + d.slice(0, 2);
    if (d.length > 2) out += ' ' + d.slice(2, 5);
    if (d.length > 5) out += ' ' + d.slice(5, 8);
    return out;
  }

  /* ==========================================================
     КВИЗ
     ========================================================== */

  var form = document.getElementById('quiz');
  if (!form) return;

  /** Вся видимая человеком строка приходит из разметки. */
  function T(key) { return form.getAttribute('data-msg-' + key) || ''; }

  /* Сколько вопросов — считаем по разметке, а не числом в коде.
     Убрать или добавить вопрос = один <fieldset> в HTML, и всё:
     прогресс, счётчик, кнопка «назад» и порядок пересчитаются сами. */

  var qSteps = [].slice.call(form.querySelectorAll('.step')).filter(function (el) {
    return el.querySelector('.opt');
  });
  var calcEl  = form.querySelector('.calc');
  var formEl  = form.querySelector('.step--form');
  var screens = qSteps.concat([calcEl, formEl]);

  var QUESTIONS = qSteps.length;
  var CALC = QUESTIONS;
  var FORM = QUESTIONS + 1;

  /* Ключи вопросов — в том порядке, в каком они стоят в разметке */
  var order = qSteps.map(function (el) {
    return el.querySelector('.opt').getAttribute('data-q');
  });

  var prog    = document.getElementById('prog');
  var progNum = form.querySelector('.prog__num');
  var barBox  = form.querySelector('.prog__bar');
  var qBack   = document.getElementById('qBack');
  var submit  = document.getElementById('qSubmit');
  var recapEl = document.getElementById('recap');

  barBox.innerHTML = new Array(QUESTIONS + 1).join('<i></i>');
  var bars = [].slice.call(barBox.children);

  var step = 0;
  var answers = {};
  var seen = {};        // какие шаги уже ушли в аналитику
  var started = false;  // событие quiz_start шлём один раз
  var calced  = false;  // и quiz_calc тоже: «назад» и другой ответ его повторяли
  var pinned = false;   // карточку к верху экрана подводим ровно один раз

  try { answers = JSON.parse(sessionStorage.getItem('dp_kviz') || '{}'); } catch (e) {}

  function save() {
    try { sessionStorage.setItem('dp_kviz', JSON.stringify(answers)); } catch (e) {}
  }

  /** Короткая подпись ответа для сводки. Лежит на самой кнопке,
      поэтому перевод не требует правки скрипта. */
  function labelOf(q, v) {
    var b = form.querySelector('.opt[data-q="' + q + '"][data-v="' + v + '"]');
    if (!b) return '';
    return b.getAttribute('data-recap') || b.textContent.trim();
  }

  function renderRecap() {
    var out = [];
    order.forEach(function (k) {
      var s = answers[k] ? labelOf(k, answers[k]) : '';
      if (s) out.push(s);
    });
    // без выделения: жирным весь блок спорит с формой за внимание
    recapEl.textContent = out.length ? out.join(' · ') : '—';
  }

  /* --- переключение шагов --- */

  function go(n) {
    step = n;

    screens.forEach(function (el, i) { el.classList.toggle('is-on', i === n); });

    var onQuestion = n < QUESTIONS;

    // текущий шаг тоже закрашен: иначе на первом вопросе полоса пустая
    bars.forEach(function (li, i) {
      li.classList.toggle('is-done', onQuestion ? i <= n : true);
    });

    prog.hidden = n === CALC;
    if (onQuestion) {
      progNum.innerHTML = T('step')
        .replace('{n}', '<b>' + (n + 1) + '</b>')
        .replace('{total}', QUESTIONS);
    } else if (n === FORM) {
      progNum.textContent = T('done');
    }

    qBack.hidden = n === 0 || n === CALC;

    // панель внизу перестала бы спорить с главной кнопкой
    document.body.classList.toggle('is-form', n === FORM);

    if (onQuestion && !seen[n]) {
      seen[n] = true;
      track('quiz_step', { step: n + 1, quiz: 'allon' });
    }

    if (n === FORM) {
      renderRecap();
      var f = document.getElementById('qName');
      if (isNear(form)) setTimeout(function () { f.focus({ preventScroll: true }); }, 60);
    }
  }

  function isNear(el) {
    var r = el.getBoundingClientRect();
    return r.top < innerHeight && r.bottom > 0;
  }

  /* --- выбор ответа: сразу ведёт дальше, без кнопки «Далее» --- */

  form.addEventListener('click', function (e) {
    var opt = e.target.closest('.opt');
    if (!opt) return;

    if (!started) { started = true; track('quiz_start', { quiz: 'allon' }); }

    answers[opt.getAttribute('data-q')] = opt.getAttribute('data-v');
    save();

    opt.parentNode.querySelectorAll('.opt').forEach(function (b) {
      b.classList.toggle('is-picked', b === opt);
    });

    /* После первого ответа поднимаем карточку к верху экрана: дальше
       вопросы идут на полном экране, а не в нижней его трети.
       Ровно один раз — если человек сам отлистал вверх перечитать,
       мы с ним не спорим. */
    if (!pinned) {
      pinned = true;
      var top = form.getBoundingClientRect().top + window.scrollY - 12;
      if (top > window.scrollY + 8) {
        window.scrollTo({ top: top, behavior: reduce ? 'auto' : 'smooth' });
      }
    }

    if (step < QUESTIONS - 1) {
      setTimeout(function () { go(step + 1); }, reduce ? 0 : 170);
    } else {
      go(CALC);
      if (!calced) { calced = true; track('quiz_calc', { quiz: 'allon' }); }
      setTimeout(function () { go(FORM); }, reduce ? 200 : 1300);
    }
  });

  qBack.addEventListener('click', function () {
    go(step === FORM ? QUESTIONS - 1 : Math.max(0, step - 1));
  });

  /* --- телефон --- */

  var phone = document.getElementById('qPhone');
  phone.addEventListener('focus', function () { if (!phone.value) phone.value = '+373 '; });
  phone.addEventListener('input', function () {
    phone.value = formatPhone(phone.value);
    clearErr(phone, 'phone');
  });
  phone.addEventListener('blur', function () { if (phone.value.trim() === '+373') phone.value = ''; });

  /* --- валидация. Ошибка словами, а не красной рамкой молча --- */

  function errBox(key) { return form.querySelector('[data-err="' + key + '"]'); }

  function setErr(el, key, msg) {
    var b = errBox(key);
    b.textContent = msg;
    b.classList.add('is-on');
    if (el) el.setAttribute('aria-invalid', 'true');
  }

  function clearErr(el, key) {
    errBox(key).classList.remove('is-on');
    if (el) el.removeAttribute('aria-invalid');
  }

  var nameEl  = document.getElementById('qName');
  var agreeEl = document.getElementById('qAgree');

  nameEl.addEventListener('input', function () { clearErr(nameEl, 'name'); });
  agreeEl.addEventListener('change', function () { clearErr(null, 'agree'); });

  function validate() {
    var ok = true;

    if (nameEl.value.trim().length < 2) { setErr(nameEl, 'name', T('name')); ok = false; }
    if (localPart(phone.value).length !== 8) { setErr(phone, 'phone', T('phone')); ok = false; }
    if (!agreeEl.checked) { setErr(null, 'agree', T('agree')); ok = false; }

    return ok;
  }

  /* --- отправка ---
     На «спасибо» уходим в любом случае: заявка уже записана
     на сервере, терять человека из-за сети нельзя. */

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!validate()) {
      (form.querySelector('[aria-invalid="true"]') || agreeEl).focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = T('sending');

    var name  = nameEl.value.trim();
    var local = localPart(phone.value);

    /* Общий ключ для браузерного и серверного события. Без него Meta
       засчитает одну заявку дважды и испортит обучение кампании. */
    var eventId = 'lead.' + Date.now() + '.' + Math.random().toString(36).slice(2, 10);

    var payload = {
      lang: document.documentElement.lang,
      quiz_type: 'allon',
      event_id: eventId,
      consent: true,                               // чекбокс отмечен: без него validate() не пропустил бы
      name: name,
      phone: '+373' + local,
      entry: answers.entry || '',
      fax: document.getElementById('qFax').value   // honeypot
    };
    order.forEach(function (k) { payload[k] = answers[k] || ''; });

    var m = freshMarks();
    Object.keys(m).forEach(function (k) { if (!(k in payload)) payload[k] = m[k]; });

    /* Расширенное сопоставление: телефон и имя Meta хеширует у себя
       в браузере, сырыми они никуда не уходят. То же самое уезжает
       с сервера в CAPI уже хешированным — события склеятся. */
    if (window.fbq && PIXEL_ID) {
      window.fbq('init', PIXEL_ID, {
        ph: '373' + local,
        fn: name.toLowerCase(),
        country: 'md',
        external_id: externalId
      });
    }

    track('lead', { quiz: 'allon', content_category: 'implant' }, { eventID: eventId });

    var done = function () {
      try { sessionStorage.removeItem('dp_kviz'); } catch (e) {}
      location.href = form.getAttribute('data-thanks') || 'spasibo.html';
    };

    fetch('../../api/lead.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(done, done);
  });

  /* ==========================================================
     Старт.
     1. Отмечаем уже выбранные ответы после обновления страницы.
     2. Креатив может привести с готовым первым ответом:
        ?s=none — тогда первый вопрос пропускается.
     3. Возвращаем человека на первый неотвеченный вопрос.
     ========================================================== */

  var qs = new URLSearchParams(location.search);
  var preset = qs.get('s');

  if (preset && form.querySelector('.opt[data-q="' + order[0] + '"][data-v="' + preset + '"]')) {
    answers[order[0]] = preset;
    answers.entry = qs.get('entry') || ('ad_' + preset);
    save();
  }

  Object.keys(answers).forEach(function (k) {
    var b = form.querySelector('.opt[data-q="' + k + '"][data-v="' + answers[k] + '"]');
    if (b) b.classList.add('is-picked');
  });

  var first = 0;
  while (first < QUESTIONS && answers[order[first]]) first++;

  track('quiz_view', { quiz: 'allon', content_category: 'implant' });
  go(first === QUESTIONS ? FORM : first);

  /* ==========================================================
     Липкая панель. Появляется, когда верхняя полоса уехала.
     ========================================================== */

  var dock = document.getElementById('dock');

  if (dock) {
    var apply = function () {
      dock.classList.toggle('is-on', window.scrollY > 140);
    };
    addEventListener('scroll', apply, { passive: true });
    apply();
  }

})();
