/* DentPark — лендинг по имплантологии
   Без зависимостей. Всё, что здесь есть, должно работать на телефоне 2018 года.

   Один файл на обе языковые версии, /ro/ и /ru/. Ни одной видимой
   человеку строки здесь нет: тексты ошибок, адрес страницы «спасибо»
   и подписи лежат в разметке (data-* на <body> и на элементах).
   Перевод — это правка разметки, не правка кода. */

(function () {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Видимая строка из разметки: <body data-msg-name-required="…">. */
  function T(key) { return document.body.getAttribute('data-msg-' + key) || ''; }

  function thanksUrl() { return document.body.getAttribute('data-thanks') || 'spasibo.html'; }

  /* ==========================================================
     Аналитика — единая точка. Пишет в dataLayer; GTM/пиксель
     подключаются без правки разметки.

     В события НЕ попадают ответы квиза, имя, телефон и любой
     текст из полей: человек рассказывает о здоровье, а рекламные
     платформы получают только номер шага и тип действия
     Пакет и сегмент — коммерческие метки
     карточек, не данные пациента.
     ========================================================== */

  window.dataLayer = window.dataLayer || [];

  function track(name, params) {
    window.dataLayer.push(Object.assign({ event: name }, params || {}));
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-ev]');
    if (!el) return;
    var p = {};
    if (el.hasAttribute('data-package')) p.package = el.getAttribute('data-package');
    if (el.hasAttribute('data-segment')) p.segment = el.getAttribute('data-segment');
    track(el.getAttribute('data-ev'), p);
  });

  track('landing_view', { locale: document.documentElement.lang });

  /* ==========================================================
     Телефон и отправка — общее для квиза и короткой формы
     ========================================================== */

  /** Из любого ввода достаём 8 местных цифр: 060…, +373…, 00373…, с пробелами.
      Поле уже начинается с «+373 », а человек по привычке набирает поверх
      «069…» или «+373 69…». Код страны снимаем столько раз, сколько его
      набрали, и ноль после него тоже. */
  function localPart(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    while (d.indexOf('373') === 0) d = d.slice(3);
    if (d.charAt(0) === '0') d = d.slice(1);
    return d.slice(0, 8);
  }

  function formatPhone(raw) {
    var d = localPart(raw);
    if (!d) return /\d/.test(String(raw)) ? '+373 ' : '';
    var out = '+373 ' + d.slice(0, 2);
    if (d.length > 2) out += ' ' + d.slice(2, 5);
    if (d.length > 5) out += ' ' + d.slice(5, 8);
    return out;
  }

  function wirePhone(el, onType) {
    el.addEventListener('focus', function () { if (!el.value) el.value = '+373 '; });
    el.addEventListener('input', function () { el.value = formatPhone(el.value); if (onType) onType(); });
    el.addEventListener('blur',  function () { if (el.value.trim() === '+373') el.value = ''; });
  }

  /** POST заявки. Колбэк получает 'ok' | 'rate' | 'server' | 'network'.
      Страница «спасибо» открывается ТОЛЬКО после ответа сервера «записано»:
      раньше переход шёл при любой ошибке, и человек считал заявку
      отправленной, хотя она пропала. */
  function postLead(payload, done) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 15000) : 0;

    fetch('../api/lead.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 429) return done('rate');
      if (!res.ok) return done('server');
      return res.json().then(function (j) { done(j && j.ok ? 'ok' : 'server'); },
                             function () { done('server'); });
    }, function () { clearTimeout(timer); done('network'); });
  }

  /** Общая обвязка формы: валидация, состояние «отправляем», повтор
      после ошибки с тем же event_id (сервер не создаст дубль).
      f: { form, name, phone, agree, fax, btn, key:'' | 's-', extra(), label() } */
  function wireLeadForm(f) {
    var status = f.form.querySelector('[data-status]');
    var call   = f.form.querySelector('[data-call]');
    var eid = '';
    var busy = false;

    [].forEach.call(f.form.querySelectorAll('.fld__err'), function (b) { b.setAttribute('aria-live', 'polite'); });

    function box(k) { return f.form.querySelector('[data-err="' + f.key + k + '"]'); }
    function setErr(el, k, msg) {
      var b = box(k);
      b.textContent = msg || '';
      b.classList.toggle('is-on', !!msg);
      if (el) { if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    }
    function setStatus(msg, isErr) {
      status.textContent = msg || '';
      status.classList.toggle('is-error', !!isErr);
      if (call) call.hidden = !isErr;
    }

    wirePhone(f.phone, function () { setErr(f.phone, 'phone'); });
    f.name.addEventListener('input', function () { setErr(f.name, 'name'); });
    f.agree.addEventListener('change', function () { setErr(null, 'agree'); });

    f.form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;

      var bad = null;
      if (f.name.value.trim().length < 2) { setErr(f.name, 'name', T('name-required')); bad = bad || f.name; }
      var d = localPart(f.phone.value);
      if (!d)                  { setErr(f.phone, 'phone', T('phone-required')); bad = bad || f.phone; }
      else if (d.length !== 8) { setErr(f.phone, 'phone', T('phone-invalid'));  bad = bad || f.phone; }
      if (!f.agree.checked)    { setErr(null, 'agree', T('consent')); bad = bad || f.agree; }
      if (bad) { bad.focus(); return; }

      busy = true;
      f.btn.disabled = true;
      f.btn.textContent = T('sending');
      setStatus('');
      track('lead_submit_attempt', { form: f.key ? 'short' : 'quiz' });

      /* Один идентификатор на все попытки одной заявки: он же уходит
         в Meta (дедупликация с пикселем) и не даёт серверу записать дубль. */
      eid = eid || 'lead.' + Date.now() + '.' + Math.random().toString(36).slice(2, 10);

      var payload = { lang: document.documentElement.lang, event_id: eid, consent: true,
                      consent_scope: f.key ? 'contact' : 'contact_health',      // квиз: явное согласие на ответы (ст.9)
                      consent_marketing: !!(window.dpConsent && window.dpConsent.marketing) };
      var marks = window.dpMarks || {};
      Object.keys(marks).forEach(function (k) { payload[k] = marks[k]; });
      Object.assign(payload, f.extra(), {
        name: f.name.value.trim(),
        phone: '+373' + d,
        fax: f.fax.value                                   // honeypot
      });

      postLead(payload, function (r) {
        busy = false;
        if (r === 'ok') {
          track('lead_submit_success', { event_id: eid, form: f.key ? 'short' : 'quiz' });
          track('lead', { event_id: eid });
          if (window.fbq) window.fbq('track', 'Lead', {}, { eventID: eid });
          if (f.done) f.done();
          location.href = thanksUrl();
          return;
        }
        track('lead_submit_error', { reason: r });
        f.btn.disabled = false;
        f.btn.textContent = f.label();
        setStatus(T(r === 'rate' ? 'rate' : r === 'network' ? 'network' : 'server'), true);
      });
    });
  }

  /* ==========================================================
     Сборка импланта
     Стадии: 0 исходная ситуация · 1 имплант · 2 абатмент · 3 коронка
     ========================================================== */

  var stage = document.querySelector('.stage__frames');

  if (stage) {
    var steps  = [].slice.call(document.querySelectorAll('.step'));
    var frames = [].slice.call(stage.querySelectorAll('.frame'));
    var sum    = document.getElementById('sum');
    var replay = document.getElementById('replay');

    var timer = null;
    var touched = false;   // пользователь уже трогал шаги — автопоказ не вмешивается

    function render(n) {
      frames.forEach(function (img, i) { img.classList.toggle('is-on', i === n); });
      steps.forEach(function (b, i) {
        b.setAttribute('aria-current', i === n ? 'true' : 'false');
        b.classList.toggle('step--done', i < n);
      });
      sum.classList.toggle('is-on', n >= 3);
    }

    function stop() { clearTimeout(timer); timer = null; }

    function play(from) {
      stop();
      var n = from;
      render(n);
      (function next() {
        if (n >= 3) return;
        timer = setTimeout(function () { render(++n); next(); }, n === 0 ? 1500 : 1250);
      })();
    }

    steps.forEach(function (b, i) {
      b.addEventListener('click', function () { touched = true; stop(); render(i); });
    });

    /* При «уменьшении движения» все этапы понятны и без анимации:
       показываем итог, а кнопка просто возвращает к последнему кадру. */
    replay.addEventListener('click', function () {
      track('build_replay');
      touched = true;
      reduce ? render(3) : play(0);
    });

    render(0);

    if (reduce) {
      render(3);
    } else if ('IntersectionObserver' in window) {
      var stageIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          stageIo.disconnect();
          track('build_view');
          /* Дождаться декодирования кадров, иначе первый переход
             моргнёт пустотой на медленной связи. */
          var ready = frames.map(function (img) {
            img.loading = 'eager';
            return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
          });
          Promise.all(ready).then(function () {
            setTimeout(function () { if (!touched) play(0); }, 250);
          });
        });
      }, { threshold: 0.25 });
      stageIo.observe(stage);
    } else {
      play(0);
    }
  }

  /* ==========================================================
     КВИЗ
     Шаги 0–3 — вопросы, 4 — контакт. Расчёта нет: форма появляется
     сразу после последнего ответа и честно называет себя заявкой.
     Ответы живут в sessionStorage: обновили страницу или ушли читать
     блок цен — вернулись туда же, где остановились.
     ========================================================== */

  var form = document.getElementById('quizForm');
  var QIDS = ['q1', 'q2', 'q3', 'q4'];

  if (form) {
    var qsteps = [].slice.call(form.querySelectorAll('.qstep'));
    var bars   = [].slice.call(form.querySelectorAll('.qbar li'));
    var qBack  = document.getElementById('qBack');
    var qCount = document.getElementById('qCount');
    var qSend  = document.getElementById('qSubmit');
    var CONTACT = 4;
    var step = 0;
    var answers = {};
    var seen = {};      // шаги, для которых событие уже ушло: «Назад» не дублирует

    try { answers = JSON.parse(sessionStorage.getItem('dp_quiz') || '{}') || {}; } catch (e) {}

    function save() { try { sessionStorage.setItem('dp_quiz', JSON.stringify(answers)); } catch (e) {} }

    function optBtn(q, v) { return form.querySelector('.qopt[data-q="' + q + '"][data-v="' + v + '"]'); }

    function mark(btn, on) {
      btn.classList.toggle('is-picked', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    // в хранилище могли остаться значения старой версии квиза — отбрасываем чужие
    QIDS.forEach(function (q) { if (answers[q] && !optBtn(q, answers[q])) delete answers[q]; });
    Object.keys(answers).forEach(function (q) { var b = optBtn(q, answers[q]); if (b) mark(b, true); });

    function isArch() { return answers.q1 === 'full_arch'; }

    function applyVariant() {
      var v = isArch() ? 'full_arch' : 'std';
      [].forEach.call(form.querySelectorAll('[data-variant]'), function (el) {
        el.hidden = el.getAttribute('data-variant') !== v;
      });
      qSend.textContent = qSend.getAttribute(isArch() ? 'data-label-arch' : 'data-label-std');
    }

    function isNear(el) {
      var r = el.getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0;
    }

    function nextOpen() {
      for (var i = 0; i < QIDS.length; i++) if (!answers[QIDS[i]]) return i;
      return -1;
    }

    /* Событие шага уходит один раз: «Назад» и повторный вход его не дублируют */
    function see(n) {
      if (seen[n]) return;
      seen[n] = true;
      track(n < CONTACT ? 'quiz_step_' + (n + 1) : 'quiz_contact_view');
    }

    function go(n, fromUser, silent) {
      step = n;
      qsteps.forEach(function (el) {
        el.classList.toggle('is-on', +el.getAttribute('data-step') === n);
      });

      bars.forEach(function (li, i) { li.classList.toggle('is-done', i <= Math.min(n, 3)); });

      var onQ = n < CONTACT;
      qCount.hidden = !onQ;
      if (onQ) {
        qCount.innerHTML = qCount.getAttribute('data-tpl')
          .replace('{current}', '<b>' + (n + 1) + '</b>').replace('{total}', QIDS.length);
      }
      qBack.hidden = n === 0;

      if (n === CONTACT) applyVariant();

      if (!silent) see(n);

      var cur = qsteps[n];
      if (n === CONTACT && isNear(form)) {
        setTimeout(function () { document.getElementById('qName').focus({ preventScroll: true }); }, 60);
      } else if (fromUser) {
        var lg = cur.querySelector('legend');
        if (lg) { lg.setAttribute('tabindex', '-1'); lg.focus({ preventScroll: true }); }
      }
    }

    /* --- выбор ответа: сразу на следующий шаг, без «Далее» --- */

    form.addEventListener('click', function (e) {
      var opt = e.target.closest('.qopt');
      if (!opt) return;
      var q = opt.getAttribute('data-q');
      var from = +opt.closest('.qstep').getAttribute('data-step');   // шаг самого ответа, а не «текущий»: двойной тап не перескочит
      answers[q] = opt.getAttribute('data-v');
      save();
      [].forEach.call(opt.parentNode.querySelectorAll('.qopt'), function (b) { mark(b, b === opt); });
      startQuiz();
      see(from);
      setTimeout(function () { go(from + 1, true); }, reduce ? 0 : 180);
    });

    qBack.addEventListener('click', function () { go(Math.max(0, step - 1), true); });

    /* --- контакт --- */

    wireLeadForm({
      form: form, key: '',
      name: document.getElementById('qName'),
      phone: document.getElementById('qPhone'),
      agree: document.getElementById('qAgree'),
      fax: document.getElementById('qFax'),
      btn: qSend,
      label: function () { return qSend.getAttribute(isArch() ? 'data-label-arch' : 'data-label-std'); },
      extra: function () {
        return { q1: answers.q1 || '', q2: answers.q2 || '', q3: answers.q3 || '', q4: answers.q4 || '',
                 entry: answers.entry || '', package: answers.package || '' };
      },
      done: function () { try { sessionStorage.removeItem('dp_quiz'); } catch (e) {} }
    });

    var started = false;
    function startQuiz() { if (!started) { started = true; track('quiz_start'); } }

    /* Продолжить с того места, где остановились (ответы уже в хранилище).
       Событий при загрузке нет: шаг «просмотрен», только когда человек дошёл до квиза. */
    go(nextOpen() === -1 ? CONTACT : nextOpen(), false, true);

    /** Вход в квиз с карточек: ситуация (v) и/или пакет уже выбраны.
        Выбор можно изменить — это предзаполнение, а не проверенные данные. */
    window.dpQuizEnter = function (v, entry, pkg) {
      if (entry) answers.entry = entry; else if (!pkg) delete answers.entry;
      if (typeof pkg === 'string') { if (pkg) answers.package = pkg; else delete answers.package; }
      if (v) {
        answers.q1 = v;
        [].forEach.call(form.querySelectorAll('.qopt[data-q="q1"]'), function (b) { mark(b, b.getAttribute('data-v') === v); });
        go(1, false);
      } else {
        go(nextOpen() === -1 ? CONTACT : nextOpen());
      }
      save();
      startQuiz();
    };
  }

  /* Кнопки входа в квиз: ситуация, пакет, главная кнопка, липкая панель */
  document.addEventListener('click', function (e) {
    if (!window.dpQuizEnter) return;
    var seg = e.target.closest('[data-enter]');
    if (seg) {
      window.dpQuizEnter(seg.getAttribute('data-enter'), seg.getAttribute('data-entry') || '', '');
      document.getElementById('quizForm').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    var open = e.target.closest('[data-open-quiz]');
    if (open) window.dpQuizEnter('', '', open.getAttribute('data-package') || '');
  });

  /* ==========================================================
     Короткая форма внизу — для тех, кто не хочет квиз
     ========================================================== */

  var sForm = document.getElementById('shortForm');

  if (sForm) {
    var sBtn = document.getElementById('sSubmit');
    var sLabel = sBtn.textContent;
    wireLeadForm({
      form: sForm, key: 's-',
      name: document.getElementById('sName'),
      phone: document.getElementById('sPhone'),
      agree: document.getElementById('sAgree'),
      fax: document.getElementById('sFax'),
      btn: sBtn,
      label: function () { return sLabel; },
      extra: function () { return { entry: 'short_form' }; }
    });
  }

  /* ==========================================================
     Карта — фасад. Сторонний iframe грузим только по клику:
     на загрузке он стоит секунды LCP и тянет чужие куки.
     ========================================================== */

  var mapBtn = document.getElementById('mapBtn');

  if (mapBtn) {
    mapBtn.addEventListener('click', function () {
      var box = document.getElementById('mapbox');
      var fr = document.createElement('iframe');
      fr.src = mapBtn.getAttribute('data-src');
      fr.loading = 'lazy';
      fr.title = mapBtn.getAttribute('data-title') || 'DentPark';
      fr.referrerPolicy = 'no-referrer-when-downgrade';
      fr.allowFullscreen = true;
      box.appendChild(fr);
      box.classList.add('is-live');
      track('map_open');
    });
  }

  /* ==========================================================
     Появление секций при прокрутке.
     Один момент на смысловой блок, не на каждый элемент.
     Срабатывает один раз и отключается.
     ========================================================== */

  var REVEAL = [
    ['.build__head', '.build__grid'],
    ['.tiers__head', '.tier'],
    ['.pick__head',  '.pick__list'],
    ['.doc__head',   '.doc__grid', '.doc__plan'],
    ['.flow__head',  '.flow__list', '.flow__more'],
    ['.rev__head',   '.rev__item'],
    ['.cases__head', '.case', '.xray'],
    ['.faq__head',   '.qa'],
    ['.quiz__head',  '.quiz__box'],
    ['.fin__form',   '.fin__contacts']
  ];

  if (!reduce && 'IntersectionObserver' in window) {
    var revealIo = new IntersectionObserver(function (rows) {
      rows.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        revealIo.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });

    REVEAL.forEach(function (group) {
      group.forEach(function (sel) {
        [].forEach.call(document.querySelectorAll(sel), function (el, i) {
          el.classList.add('reveal');
          el.style.setProperty('--i', i);   // карточки в ряду выезжают друг за другом
          revealIo.observe(el);
        });
      });
    });
  }

  /* ==========================================================
     Цифры доверия отсчитываются при попадании в кадр
     (только если клиника подтвердила цифры: иначе в плашке слова)
     ========================================================== */

  var nums = [].slice.call(document.querySelectorAll('.trust b.num'));

  /* Цель запоминаем СРАЗУ, до любой анимации. Иначе повторный вызов
     прочитает уже обнулённый текст, получит 0 и оставит цифру нулём. */
  nums.forEach(function (el) { el.setAttribute('data-to', el.textContent.replace(/\D/g, '')); });

  if (nums.length && !reduce && 'IntersectionObserver' in window) {
    var nio = new IntersectionObserver(function (rows) {
      rows.forEach(function (en) {
        if (!en.isIntersecting) return;
        nio.unobserve(en.target);
        count(en.target);
      });
    }, { threshold: 0.6 });
    nums.forEach(function (el) { nio.observe(el); });
  }

  function count(el) {
    if (el.dataset.counting) return;
    var target = parseInt(el.getAttribute('data-to'), 10);
    if (!target) return;
    el.dataset.counting = '1';

    var dur = 1100, t0 = 0;
    var fmt = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };

    function tick(now) {
      if (!t0) t0 = now;
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    }
    el.textContent = '0';
    requestAnimationFrame(tick);
  }

  /* ==========================================================
     Сравнение снимков «до / после» (появляется вместе с секцией случаев)
     Ползунком служит невидимый input[type=range]: бесплатно
     получаем клавиатуру, тач и правильную семантику.
     ========================================================== */

  [].forEach.call(document.querySelectorAll('.cmp'), function (box) {
    var input = box.querySelector('.cmp__in');
    if (!input) return;

    function apply() { box.style.setProperty('--pos', input.value + '%'); }
    input.addEventListener('input', apply);
    apply();

    function moveTo(clientX) {
      var r = box.getBoundingClientRect();
      input.value = String(Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100))));
      apply();
    }

    var dragging = false;
    box.addEventListener('pointerdown', function (e) { dragging = true; box.setPointerCapture(e.pointerId); moveTo(e.clientX); });
    box.addEventListener('pointermove', function (e) { if (dragging) moveTo(e.clientX); });
    box.addEventListener('pointerup', function () { dragging = false; });
    box.addEventListener('pointercancel', function () { dragging = false; });
  });

  /* ==========================================================
     Липкая панель — появляется, когда первый экран уехал
     ========================================================== */

  var dock = document.getElementById('dock');
  var hero = document.querySelector('.hero');

  if (dock && hero) {
    /* Порог считаем напрямую, а не через IntersectionObserver с
       отрицательным rootMargin: тот давал запаздывающие срабатывания. */
    var showAt = 0;

    function paintDock() { dock.classList.toggle('is-on', window.scrollY > showAt); }

    function measure() {
      showAt = window.scrollY + hero.getBoundingClientRect().bottom - innerHeight * 0.35;
      paintDock();
    }

    addEventListener('scroll', paintDock, { passive: true });
    addEventListener('resize', measure, { passive: true });
    addEventListener('load', measure);
    measure();

    /* Пока на экране квиз или контакты, панель убираем: форма уже перед
       глазами, а панель закрывала бы нижние поля и чекбокс.
       Узкая полоса в середине экрана, чтобы край секции не дёргал панель. */
    if ('IntersectionObserver' in window) {
      var inView = {};
      var dockIo = new IntersectionObserver(function (rows) {
        rows.forEach(function (en) { inView[en.target.id] = en.isIntersecting; });
        dock.classList.toggle('is-away', !!(inView.quiz || inView.contacts));
      }, { rootMargin: '-25% 0px -25% 0px' });
      ['quiz', 'contacts'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) dockIo.observe(el);
      });
    }
  }

  /* ==========================================================
     Страница «спасибо»: когда перезвоним.
     Обещать «15 минут» в субботу вечером нельзя — клиника
     закрыта Сб–Вс. Время берём кишинёвское, а не с устройства:
     человек может быть за границей. Тексты на обоих языках
     лежат в data-* у #tyWhen, здесь выбирается только ключ.
     ========================================================== */

  var tyWhen = document.getElementById('tyWhen');

  if (tyWhen) {
    (function () {
      var t;
      try {
        // en-GB только для разбора: дни Mon…Sun, часы 00–23 на любом языке страницы
        var parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Chisinau', weekday: 'short',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(new Date());
        var g = {};
        parts.forEach(function (p) { g[p.type] = p.value; });
        var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g.weekday);
        if (day < 0) throw new Error('weekday');
        t = { day: day, h: (+g.hour) % 24, m: +g.minute };
      } catch (e) {
        var d = new Date();
        t = { day: d.getDay(), h: d.getHours(), m: d.getMinutes() };
      }

      var mins    = t.h * 60 + t.m;
      var open    = 8 * 60 + 30, close = 18 * 60;
      var workday = t.day >= 1 && t.day <= 5;

      var key;
      if (workday && mins >= open && mins < close - 20) key = 'soon';
      else if (workday && mins < open)                  key = 'morning';
      else if (workday && t.day !== 5)                  key = 'tomorrow';
      else                                              key = 'monday';  // пятница после закрытия и выходные

      var text = tyWhen.getAttribute('data-' + key);
      if (text) tyWhen.textContent = text;
    })();
  }

  /* ==========================================================
     СОГЛАСИЕ НА COOKIE (Закон 241/2007 ст.72 ч.5–6; Закон 195/2024 ст.7)

     Без согласия в браузере хранится только строго необходимое:
     выбор по cookie (dp_consent) и прогресс квиза (dp_quiz) — это
     то, что человек сам запросил. Метки кампании без согласия живут
     только в памяти страницы и уходят вместе с заявкой; _fbp/_fbc не
     читаются, пиксель не грузится, сервер не шлёт событие в Meta.

     Баннер есть только если в разметке задан data-pixel (ID пикселя
     в настройках сайта): без маркетинговых инструментов соглашаться
     не на что. Отказ и согласие — одного веса; отозвать можно в
     подвале («Настройки cookie») так же просто, как дать.
     Каждый выбор фиксируется на сервере (api/consent.php) без IP:
     случайный id, время, версия текста, выбор.
     ========================================================== */

  var PIXEL = document.body.getAttribute('data-pixel') || '';
  var CK = 'dp_consent', CV = 1, CMAX = 180 * 864e5;      // 6 месяцев, потом спросим снова

  var consent = (function () {
    try {
      var c = JSON.parse(localStorage.getItem(CK) || 'null');
      if (c && c.v === CV && Date.now() - c.t < CMAX) return c;
    } catch (e) {}
    return null;
  })();
  window.dpConsent = consent || { marketing: false };

  function hasMarketing() { return !!(consent && consent.marketing); }

  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

  function cookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : '';
  }

  /* Метки кампании. С согласием — переживают переход между страницами
     (sessionStorage) и дополняются идентификаторами Meta; без него —
     только из адреса текущей страницы. */
  function collectMarks() {
    var q = new URLSearchParams(location.search);
    var saved = {};
    if (hasMarketing()) {
      try { saved = JSON.parse(sessionStorage.getItem('dp_marks') || '{}'); } catch (e) {}
    }
    KEYS.forEach(function (k) { if (q.get(k)) saved[k] = q.get(k); });
    saved.page_url = location.origin + location.pathname;   // без строки запроса: метки уже лежат в полях выше
    if (hasMarketing()) {
      saved.fbp = cookie('_fbp');
      saved.fbc = cookie('_fbc') || (saved.fbclid ? 'fb.1.' + Date.now() + '.' + saved.fbclid : '');
      try { sessionStorage.setItem('dp_marks', JSON.stringify(saved)); } catch (e) {}
    } else {
      try { sessionStorage.removeItem('dp_marks'); } catch (e) {}
    }
    window.dpMarks = saved;
  }

  var pixelLoaded = false;
  function loadPixel() {
    if (!PIXEL || pixelLoaded || !hasMarketing()) return;
    pixelLoaded = true;
    /* стандартный загрузчик Meta, без расширенного сопоставления (имя и телефон не передаются) */
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', PIXEL);
    window.fbq('track', 'PageView');
  }

  function dropMetaCookies() {
    ['_fbp', '_fbc'].forEach(function (n) {
      var host = location.hostname, parts = host.split('.');
      var domains = ['', host];
      for (var i = 1; i < parts.length - 1; i++) domains.push('.' + parts.slice(i).join('.'));
      domains.forEach(function (d) {
        document.cookie = n + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  function saveConsent(marketing, source) {
    var was = hasMarketing();
    consent = { v: CV, t: Date.now(), marketing: !!marketing,
                id: (consent && consent.id) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)) };
    window.dpConsent = consent;
    try { localStorage.setItem(CK, JSON.stringify(consent)); } catch (e) {}
    try {
      var body = JSON.stringify({ id: consent.id, v: CV, marketing: consent.marketing, source: source, lang: document.documentElement.lang });
      if (navigator.sendBeacon) navigator.sendBeacon('../api/consent.php', body);
      else fetch('../api/consent.php', { method: 'POST', body: body, keepalive: true });
    } catch (e) {}
    collectMarks();
    if (consent.marketing) loadPixel();
    else if (was) {                       // отзыв: стереть следы и выгрузить уже загруженный пиксель
      dropMetaCookies();
      if (pixelLoaded) location.reload();
    }
  }

  collectMarks();
  loadPixel();

  var cc = document.getElementById('cc');
  if (cc && PIXEL) {
    var ccOpts = document.getElementById('ccOpts');
    var ccMkt = document.getElementById('ccMkt');
    var ccSave = cc.querySelector('[data-cc="save"]');
    var ccSet = cc.querySelector('[data-cc="settings"]');

    var openCc = function (withSettings, focus) {
      cc.hidden = false;
      ccMkt.checked = hasMarketing();
      ccOpts.hidden = !withSettings;
      ccSave.hidden = !withSettings;
      ccSet.hidden = !!withSettings;
      // при первом показе фокус не трогаем: подсвеченная рамкой кнопка читалась бы как подсказка
      if (focus) (withSettings ? ccMkt : cc.querySelector('[data-cc="reject"]')).focus({ preventScroll: true });
    };
    var closeCc = function () { cc.hidden = true; };

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cc]');
      if (!b) return;
      var a = b.getAttribute('data-cc');
      if (a === 'open' || a === 'settings') { openCc(true, true); return; }
      if (a === 'accept') saveConsent(true, ccOpts.hidden ? 'banner' : 'settings');
      if (a === 'reject') saveConsent(false, ccOpts.hidden ? 'banner' : 'settings');
      if (a === 'save') saveConsent(ccMkt.checked, 'settings');
      track('consent_' + (hasMarketing() ? 'granted' : 'denied'));
      closeCc();
    });

    if (!consent) openCc(false);
  }

})();
