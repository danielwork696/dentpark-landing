<?php
/**
 * Выбор языка. Сами страницы живут на разных URL — так требует ТЗ,
 * RO и RU это два разных рекламных сегмента:
 *
 *   implant.dentpark.md/ro/        implant.dentpark.md/quiz/ro/
 *   implant.dentpark.md/ru/        implant.dentpark.md/quiz/ru/
 *
 * Этот файл нужен только затем, чтобы человек, открывший адрес без
 * языка, не упирался в 403. Он же обслуживает /quiz/ — там лежит
 * однострочный quiz/index.php, который подключает этот.
 *
 * ⚠️ Метки кампании пробрасываем дальше. Без этого весь трафик, пришедший
 *    на адрес без языка, потеряет utm и fbclid — и заявки станут «ниоткуда».
 *
 * PHP 7.4+: без str_starts_with и прочего из восьмёрки — на части
 * молдавских хостингов по умолчанию всё ещё 7.4.
 */

declare(strict_types=1);

/* Папка, в которой лежат ro/ и ru/. quiz/index.php подставляет свою. */
$langRoot = isset($LANG_ROOT) ? (string)$LANG_ROOT : __DIR__;

/* Румынский по умолчанию — как и на dentpark.md: там RO без префикса,
   RU под /ru/. Русский — только если браузер просит его раньше румынского. */
$lang = 'ro';
$accept = strtolower((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
foreach (explode(',', $accept) as $part) {
    $code = trim(explode(';', $part)[0]);
    if ($code === 'ro' || strpos($code, 'ro-') === 0) { $lang = 'ro'; break; }
    if ($code === 'ru' || strpos($code, 'ru-') === 0) { $lang = 'ru'; break; }
}

// версию ещё не выложили — ведём на ту, что есть
if (!is_dir($langRoot . '/' . $lang)) {
    $lang = $lang === 'ro' ? 'ru' : 'ro';
}

/* Адрес строим от расположения скрипта, а не относительным путём:
   на запрос «/quiz» без слеша относительное «ro/» увело бы на /ro/,
   то есть на лендинг вместо квиза. */
$base = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/'))), '/') . '/';
$qs   = (string)($_SERVER['QUERY_STRING'] ?? '');

header('Location: ' . $base . $lang . '/' . ($qs !== '' ? '?' . $qs : ''), true, 302);
header('Cache-Control: no-store');       // язык может смениться, кешировать редирект нельзя
header('Vary: Accept-Language');
exit;
