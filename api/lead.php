<?php
/**
 * DentPark — приём заявки с лендинга и квиза.
 *
 * Порядок важен: сначала фиксируем лид, потом уведомляем.
 * Упавший Telegram или Meta не должен приводить к потере заявки.
 *
 *   1. локальный журнал (всегда, даже если всё остальное отвалилось)
 *      → ответ браузеру: страница «спасибо» не ждёт чужие API
 *   2. Google Sheets — таблица обзвона
 *   3. Telegram — мгновенный алерт в чат клиники
 *   4. Meta CAPI — событие Lead с дедупликацией по event_id
 *
 * Хостинг: Fozzy, cPanel + LiteSpeed. Никаких composer-зависимостей.
 *
 * ⚠️ PHP 7.0+, и это не случайность: версия PHP в cPanel выбирается
 *    на весь аккаунт, а на нём же живёт MODX основного сайта. Поднять
 *    версию ради лендинга можно не всегда. Поэтому здесь нет стрелочных
 *    функций (7.4), str_starts_with (8.0) и деструктуризации [$a, $b] (7.1).
 *    Упавший lead.php теряет заявку молча: страница «спасибо» всё равно
 *    откроется, человек решит, что всё отправлено.
 */

declare(strict_types=1);

/* Время заявки — кишинёвское, а не сервера: хостинг может стоять в
   другом поясе, а по этой колонке колл-центр видит, сколько человек
   ждёт звонка. */
date_default_timezone_set('Europe/Chisinau');

/* mbstring в селекторе PHP бывает выключен. Без него mb_substr —
   фатальная ошибка, то есть та самая молчаливая потеря заявки. */
if (!function_exists('mb_substr')) {
    function mb_substr($s, $start, $len = null) {
        preg_match_all('/./us', (string)$s, $m);
        return implode('', array_slice($m[0], (int)$start, $len === null ? null : (int)$len));
    }
}
if (!function_exists('mb_strtolower')) {
    function mb_strtolower($s) { return strtolower((string)$s); }
}

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    exit(json_encode(['ok' => false]));
}

$cfgPath = __DIR__ . '/../config.php';
$CFG = is_readable($cfgPath) ? require $cfgPath : [];
if (!is_array($CFG)) { $CFG = []; }

$LOG_DIR = $CFG['log_dir'] ?? (__DIR__ . '/../_data');
if (!is_dir($LOG_DIR)) { @mkdir($LOG_DIR, 0750, true); }

/* ─────────────────────────── вход ─────────────────────────── */

$raw = (string)file_get_contents('php://input');
if (strlen($raw) > 8000) { http_response_code(413); exit(json_encode(['ok' => false])); }

$in = json_decode($raw, true);
if (!is_array($in)) { http_response_code(400); exit(json_encode(['ok' => false])); }

/** Приманка для ботов. Живой человек это поле не видит.
 *  Отвечаем 200, чтобы бот считал отправку успешной и не подбирал обход. */
if (trim((string)($in['fax'] ?? '')) !== '') {
    exit(json_encode(['ok' => true]));
}

/* ───────────── согласие и повтор одной и той же заявки ─────────────
   Форма лендинга присылает consent:true. Явное «нет» не принимаем;
   старые формы, которые поле не шлют, не ломаем. */

if (array_key_exists('consent', $in) && $in['consent'] !== true && $in['consent'] !== 'true' && $in['consent'] !== 1) {
    http_response_code(422);
    exit(json_encode(['ok' => false, 'error' => 'consent']));
}

/* event_id создаёт браузер один раз на заявку и повторяет при ретрае.
   Если такая заявка уже записана (человек нажал «Отправить» ещё раз после
   обрыва связи), второй строки не будет: отвечаем «записано». Проверка до
   лимита частоты, иначе честный повтор упёрся бы в 429. */
$eventId = substr((string)preg_replace('/[^A-Za-z0-9._-]/', '', is_scalar($in['event_id'] ?? null) ? (string)$in['event_id'] : ''), 0, 80);
$logFile = $LOG_DIR . '/leads.jsonl';

if ($eventId !== '' && is_readable($logFile) && ($lf0 = @fopen($logFile, 'rb'))) {
    if ((int)@filesize($logFile) > 262144) {
        fseek($lf0, -262144, SEEK_END);
        fgets($lf0);                                 // первая строка обрезана посередине
    }
    $dup = false;
    $needle = '"event_id":' . json_encode($eventId);
    while (($line0 = fgets($lf0)) !== false) {
        if (strpos($line0, $needle) !== false) { $dup = true; break; }
    }
    fclose($lf0);
    if ($dup) { exit(json_encode(['ok' => true, 'dup' => true])); }
}

/* ───────────────────── ограничение частоты ──────────────────
   Redis на shared-хостинге нет, поэтому файловый счётчик по IP. */

$ip =$_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '0';
$ip = trim(explode(',', (string)$ip)[0]);

$rlFile = $LOG_DIR . '/rl_' . sha1($ip) . '.txt';
$window = 600;   // 10 минут
$limit  = 5;

$hits = [];
if (is_readable($rlFile)) {
    $hits = array_filter(
        array_map('intval', explode("\n", (string)file_get_contents($rlFile))),
        static function (int $t) use ($window): bool { return $t > time() - $window; }
    );
}
if (count($hits) >= $limit) {
    http_response_code(429);
    exit(json_encode(['ok' => false, 'error' => 'too_many']));
}
$hits[] = time();
@file_put_contents($rlFile, implode("\n", $hits), LOCK_EX);

/* ──────────────────────── нормализация ────────────────────── */

$clean = static function ($v, int $max = 200): string {
    $v = is_scalar($v) ? (string)$v : '';
    $v = strip_tags($v);
    $v = preg_replace('/[\x00-\x1F\x7F]/u', '', $v) ?? '';
    return mb_substr(trim($v), 0, $max);
};

$name = $clean($in['name'] ?? '', 60);

// телефон -> E.164 без плюса: 373XXXXXXXX
// Та же нормализация, что в браузере (localPart в app.js и quiz.js):
// «+373 069…» — это 69…, а не 06…, код страны мог быть набран дважды.
// strpos, а не str_starts_with: тот появился только в PHP 8.0
$digits = preg_replace('/\D/', '', (string)($in['phone'] ?? '')) ?? '';
if (strpos($digits, '00') === 0)         { $digits = (string)substr($digits, 2); }
while (strpos($digits, '373') === 0)     { $digits = (string)substr($digits, 3); }
if (strpos($digits, '0') === 0)          { $digits = (string)substr($digits, 1); }
$local = (string)substr($digits, 0, 8);

if ($name === '' || strlen($local) !== 8) {
    http_response_code(422);
    exit(json_encode(['ok' => false, 'error' => 'bad_input']));
}
$phoneE164 = '373' . $local;
$pretty    = '+373 ' . substr($local, 0, 2) . ' ' . substr($local, 2, 3) . ' ' . substr($local, 5, 3);

/* На каком языке была страница — на том и звонить. */
$lang = $clean($in['lang'] ?? '', 5) === 'ru' ? 'ru' : 'ro';

/* Откуда заявка. Лендинг и квиз спрашивают разное, поэтому и шкала
   скоринга, и подписи у них свои. На лендинге два входа: расчёт цены
   и короткая форма «перезвоните мне» без вопросов. */
$type  = ($in['quiz_type'] ?? '') === 'allon' ? 'allon' : 'land';
$entry = $clean($in['entry'] ?? '', 40);
$src   = $type === 'allon' ? 'allon' : ($entry === 'short_form' ? 'short' : 'calc');

/* ─────────────── подписи: язык, на котором клиника ─────────────
   читает заявки. Настройка leads_lang в config.php, 'ro' или 'ru'.
   Ключи ответов — из разметки (data-v), они одни на оба языка. */

$DICT = [
    'ro' => [
        'answers' => [
            'land' => [
                'q1' => ['one' => 'un dinte', 'few' => 'câțiva dinți', 'many' => 'mai mulți dinți pe aceeași arcadă',
                         'full_arch' => 'o arcadă întreagă', 'unknown' => 'nu este sigur(ă)'],
                'q2' => ['lt1y' => 'sub un an', 'gte1y' => 'un an sau mai mult', 'extraction' => 'urmează o extracție',
                         'unknown' => 'nu știe / diferă'],
                'q3' => ['yes' => 'are', 'no' => 'nu are', 'unknown' => 'nu știe ce are'],
                'q4' => ['soon' => 'cât mai curând', 'weeks' => 'în următoarele săptămâni', 'later' => 'mai târziu',
                         'researching' => 'deocamdată doar se informează'],
            ],
            'allon' => [
                'q1' => [
                    'few'   => 'lipsesc câțiva dinți la rând',
                    'most'  => 'lipsesc aproape toți pe o arcadă',
                    'none'  => 'nu mai are dinți',
                    'loose' => 'dinții se mișcă, i s-a propus extracția',
                ],
                'q2' => ['up' => 'superioară', 'low' => 'inferioară', 'both' => 'ambele'],
                'q3' => ['bad' => 'poartă, incomodă', 'ok' => 'poartă, s-a obișnuit', 'offer' => 'nu, dar i s-a propus', 'no' => 'nu'],
                'q4' => [
                    'bone'   => 'da — os insuficient',
                    'health' => 'da — vârsta sau sănătatea',
                    'no'     => 'nu',
                    'long'   => 'n-a mai fost demult la stomatolog',
                ],
                'q5' => ['hold' => 'să țină mult timp', 'pain' => 'să nu doară', 'fast' => 'să fie rapid', 'money' => 'claritate la bani'],
                'q6' => ['now' => 'în curând', 'month' => 'în 1–2 luni', 'info' => 'deocamdată se informează'],
            ],
        ],
        'titles' => [
            'land'  => ['q1' => 'Lipsesc', 'q2' => 'De când', 'q3' => 'Radiografie', 'q4' => 'Vrea să înceapă'],
            'allon' => [
                'q1' => 'Situația', 'q2' => 'Arcada', 'q3' => 'Proteză mobilă',
                'q4' => 'Refuz anterior', 'q5' => 'Important', 'q6' => 'Vrea să înceapă',
            ],
        ],
        'source' => [
            'calc'  => 'Landing · calculul prețului',
            'short' => 'Landing · formular scurt',
            'allon' => 'Quiz All-on-4/6',
        ],
        'prio' => [
            'hot'  => 'prioritate înaltă',
            'mid'  => 'prioritate medie',
            'low'  => 'prioritate scăzută',
            'none' => 'așteaptă apelul',
        ],
        'new'        => 'Cerere nouă',
        'score'      => 'scor %d din %d',
        'speak'      => ['ro' => 'Vorbiți în <b>română</b>', 'ru' => 'Vorbiți în <b>rusă</b>'],
        'no_answers' => 'Nu a răspuns la întrebări — situația o aflați la telefon.',
        'repeat'     => '↩ Același număr a mai lăsat o cerere%s: %s',
        'entry'      => [
            'no_bone' => 'A intrat prin „Mi s-a spus că nu am suficient os”.',
            'ad'      => 'Primul răspuns a fost ales deja în anunț.',
        ],
        'package'    => 'Pachet ales pe pagină',
        'packages'   => ['basic' => 'Varianta de bază', 'zirconia' => 'Cu coroană din zirconiu', 'premium' => 'Sisteme premium'],
        'ad'         => 'Reclamă',
        'meta'       => 'Meta, fără UTM',
        'wa_button'  => 'Scrieți pe WhatsApp',
    ],
    'ru' => [
        'answers' => [
            'land' => [
                'q1' => ['one' => 'один зуб', 'few' => 'несколько зубов', 'many' => 'много зубов в одном ряду',
                         'full_arch' => 'весь зубной ряд', 'unknown' => 'пока не знает'],
                'q2' => ['lt1y' => 'меньше года', 'gte1y' => 'год или больше', 'extraction' => 'удаление ещё предстоит',
                         'unknown' => 'не знает / по-разному'],
                'q3' => ['yes' => 'есть', 'no' => 'нет', 'unknown' => 'не знает, какой снимок'],
                'q4' => ['soon' => 'в ближайшее время', 'weeks' => 'в течение нескольких недель', 'later' => 'позже',
                         'researching' => 'пока только узнаёт'],
            ],
            'allon' => [
                'q1' => [
                    'few'   => 'нет нескольких зубов подряд',
                    'most'  => 'нет почти всех на одной челюсти',
                    'none'  => 'нет зубов совсем',
                    'loose' => 'зубы шатаются, предлагают удалить',
                ],
                'q2' => ['up' => 'верхняя', 'low' => 'нижняя', 'both' => 'обе'],
                'q3' => ['bad' => 'носит, неудобно', 'ok' => 'носит, привык', 'offer' => 'нет, но предлагали', 'no' => 'нет'],
                'q4' => [
                    'bone'   => 'да — мало кости',
                    'health' => 'да — возраст или здоровье',
                    'no'     => 'нет',
                    'long'   => 'давно не был у стоматолога',
                ],
                'q5' => ['hold' => 'чтобы держалось долго', 'pain' => 'чтобы не было больно', 'fast' => 'чтобы быстро', 'money' => 'ясность по деньгам'],
                'q6' => ['now' => 'в ближайшее время', 'month' => 'в течение 1–2 месяцев', 'info' => 'пока узнаёт'],
            ],
        ],
        'titles' => [
            'land'  => ['q1' => 'Не хватает', 'q2' => 'Давность', 'q3' => 'Снимок', 'q4' => 'Начать'],
            'allon' => [
                'q1' => 'Ситуация', 'q2' => 'Челюсть', 'q3' => 'Съёмный протез',
                'q4' => 'Отказ раньше', 'q5' => 'Важно', 'q6' => 'Начать',
            ],
        ],
        'source' => [
            'calc'  => 'Лендинг · расчёт цены',
            'short' => 'Лендинг · короткая форма',
            'allon' => 'Квиз All-on-4/6',
        ],
        'prio' => [
            'hot'  => 'высокий приоритет',
            'mid'  => 'средний приоритет',
            'low'  => 'низкий приоритет',
            'none' => 'ждёт звонка',
        ],
        'new'        => 'Новая заявка',
        'score'      => 'балл %d из %d',
        'speak'      => ['ro' => 'Говорить <b>по-румынски</b>', 'ru' => 'Говорить <b>по-русски</b>'],
        'no_answers' => 'На вопросы не отвечал — ситуацию узнать по телефону.',
        'repeat'     => '↩ Этот номер уже оставлял заявку%s: %s',
        'entry'      => [
            'no_bone' => 'Вошёл через «Мне сказали, что не хватает кости».',
            'ad'      => 'Первый ответ выбран заранее, в объявлении.',
        ],
        'package'    => 'Выбранный пакет на странице',
        'packages'   => ['basic' => 'Базовый вариант', 'zirconia' => 'С циркониевой коронкой', 'premium' => 'Премиальные системы'],
        'ad'         => 'Реклама',
        'meta'       => 'Meta, без UTM',
        'wa_button'  => 'Написать в WhatsApp',
    ],
];

$LL = ($CFG['leads_lang'] ?? 'ro') === 'ru' ? 'ru' : 'ro';
$T  = $DICT[$LL];

/* Ответы — не свободный текст, а ключи из разметки (data-v). Их не
   чистим strip_tags, а сверяем со словарём: strip_tags принимал
   «<1» («меньше года») за начало тега и съедал целиком — ответ
   терялся в каждой такой заявке. Ключа нет в словаре — не ответ. */
$q = [];
foreach (['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as $k) {
    $v = is_scalar($in[$k] ?? null) ? mb_substr(trim((string)$in[$k]), 0, 20) : '';
    $q[$k] = isset($T['answers'][$type][$k][$v]) ? $v : '';
}
$answered = count(array_filter($q, static function (string $v): bool { return $v !== ''; }));

/* ──────────────────────── лид-скоринг ─────────────────────── */

/* Балл — это приоритет обзвона, а не «качество» человека.
   Считается здесь, а не в браузере: иначе его можно подделать. */

$SCORE = [
    'land' => [
        'q1' => ['many' => 2, 'full_arch' => 2],
        'q3' => ['yes' => 2],
        'q4' => ['soon' => 3, 'weeks' => 2],
    ],
    'allon' => [
        'q1' => ['none' => 3, 'most' => 3, 'loose' => 3, 'few' => 1],
        'q2' => ['both' => 2, 'up' => 1, 'low' => 1],
        'q3' => ['bad' => 2, 'ok' => 1, 'offer' => 1],
        'q4' => ['bone' => 2, 'health' => 1, 'long' => 1],
        'q6' => ['now' => 3, 'month' => 2],
    ],
];

$score = 0;
foreach ($SCORE[$type] as $k => $map) {
    $score += $map[$q[$k]] ?? 0;
}

$scoreMax = $type === 'allon' ? 12 : 7;
$hotFrom  = $type === 'allon' ? 9 : 5;

/* Короткая форма — это «перезвоните мне», а не холодный лид с нулём
   баллов: вопросов человеку не задавали, звать его «прогревом» нелогично. */
if (!$answered)                 { $prio = 'none'; }
elseif ($score >= $hotFrom)     { $prio = 'hot'; }
elseif ($score >= $hotFrom - 4) { $prio = 'mid'; }
else                            { $prio = 'low'; }

/* ───────────────────────── номер заявки ─────────────────────
   Сквозной номер: «перезвонил #57» в чате, та же строка в таблице
   и в журнале. Счётчик под файловой блокировкой — две заявки в одну
   секунду не получат один номер. */

$leadId = 0;
$fh = @fopen($LOG_DIR . '/seq.txt', 'c+');
if ($fh) {
    if (flock($fh, LOCK_EX)) {
        $leadId = (int)stream_get_contents($fh) + 1;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, (string)$leadId);
        fflush($fh);
        flock($fh, LOCK_UN);
    }
    fclose($fh);
}

/* ───────────────────── этот номер уже был? ──────────────────
   Человек мог пройти квиз, а потом ещё и короткую форму. Звонить
   дважды незачем, а знать об этом менеджеру полезно. Смотрим хвост
   журнала за 30 дней, а не весь файл: он растёт. */

$prev = null;
$logFile = $LOG_DIR . '/leads.jsonl';
if (is_readable($logFile) && ($lf = @fopen($logFile, 'rb'))) {
    if ((int)@filesize($logFile) > 262144) {
        fseek($lf, -262144, SEEK_END);
        fgets($lf);                              // первая строка обрезана посередине
    }
    $since = date('Y-m-d H:i:s', time() - 30 * 86400);
    while (($line = fgets($lf)) !== false) {
        $r = json_decode($line, true);
        if (is_array($r) && ($r['phone'] ?? '') === '+' . $phoneE164 && (string)($r['timestamp'] ?? '') >= $since) {
            $prev = $r;                          // последняя по времени — последняя в файле
        }
    }
    fclose($lf);
}

/* ─────────────────────── строка заявки ────────────────────── */

$notes = [];                                     // пометки для менеджера: вход, пакет, повтор
if ($entry === 'no_bone' || $entry === 'bone')     { $notes[] = $T['entry']['no_bone']; }
elseif (strpos($entry, 'ad_') === 0)               { $notes[] = $T['entry']['ad']; }
elseif ($entry !== '' && $entry !== 'short_form')  { $notes[] = $entry; }   // ?entry= из ссылки креатива

/* Пакет, на карточке которого человек нажал: контекст для звонка, а не
   диагноз. Принимаем только известные ключи. */
$package = $clean($in['package'] ?? '', 20);
if (!isset($T['packages'][$package])) { $package = ''; }
if ($package !== '') { $notes[] = $T['package'] . ': ' . $T['packages'][$package] . '.'; }

$repeat = '';
if ($prev) {
    $ts = strtotime((string)($prev['timestamp'] ?? ''));
    $repeat = sprintf(
        $T['repeat'],
        !empty($prev['lead_id']) ? ' #' . (int)$prev['lead_id'] : '',
        $ts ? date('d.m H:i', $ts) : ''
    );
}

// ячейка таблицы: «Вопрос: ответ» — колонки q1…q6 общие у лендинга и квиза
$cell = static function (string $k) use ($T, $type, $q): string {
    if ($q[$k] === '' || !isset($T['titles'][$type][$k])) { return ''; }
    return $T['titles'][$type][$k] . ': ' . $T['answers'][$type][$k][$q[$k]];
};

$row = [
    'lead_id'      => $leadId ?: '',
    'timestamp'    => date('Y-m-d H:i:s'),
    'name'         => $name,
    'phone'        => '+' . $phoneE164,
    'lang'         => $lang,
    'source'       => $T['source'][$src],
    'q1'           => $cell('q1'),
    'q2'           => $cell('q2'),
    'q3'           => $cell('q3'),
    'q4'           => $cell('q4'),
    'q5'           => $cell('q5'),
    'q6'           => $cell('q6'),
    'lead_score'   => $answered ? $score : '',   // пусто = вопросов не было, а не «ноль баллов»
    'status'       => '',                        // для колл-центра
    'comment'      => implode(' ', array_merge($notes, $repeat !== '' ? [$repeat] : [])),
    'utm_source'   => $clean($in['utm_source']   ?? ''),
    'utm_medium'   => $clean($in['utm_medium']   ?? ''),
    'utm_campaign' => $clean($in['utm_campaign'] ?? ''),
    'utm_content'  => $clean($in['utm_content']  ?? ''),
    'utm_term'     => $clean($in['utm_term']     ?? ''),
    'fbclid'       => $clean($in['fbclid'] ?? ''),
    'fbp'          => $clean($in['fbp']    ?? ''),
    'fbc'          => $clean($in['fbc']    ?? ''),
    'page_url'     => $clean($in['page_url'] ?? '', 500),
];

/* ─── 1. локальный журнал: пишется всегда, страховка от потери ───
   В журнал дополнительно идут event_id (защита от дубля при повторе),
   запись о согласии и пакет. В таблицу они не уходят. */

$logRow = $row + [
    'event_id'   => $eventId,
    'consent'    => array_key_exists('consent', $in) ? 'yes' : 'legacy',
    // contact_health — квиз: явное согласие на ответы как на данные о здоровье (ст. 9 Закона 195/2024)
    'consent_scope'     => in_array($in['consent_scope'] ?? '', ['contact', 'contact_health'], true) ? $in['consent_scope'] : '',
    'consent_marketing' => ($in['consent_marketing'] ?? false) === true,
    'package'    => $package,
];

$written = @file_put_contents(
    $logFile,
    json_encode($logRow, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n",
    FILE_APPEND | LOCK_EX
);

/* Не удалось записать — отвечаем ошибкой, а не «ок»: браузер покажет
   человеку, что заявка не принята, и предложит позвонить. Раньше «ок»
   уходил в любом случае, и заявка могла пропасть молча. */
if ($written === false) {
    // запасная копия — во временную папку системы, не в webroot: там лежат персональные данные
    @file_put_contents(sys_get_temp_dir() . '/dentpark-leads-fallback.log', json_encode($logRow, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
    http_response_code(500);
    exit(json_encode(['ok' => false, 'error' => 'storage']));
}

/* ─── ответ человеку — сразу ───
   Заявка уже записана. Дальше только уведомления, и ждать их браузеру
   незачем: три сервиса по 6 секунд таймаута — это до 18 секунд перед
   страницей «спасибо». На LiteSpeed (Fozzy) и PHP-FPM соединение
   закрывается здесь, скрипт дорабатывает в фоне. Где этих функций
   нет, всё работает как раньше, просто ответ уходит в конце. */

// function_exists, а не @: в PHP 8 вызов функции, выключенной
// хостингом в disable_functions, — фатальная ошибка, @ её не глушит
if (function_exists('ignore_user_abort')) { ignore_user_abort(true); }
if (function_exists('set_time_limit'))    { set_time_limit(60); }
echo json_encode(['ok' => true]);
if (function_exists('litespeed_finish_request'))  { litespeed_finish_request(); }
elseif (function_exists('fastcgi_finish_request')) { fastcgi_finish_request(); }

/* ───────────────────────── транспорт ──────────────────────── */

$errors = [];

/**
 * POST с коротким таймаутом: ни один чужой API не должен висеть долго.
 */
$post = static function (string $url, string $body, array $headers, int $timeout = 6): array {
    if (!function_exists('curl_init')) {
        return [0, 'curl_disabled'];
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_FOLLOWLOCATION => true,
    ]);
    $resp = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    if (PHP_VERSION_ID < 80000) { curl_close($ch); }   // с 8.0 ничего не делает, с 8.5 устарела
    return [$code, $err !== '' ? $err : (string)$resp];
};

/* ─── 2. Google Sheets ─── */

if (!empty($CFG['sheets_webhook'])) {
    try {
        list($code, $resp) = $post(
            $CFG['sheets_webhook'],
            json_encode(['secret' => $CFG['sheets_secret'] ?? '', 'row' => $row], JSON_UNESCAPED_UNICODE),
            ['Content-Type: application/json']
        );
        if ($code < 200 || $code >= 300) { $errors[] = "sheets:$code:$resp"; }
    } catch (Throwable $e) { $errors[] = 'sheets:' . $e->getMessage(); }
} else {
    $errors[] = 'sheets:not_configured';
}

/* ─── 3. Telegram: цель — звонок в первые 5 минут ───
   Заявку читают с телефона, в списке чатов видна только первая
   строка — поэтому в ней метка приоритета, номер и что человек ждёт. */

$tgChats = $CFG['tg_chat'] ?? '';
$tgChats = array_values(array_filter(array_map('trim',
    is_array($tgChats) ? array_map('strval', $tgChats) : explode(',', (string)$tgChats)
)));   // можно несколько: личный чат владельца и группа колл-центра

if (!empty($CFG['tg_token']) && $tgChats) {
    try {
        $esc = static function (string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); };

        $mark = ['hot' => "\xF0\x9F\x94\xA5", 'mid' => "\xE2\x97\x8F", 'low' => "\xE2\x9D\x84", 'none' => "\xE2\x97\x8F"][$prio];  // 🔥 ● ❄ ●

        $lines = [
            $mark . ' <b>' . $esc($T['new'] . ($leadId ? ' #' . $leadId : '')) . '</b> — ' . $esc($T['prio'][$prio]),
            $esc($T['source'][$src]) . ($answered ? ' · ' . $esc(sprintf($T['score'], $score, $scoreMax)) : ''),
            '',
            '<b>' . $esc($name) . '</b>',
            /* Телефон обычным текстом, БЕЗ <a href="tel:">: Telegram пропускает
               только http/https/tg:// — ссылка на tel: роняет весь запрос в 400,
               и уведомление не приходит вовсе. Номер клиенты делают нажимаемым сами. */
            $pretty,
            $T['speak'][$lang],
            '',
        ];

        if ($answered) {
            foreach ($T['titles'][$type] as $k => $title) {
                if ($q[$k] !== '') {
                    $lines[] = $esc($title) . ': <b>' . $esc($T['answers'][$type][$k][$q[$k]]) . '</b>';
                }
            }
        } else {
            $lines[] = $esc($T['no_answers']);
        }

        $tail = [];
        if ($repeat !== '') { $tail[] = '<b>' . $esc($repeat) . '</b>'; }
        foreach ($notes as $n) { $tail[] = $esc($n); }
        $ad = array_values(array_filter([$row['utm_source'], $row['utm_campaign'], $row['utm_content']],
                                        static function (string $s): bool { return $s !== ''; }));
        if ($ad)                     { $tail[] = $esc($T['ad'] . ': ' . implode(' · ', $ad)); }
        elseif ($row['fbclid'] !== '') { $tail[] = $esc($T['ad'] . ': ' . $T['meta']); }
        if ($tail) { $lines[] = ''; $lines = array_merge($lines, $tail); }

        /* Кнопка WhatsApp с готовым приветствием на языке пациента:
           менеджер не переписывает номер и не набирает текст руками. */
        $hello = $lang === 'ru'
            ? 'Здравствуйте, ' . $name . '! Пишем из клиники DentPark по вашей заявке на имплантацию.'
            : 'Bună ziua, ' . $name . '! Vă scriem de la clinica DentPark în legătură cu cererea dumneavoastră despre implanturi.';

        $msg = [
            'text'                 => implode("\n", $lines),
            'parse_mode'           => 'HTML',
            'link_preview_options' => ['is_disabled' => true],
            'reply_markup'         => ['inline_keyboard' => [[
                ['text' => $T['wa_button'], 'url' => 'https://wa.me/' . $phoneE164 . '?text=' . rawurlencode($hello)],
            ]]],
        ];
        $tgUrl = 'https://api.telegram.org/bot' . $CFG['tg_token'] . '/sendMessage';

        foreach ($tgChats as $chat) {
            $msg['chat_id'] = $chat;
            list($code, $resp) = $post($tgUrl, json_encode($msg, JSON_UNESCAPED_UNICODE), ['Content-Type: application/json']);

            /* Группу превратили в супергруппу — у неё новый id, старый
               отвечает 400 с подсказкой. Шлём по новому и просим обновить
               config.php, иначе уведомления тихо перестали бы приходить. */
            $j = json_decode((string)$resp, true);
            $moved = $j['parameters']['migrate_to_chat_id'] ?? null;
            if ($code === 400 && $moved) {
                $msg['chat_id'] = $moved;
                list($code, $resp) = $post($tgUrl, json_encode($msg, JSON_UNESCAPED_UNICODE), ['Content-Type: application/json']);
                $errors[] = "tg:chat $chat стал $moved — обновить tg_chat в config.php";
            }
            if ($code < 200 || $code >= 300) { $errors[] = "tg:$chat:$code:$resp"; }
        }
    } catch (Throwable $e) { $errors[] = 'tg:' . $e->getMessage(); }
} else {
    $errors[] = 'tg:not_configured';
}

/* ─── 4. Meta CAPI: event_id общий с браузерным пикселем ─── */

/* Событие в Meta — только если человек принял маркетинговые cookie. Без согласия
   передавать Meta IP, User-Agent и идентификаторы браузера нельзя (Закон 241/2007
   ст. 72 ч. 5, Закон 195/2024 ст. 6). Квиз-сайт /quiz/ баннера пока не имеет —
   оттуда событие не уходит вовсе. */
if (!empty($CFG['fb_pixel_id']) && !empty($CFG['fb_token']) && ($in['consent_marketing'] ?? false) === true) {
    try {
        /* Сайт клиники — медицинский: в Meta уходит только факт события
           «Lead» с техническими идентификаторами браузера. Ни ответов
           квиза, ни балла, ни выбранного пакета, ни сегмента в
           custom_data нет.

           Совпадение по хешу телефона и имени (Advanced Matching) выключено,
           пока юрист не подтвердит его для сайта клиники: включается
           'capi_match' => true в config.php. Нормализация тогда такая:
           trim + нижний регистр, телефон в E.164 без плюса — иначе хеши
           не сойдутся с браузерными. */
        $user = [];

        if (!empty($CFG['capi_match'])) {
            $user['ph']      = [hash('sha256', $phoneE164)];
            $user['fn']      = [hash('sha256', mb_strtolower($name, 'UTF-8'))];
            $user['country'] = [hash('sha256', 'md')];
            $xid = $clean($in['external_id'] ?? '', 64);
            if ($xid !== '') { $user['external_id'] = [hash('sha256', $xid)]; }
        }

        if ($row['fbp'] !== '') { $user['fbp'] = $row['fbp']; }
        if ($row['fbc'] !== '') { $user['fbc'] = $row['fbc']; }
        if ($ip !== '')                          { $user['client_ip_address']  = $ip; }
        if (!empty($_SERVER['HTTP_USER_AGENT'])) { $user['client_user_agent'] = $_SERVER['HTTP_USER_AGENT']; }

        $payload = ['data' => [[
            'event_name'       => 'Lead',
            'event_time'       => time(),
            'event_id'         => $eventId,
            'action_source'    => 'website',
            'event_source_url' => $row['page_url'],
            'user_data'        => $user,
        ]]];
        if (!empty($CFG['fb_test_code'])) { $payload['test_event_code'] = $CFG['fb_test_code']; }

        list($code, $resp) = $post(
            'https://graph.facebook.com/v21.0/' . $CFG['fb_pixel_id'] . '/events?access_token=' . urlencode($CFG['fb_token']),
            json_encode($payload, JSON_UNESCAPED_UNICODE),
            ['Content-Type: application/json']
        );
        if ($code < 200 || $code >= 300) { $errors[] = "capi:$code:$resp"; }
    } catch (Throwable $e) { $errors[] = 'capi:' . $e->getMessage(); }
}

/* ─────────────────── ошибки — в журнал ошибок ─────────────── */

if ($errors) {
    @file_put_contents(
        $LOG_DIR . '/errors.log',
        date('c') . ' #' . $leadId . ' ' . implode(' | ', $errors) . "\n",
        FILE_APPEND | LOCK_EX
    );
}
