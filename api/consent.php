<?php
/**
 * DentPark — журнал выбора по cookie.
 *
 * Оператор должен уметь показать, что согласие было дано (Закон 195/2024,
 * ст. 7 ч. 1), а CNPDCP рекомендует хранить доказательства согласия.
 * Пишем только то, что для этого нужно: случайный id из браузера, время,
 * версию текста баннера, выбор и откуда он сделан. IP и User-Agent НЕ пишем.
 *
 * PHP 7.0+, как и lead.php.
 */

declare(strict_types=1);
date_default_timezone_set('Europe/Chisinau');
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    exit('{"ok":false}');
}

$raw = (string)file_get_contents('php://input');
if (strlen($raw) > 1000) { http_response_code(413); exit('{"ok":false}'); }

$in = json_decode($raw, true);
if (!is_array($in)) { http_response_code(400); exit('{"ok":false}'); }

$cfgPath = __DIR__ . '/../config.php';
$CFG = is_readable($cfgPath) ? require $cfgPath : [];
if (!is_array($CFG)) { $CFG = []; }

$dir = $CFG['log_dir'] ?? (__DIR__ . '/../_data');
if (!is_dir($dir)) { @mkdir($dir, 0750, true); }

$id = substr((string)preg_replace('/[^a-z0-9]/', '', strtolower(is_scalar($in['id'] ?? null) ? (string)$in['id'] : '')), 0, 32);
if ($id === '') { http_response_code(422); exit('{"ok":false}'); }

$source = is_scalar($in['source'] ?? null) ? (string)$in['source'] : '';
$row = [
    'ts'        => date('c'),
    'id'        => $id,
    'v'         => is_numeric($in['v'] ?? null) ? (int)$in['v'] : 0,
    'marketing' => ($in['marketing'] ?? false) === true,
    'source'    => in_array($source, ['banner', 'settings'], true) ? $source : '',
    'lang'      => ($in['lang'] ?? '') === 'ru' ? 'ru' : 'ro',
];

@file_put_contents($dir . '/consent.jsonl', json_encode($row) . "\n", FILE_APPEND | LOCK_EX);
echo '{"ok":true}';
