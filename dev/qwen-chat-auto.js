#!/usr/bin/env node
'use strict';

/*
 * qwen-chat-auto.js
 * ------------------------------------------------------------------
 * Автоматизация https://chat.qwen.ai через Puppeteer 23.0.0.
 *
 * Что делает:
 *   1. стартует Chrome на профиле --user-data-dir;
 *   2. проверяет логин: если /settings/general НЕ редиректит на "/" - залогинены;
 *   3. если не залогинены - логинится по --login/--password (email + SHA-256 пароль,
 *      двухшаговая форма: "Log in with a password" -> email/password -> Log in);
 *      если учетка не зарегистрирована/нет флагов - ругается и выходит;
 *   4. при --agent включает Agent Mode; если он недоступен - ругается и выходит;
 *   5. вводит --text или содержимое --text-file в поле чата;
 *   6. отправляет сообщение и ждет --post-wait (по умолчанию 30) секунд.
 *
 * Селекторы проверены на реальном DOM qwen-chat-fe 0.3.20.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { parseArgs } = require('util');

const puppeteer = require('puppeteer');

const SITE = 'https://chat.qwen.ai';
const APP_VERSION_HINT = 'qwen-chat-fe 0.3.20';

/* ============================ exit codes ============================ */
const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  NOT_LOGGED_IN: 3,
  LOGIN_FAILED: 4,
  CAPTCHA_BLOCKED: 7,
  AGENT_UNAVAILABLE: 5,
  INPUT_NOT_FOUND: 6,
  SEND_FAILED: 8,
  LAUNCH_FAILED: 9,
  INTERNAL: 1,
};

/* ============================ logging ============================ */
const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

let LOG_LEVEL = 'info';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_FILE = { fd: null };

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level, msg, extra) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const tag = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR', ok: 'OK   ' }[level] || level;
  const color = { debug: C.dim, info: C.cyan, warn: C.yellow, error: C.red, ok: C.green }[level] || '';
  const line = `[${ts()}] [${tag}] ${msg}`;
  const styled = COLOR ? `${color}${line}${C.reset}` : line;
  process.stderr.write(styled + '\n');
  if (extra !== undefined) {
    const dump = typeof extra === 'string' ? extra : JSON.stringify(extra);
    for (const l of dump.split('\n')) process.stderr.write((COLOR ? C.dim : '') + '        ' + l + C.reset + '\n');
  }
  if (LOG_FILE.fd) {
    try {
      fs.writeSync(LOG_FILE.fd, stripAnsi(line) + (extra !== undefined ? '\n        ' + stripAnsi(typeof extra === 'string' ? extra : JSON.stringify(extra)) : '') + '\n');
    } catch (_) {}
  }
}
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

const log = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  ok: (m, e) => emit('ok', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
};

/* ============================ helpers ============================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rnd(a, b + 1));

class StepError extends Error {
  constructor(message, exitCode, details) {
    super(message);
    this.exitCode = exitCode || EXIT.INTERNAL;
    this.details = details;
  }
}

function maskSecret(s) {
  if (!s) return '(empty)';
  if (s.length <= 4) return '*'.repeat(s.length);
  return s[0] + '*'.repeat(Math.max(3, s.length - 2)) + s[s.length - 1] + ` (len=${s.length})`;
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function humanize(s, max = 90) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '...' : one;
}

/* ============================ CLI ============================ */
const OPTIONS_SPEC = {
  'user-data-dir': { type: 'string' },
  login: { type: 'string' },
  password: { type: 'string' },
  'password-stdin': { type: 'boolean', default: false },
  text: { type: 'string' },
  'text-file': { type: 'string' },
  agent: { type: 'boolean', default: false },
  headless: { type: 'boolean', default: false },
  lang: { type: 'string' },
  'no-force-lang': { type: 'boolean', default: false },
  'executable-path': { type: 'string' },
  channel: { type: 'string' },
  'window-size': { type: 'string', default: '1440,900' },
  'nav-timeout': { type: 'string', default: '60000' },
  'login-timeout': { type: 'string', default: '180000' },
  'element-timeout': { type: 'string', default: '15000' },
  'settle-delay': { type: 'string', default: '1200' },
  'type-delay': { type: 'string', default: '18' },
  'step-delay': { type: 'string', default: '400' },
  'post-wait': { type: 'string', default: '30' },
  'capture-timeout': { type: 'string', default: '45000' },
  'screenshots-dir': { type: 'string' },
  'no-screenshots': { type: 'boolean', default: false },
  'on-error-dump': { type: 'boolean', default: true },
  'no-on-error-dump': { type: 'boolean', default: false },
  'capture-response': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'new-chat': { type: 'boolean', default: false },
  'keep-open': { type: 'boolean', default: false },
  'block-ads': { type: 'boolean', default: false },
  'profile-copy': { type: 'boolean', default: false },
  'log-level': { type: 'string', default: 'info' },
  'log-file': { type: 'string' },
  'verbose-logs': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

function usage() {
  return `qwen-chat-auto - автоматизация chat.qwen.ai (puppeteer 23.0.0)

ИСПОЛЬЗОВАНИЕ
  node qwen-chat-auto.js --user-data-dir <dir> (--text <s> | --text-file <f>) [опции]

ОБЯЗАТЕЛЬНО
  --user-data-dir <dir>      профиль Chrome (persistent context)
  --text <строка>            текст сообщения
  --text-file <путь>         текст сообщения из файла (нельзя вместе с --text)

АВТОРИЗАЦИЯ (нужна только если профиль не залогинен)
  --login <email>            либо $QWEN_LOGIN
  --password <secret>        либо $QWEN_PASSWORD (светится в истории shell!)
  --password-stdin           прочитать пароль из stdin (самый безопасный вариант)

РЕЖИМЫ / ПОВЕДЕНИЕ
  --agent                    переключиться в Agent Mode (ошибка, если недоступен)
  --new-chat                 начать новый чат перед вводом текста
  --dry-run                  ввести текст, но НЕ отправлять
  --capture-response         после отправки вытащить текст ответа в лог
  --keep-open                не закрывать браузер после завершения
  --headless                 без окна (по умолчанию - с окном: капчу Baxia/Aliyun
                             руками решать проще; в headless капча = выход с кодом 7)
  --lang <en-US|ru-RU|...>   форсировать язык интерфейса (default: en-US,
                             англ. UI делает матчинг по тексту надежнее)
  --no-force-lang            не трогать locale сайта
  --block-ads                резать аналитику/трекеры (alicdn aes, adjust, firebase...)
  --profile-copy             работать на временной копии профиля (оригинал не трогается)

БРАУЗЕР
  --executable-path <path>   явный путь к Chrome/Chromium
  --channel <chrome|...>     канал puppeteer
  --window-size <W,H>        default 1440,900

ТАЙМИНГИ
  --nav-timeout <ms>         default 60000
  --login-timeout <ms>        default 180000  (включая ручное решение капчи)
  --element-timeout <ms>     default 15000
  --settle-delay <ms>        пауза "на успокоение" SPA, default 1200
  --type-delay <ms>          средняя задержка между символами, default 18
  --step-delay <ms>          пауза между шагами, default 400
  --post-wait <sec>          сколько ждать после отправки, default 30
  --capture-timeout <ms>     default 45000

ДИАГНОСТИКА
  --screenshots-dir <dir>    default ./screenshots
  --no-screenshots           не делать скриншоты этапов
  --no-on-error-dump         не делать дамп (png+html) при ошибке
  --log-level <debug|info|warn|error>
  --log-file <path>          дублировать лог в файл
  --verbose-logs             писать console-сообщения страницы в лог

КОДЫ ВЫХОДА
  0 успех | 2 аргументы | 3 не залогинен и нет кредов | 4 логин не удался
  5 Agent Mode недоступен | 6 не найдено поле ввода | 7 капча (нет окна)
  8 не удалось отправить | 9 не запустился браузер | 1 прочее

ПРИМЕРЫ
  node qwen-chat-auto.js --user-data-dir ./profile-a --agent \\
      --text "Проверка связи! Представься и расскажи о себе парой предложений."

  QWEN_PASSWORD='...' node qwen-chat-auto.js --user-data-dir ./profile-a \\
      --login 04hwxsfx@tempmailpro.io --password-stdin --text-file msg.txt < pw.txt

  node qwen-chat-auto.js --user-data-dir ./profile-b --text-file msg.txt --headless
`;
}

function num(v, name, fallback) {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new StepError(`Некорректное числовое значение для --${name}: ${JSON.stringify(v)}`, EXIT.BAD_ARGS);
  return n;
}

function readPasswordStdin() {
  return new Promise((resolve, reject) => {
    try {
      if (process.stdin.isTTY) {
        // интерактивно: выключаем эхо
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
        process.stderr.write('Пароль (ввод скрыт): ');
        rl._writeToOutput = function () {};
        rl.question('', (ans) => {
          rl.close();
          process.stderr.write('\n');
          resolve(ans);
        });
      } else {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (data += d));
        process.stdin.on('end', () => resolve(data.replace(/[\r\n]+$/, '')));
        process.stdin.on('error', reject);
        process.stdin.resume();
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS_SPEC, allowPositionals: false, strict: true });
  } catch (e) {
    throw new StepError(`Ошибка разбора аргументов: ${e.message}\n\n${usage()}`, EXIT.BAD_ARGS);
  }
  const f = parsed.values;

  if (f.help) {
    process.stdout.write(usage());
    process.exit(EXIT.OK);
  }
  if (f.version) {
    process.stdout.write(`qwen-chat-auto 1.0.0 (puppeteer ${require('puppeteer/package.json').version}, target ${APP_VERSION_HINT})\n`);
    process.exit(EXIT.OK);
  }

  LOG_LEVEL = (f['log-level'] || 'info').toLowerCase();
  if (!(LOG_LEVEL in LEVELS)) throw new StepError(`--log-level должен быть одним из: ${Object.keys(LEVELS).join(', ')}`, EXIT.BAD_ARGS);
  if (f['verbose-logs'] && LOG_LEVEL === 'info') LOG_LEVEL = 'debug';

  const cfg = {
    userDataDir: f['user-data-dir'],
    login: f.login || process.env.QWEN_LOGIN || '',
    password: f.password || process.env.QWEN_PASSWORD || '',
    passwordStdin: !!f['password-stdin'],
    text: f.text,
    textFile: f['text-file'],
    agent: !!f.agent,
    headless: !!f.headless,
    lang: f['no-force-lang'] ? null : f.lang || 'en-US',
    executablePath: f['executable-path'] || process.env.PUPPETEER_EXECUTABLE_PATH || '',
    channel: f.channel || '',
    windowSize: f['window-size'],
    navTimeout: num(f['nav-timeout'], 'nav-timeout', 60000),
    loginTimeout: num(f['login-timeout'], 'login-timeout', 180000),
    elementTimeout: num(f['element-timeout'], 'element-timeout', 15000),
    settleDelay: num(f['settle-delay'], 'settle-delay', 1200),
    typeDelay: num(f['type-delay'], 'type-delay', 18),
    stepDelay: num(f['step-delay'], 'step-delay', 400),
    postWaitSec: num(f['post-wait'], 'post-wait', 30),
    captureTimeout: num(f['capture-timeout'], 'capture-timeout', 45000),
    screenshotsDir: f['screenshots-dir'] || path.resolve('screenshots'),
    screenshots: !f['no-screenshots'],
    onErrorDump: !(f['no-on-error-dump'] || f['on-error-dump'] === false),
    captureResponse: !!f['capture-response'],
    dryRun: !!f['dry-run'],
    newChat: !!f['new-chat'],
    keepOpen: !!f['keep-open'],
    blockAds: !!f['block-ads'],
    profileCopy: !!f['profile-copy'],
    logFile: f['log-file'] || '',
    verboseLogs: !!f['verbose-logs'],
  };

  if (cfg.logFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(cfg.logFile)), { recursive: true });
      LOG_FILE.fd = fs.openSync(path.resolve(cfg.logFile), 'a');
    } catch (e) {
      throw new StepError(`Не удалось открыть --log-file: ${e.message}`, EXIT.BAD_ARGS);
    }
  }

  /* ---- валидация ---- */
  if (!cfg.userDataDir) throw new StepError('Не указан --user-data-dir (обязательный флаг).\n\n' + usage(), EXIT.BAD_ARGS);

  if ((cfg.text !== undefined) && (cfg.textFile !== undefined)) {
    throw new StepError('Флаги --text и --text-file несовместимы: укажите что-то одно.', EXIT.BAD_ARGS);
  }
  if (cfg.text === undefined && cfg.textFile === undefined) {
    throw new StepError('Не задан текст сообщения: нужен --text или --text-file.\n\n' + usage(), EXIT.BAD_ARGS);
  }
  if (cfg.textFile !== undefined) {
    const p = path.resolve(cfg.textFile);
    if (!fs.existsSync(p)) throw new StepError(`--text-file: файл не найден: ${p}`, EXIT.BAD_ARGS);
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      throw new StepError(`--text-file: ${e.message}`, EXIT.BAD_ARGS);
    }
    if (!stat.isFile()) throw new StepError(`--text-file: это не обычный файл: ${p}`, EXIT.BAD_ARGS);
    cfg.messageText = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    cfg.messageSource = `файл ${p} (${stat.size} байт)`;
  } else {
    cfg.messageText = String(cfg.text);
    cfg.messageSource = 'флаг --text';
  }
  if (!cfg.messageText || !cfg.messageText.trim()) {
    throw new StepError('Текст сообщения пуст после чтения источника - нечего отправлять.', EXIT.BAD_ARGS);
  }

  const [w, h] = String(cfg.windowSize).split(',').map((x) => parseInt(x, 10));
  if (!w || !h) throw new StepError(`--window-size должен быть в формате W,H (получено: ${cfg.windowSize})`, EXIT.BAD_ARGS);
  cfg.winW = w;
  cfg.winH = h;

  if (cfg.passwordStdin) {
    cfg.password = await readPasswordStdin();
  }
  cfg.hasCreds = Boolean(cfg.login && cfg.password);
  if (cfg.login && !cfg.password) {
    log.warn('Указан --login, но пароль не передан. Логин через UI будет невозможен.');
  }

  return cfg;
}

/* ============================ browser discovery ============================ */
function resolveExecutablePath(cfg) {
  const tried = [];
  if (cfg.executablePath) {
    tried.push(`flag:${cfg.executablePath}`);
    if (fs.existsSync(cfg.executablePath)) return cfg.executablePath;
    throw new StepError(`--executable-path не найден: ${cfg.executablePath}`, EXIT.LAUNCH_FAILED);
  }
  if (cfg.channel) return null; // puppeteer сам найдет по каналу
  try {
    const p = puppeteer.executablePath();
    tried.push(`puppeteer-cache:${p}`);
    if (p && fs.existsSync(p)) return p;
  } catch (e) {
    tried.push('puppeteer-cache: unavailable (' + e.message + ')');
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    tried.push(`system:${c}`);
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  throw new StepError(
    'Не найден исполняемый файл Chrome/Chromium.\n' +
      'Установите браузер для puppeteer:  npx puppeteer browsers install chrome\n' +
      'или укажите путь явно:             --executable-path /path/to/chrome\n' +
      'Пробовали:\n  ' + tried.join('\n  '),
    EXIT.LAUNCH_FAILED
  );
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'SingletonLock' || entry.name === 'SingletonCookie' || entry.name === 'SingletonSocket') continue;
    if (entry.name === 'Cache' || entry.name === 'Code Cache' || entry.name === 'GPUCache' || entry.name === 'Crashpad') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) {
      try {
        fs.copyFileSync(s, d);
      } catch (_) {}
    }
  }
}

/* ============================ page helpers ============================ */
class Ctx {
  constructor(cfg, browser, page) {
    this.cfg = cfg;
    this.browser = browser;
    this.page = page;
    this.stepNo = 0;
  }
  get t() {
    return this.cfg;
  }
}

async function shot(ctx, name, fullPage = false) {
  if (!ctx.cfg.screenshots) return null;
  try {
    fs.mkdirSync(ctx.cfg.screenshotsDir, { recursive: true });
    const p = path.join(ctx.cfg.screenshotsDir, `${String(++ctx.stepNo).padStart(2, '0')}-${name}.png`);
    await ctx.page.screenshot({ path: p, fullPage });
    log.debug(`скриншот: ${p}`);
    return p;
  } catch (e) {
    log.warn(`не удалось сделать скриншот "${name}": ${e.message}`);
    return null;
  }
}

async function dumpDiagnostics(ctx, name) {
  const dir = ctx.cfg.screenshotsDir;
  const out = { name, at: new Date().toISOString() };
  try {
    fs.mkdirSync(dir, { recursive: true });
    out.url = ctx.page.url();
    out.title = await ctx.page.title().catch(() => '');
    const png = path.join(dir, `FAIL-${name}.png`);
    await ctx.page.screenshot({ path: png, fullPage: false }).catch(() => {});
    const html = path.join(dir, `FAIL-${name}.html`);
    fs.writeFileSync(html, await ctx.page.content());
    out.screenshot = png;
    out.html = html;
    out.visibleText = await ctx.page
      .evaluate(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 2000) : ''))
      .catch(() => '');
    out.captcha = await detectCaptcha(ctx.page);
  } catch (e) {
    out.dumpError = e.message;
  }
  log.error(`диагностический дамп "${name}"`, out);
  return out;
}

async function settle(ctx, mult = 1) {
  await sleep(Math.round(ctx.cfg.settleDelay * mult));
}

async function waitForFunctionSafe(page, fn, opts, ...args) {
  return page.waitForFunction(fn, { timeout: opts.timeout, polling: opts.polling || 250 }, ...args);
}

/** Прозрачная проверка "видимости" элемента по CSS-селектору. */
async function findVisible(page, selectors, timeout = 0) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const sel of list) {
      const handle = await page.evaluateHandle((s) => {
        const isVisible = (el) => {
          if (!el) return false;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          if (el.closest('[aria-hidden="true"]')) return false;
          return true;
        };
        for (const el of Array.from(document.querySelectorAll(s))) {
          if (isVisible(el)) return el;
        }
        return null;
      }, sel);
      const el = handle.asElement();
      if (el) return { handle: el, selector: sel };
    }
    if (Date.now() >= deadline) return null;
    await sleep(200);
  }
}

/** Клик "по-человечески": скролл в область, движение мыши, пауза, клик по центру. */
async function humanClick(page, handleOrSel, label = '') {
  let handle = handleOrSel;
  if (typeof handleOrSel === 'string') {
    const found = await findVisible(page, [handleOrSel], 0);
    if (!found) throw new StepError(`Не найден видимый элемент для клика: ${handleOrSel} (${label})`, EXIT.INPUT_NOT_FOUND);
    handle = found.handle;
  }
  try {
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  } catch (_) {}
  await sleep(randInt(60, 180));
  let box = await handle.boundingBox();
  if (!box) {
    await sleep(200);
    box = await handle.boundingBox();
  }
  if (box && box.width > 0 && box.height > 0) {
    const x = box.x + box.width / 2 + rnd(-Math.min(4, box.width / 6), Math.min(4, box.width / 6));
    const y = box.y + box.height / 2 + rnd(-Math.min(3, box.height / 6), Math.min(3, box.height / 6));
    await page.mouse.move(x - rnd(30, 90), y - rnd(20, 60));
    await sleep(randInt(40, 120));
    await page.mouse.move(x, y, { steps: randInt(4, 12) });
    await sleep(randInt(50, 160));
    await page.mouse.down();
    await sleep(randInt(35, 95));
    await page.mouse.up();
  } else {
    await handle.evaluate((el) => el.click());
  }
  if (label) log.debug(`клик: ${label}`);
  await sleep(randInt(80, 200));
}

/** Набор текста с рваным ритмом (antidetect: ровный интервал - явный признак бота). */
async function humanType(page, handle, text, baseDelay) {
  await handle.click({ clickCount: 1 });
  await sleep(randInt(60, 160));
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // page.type корректно обрабатывает и "\n", и эмодзи из строки
    await page.keyboard.type(ch, { delay: 0 });
    let d = rnd(baseDelay * 0.45, baseDelay * 1.9);
    if (i % randInt(18, 40) === 0) d += rnd(120, 420); // микропауза "на обдумывание"
    if (/[.,!?;:\n]/.test(ch)) d += rnd(60, 220);
    await sleep(d);
  }
}

/**
 * Заполнение React-контролируемого инпута: native setter + полный набор событий.
 * Надёжнее, чем type() для ant-design форм, и не зависит от фокуса.
 */
async function setInputValue(page, handle, value, label = '') {
  const ok = await handle.evaluate((el, val) => {
    try {
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      return el.value === val;
    } catch (e) {
      return false;
    }
  }, value);
  if (!ok) log.warn(`React-инпут "${label}" заполнен, но значение не сошлось - проверю ещё раз`);
  return ok;
}

async function detectCaptcha(page) {
  try {
    return await page.evaluate(() => {
      const q = (s) => !!document.querySelector(s);
      const hasBaxia = typeof window.__baxia__ !== 'undefined' || typeof window.baxiaCommon !== 'undefined';
      const slider = q('#aliyunCaptcha-sliding-slider') || q('.aliyun-captcha') || q('.nc-container') || q('#capture-container');
      // baxia-попап обычно вставляется в <header> или в конец body
      const iframe = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || f.id || f.className).filter(Boolean);
      return {
        slider,
        hasBaxia,
        wafMeta: q('meta[name="aliyun_waf_aa"]'),
        suspiciousIframes: iframe.filter((s) => /captcha|baxia|punish|nocaptcha|aliyun/i.test(s)),
        bodyText: (document.body && document.body.innerText ? document.body.innerText.slice(0, 400) : ''),
      };
    });
  } catch (_) {
    return { slider: false, hasBaxia: false, wafMeta: false, suspiciousIframes: [], bodyText: '' };
  }
}

/* ============================ selectors (проверены на 0.3.20) ============================ */
const SEL = {
  // --- форма авторизации ---
  authRoot: '.qwenchat-page-auth',
  otpPanel: '.qwenchat-email-otp-panel',
  otpPanelButton: '.qwenchat-email-otp-panel-button',
  otpEmailInput: '.qwenchat-email-otp-panel-email-input input[name="email"]',
  otpReturnButton: '.qwenchat-email-otp-panel-return button',
  authInputs: '.qwenchat-auth-pc-input-items',
  emailInput: '.qwenchat-auth-pc-input-items input[name="email"]',
  passwordInput: '.qwenchat-auth-pc-input-items input[name="password"]',
  submitButton: '.qwenchat-auth-pc-submit-button',
  forgetRow: '.qwenchat-auth-pc-forget',
  otpCodeCells: '.qwenchat-verification-code-input-cell',
  mobileEmailInput: '.qwenchat-auth-mobile-input-items input[name="email"]',
  mobilePasswordInput: '.qwenchat-auth-mobile-input-items input[name="password"]',

  // --- чат ---
  textarea: 'textarea.message-input-textarea',
  inputContainer: '.message-input-container',
  sendWrap: '.message-input-right-button-send',
  newChatButton: '[data-testid="sidebar-new-chat-button"]',
  messageContainer: '.chat-message-container',

  // --- переключатель режимов ---
  modeSelect: '.mode-select',
  modeCurrent: '.mode-select-current-mode',
  modeDropdownMenu: '.mode-select-dropdown-menu',
  modeItem: '.mode-select-dropdown-item',
  modeItemName: '.mode-select-dropdown-item-name',
  modeSubPopover: '.mode-select-sub-popover-container',

  // --- капча ---
  captcha: ['#aliyunCaptcha-sliding-slider', '.aliyun-captcha', '.nc-container', '#capture-container'],
};

/** Текст кнопок/пунктов меню: en + ru (сайт локализуется, а matching по тексту хрупкий). */
const TXT = {
  loginWithPassword: ['Log in with a password', 'Войти с паролем', 'Вход с паролем'],
  loginSubmit: ['Log in', 'Войти'],
  signInSubmit: ['Sign in', 'Войти'],
  continue: ['Continue', 'Продолжить'],
  agentMode: ['Agent Mode', 'Режим агента', 'Агент'],
  more: ['More', 'Ещё', 'Еще'],
};

/* ============================ launch ============================ */
async function launchBrowser(cfg) {
  const executablePath = resolveExecutablePath(cfg);

  let userDataDir = path.resolve(cfg.userDataDir);
  let tempCopy = null;
  if (cfg.profileCopy) {
    if (!fs.existsSync(userDataDir)) {
      log.warn(`--profile-copy: исходный профиль ${userDataDir} не существует - создаю пустой`);
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    tempCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-profile-'));
    log.info(`копирую профиль в ${tempCopy} (кэши браузера пропускаю)`);
    copyDirSync(userDataDir, tempCopy);
    userDataDir = tempCopy;
  } else {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--window-size=${cfg.winW},${cfg.winH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControllerForContentScripts',
    '--disable-dev-shm-usage',
    '--start-maximized',
    '--lang=' + (cfg.lang || 'en-US').split('-')[0],
  ];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox', '--disable-setuid-sandbox');

  const launchOpts = {
    headless: cfg.headless ? true : false,
    args,
    defaultViewport: null,
    protocolTimeout: Math.max(cfg.navTimeout, 120000),
    ignoreDefaultArgs: ['--enable-automation', '--disable-popup-blocking'],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  if (cfg.channel) launchOpts.channel = cfg.channel;

  log.info(`запускаю браузер: ${cfg.headless ? 'headless' : 'headed'}`);
  log.debug('executablePath: ' + (executablePath || '(channel ' + cfg.channel + ')'));
  log.debug('userDataDir: ' + userDataDir);
  log.debug('args: ' + args.join(' '));

  let browser;
  try {
    browser = await puppeteer.launch(launchOpts);
  } catch (e) {
    throw new StepError(
      `Не удалось запустить браузер: ${e.message}\n` +
        'Проверьте, что Chrome/Chromium установлен (npx puppeteer browsers install chrome), ' +
        'и что этот профиль сейчас не открыт другим окном Chrome.',
      EXIT.LAUNCH_FAILED
    );
  }

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  await page.setViewport({ width: cfg.winW, height: cfg.winH }).catch(() => {});

  /* --- антидетект: убираем webdriver и чиним плагины/языки --- */
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
      window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false } };
      const q = window.navigator.permissions && window.navigator.permissions.query;
      if (q) {
        window.navigator.permissions.query = (p) =>
          p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q(p);
      }
    } catch (_) {}
  });

  /* --- форсируем язык UI (для надежного матчинга по тексту) --- */
  if (cfg.lang) {
    await page
      .evaluateOnNewDocument((lang) => {
        try {
          if (location.hostname.endsWith('qwen.ai') || location.hostname.endsWith('qwen.com')) {
            localStorage.setItem('locale', lang);
          }
        } catch (_) {}
      }, cfg.lang)
      .catch(() => {});
    log.info(`форсирую язык интерфейса: ${cfg.lang}`);
  }

  /* --- опциональная блокировка аналитики --- */
  if (cfg.blockAds) {
    const BLOCK = /(aes|adjust|firebase|googletagmanager|google-analytics|doubleclick|aplus|hotjar|sentry)/i;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (BLOCK.test(u) && !/alicdn\.com\/frontend-lib/.test(u)) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
    log.info('блокировка аналитики/трекеров включена (--block-ads)');
  }

  if (cfg.verboseLogs) {
    page.on('console', (m) => log.debug(`[page console:${m.type()}] ${humanize(m.text(), 300)}`));
    page.on('pageerror', (e) => log.debug('[page error] ' + humanize(e.message, 300)));
  }
  page.on('dialog', async (d) => {
    log.warn(`диалог страницы (${d.type()}): ${humanize(d.message(), 160)} - принимаю`);
    await d.accept().catch(() => {});
  });
  browser.on('disconnected', () => log.warn('браузер отключился (disconnected)'));

  page.setDefaultTimeout(cfg.elementTimeout);
  page.setDefaultNavigationTimeout(cfg.navTimeout);

  return { browser, page, tempCopy, userDataDir };
}

/* ============================ login check ============================ */

/**
 * Достаем признаки сессии со страницы.
 * ВАЖНО: токен qwen-chat хранит НЕ в простом localStorage["active_token"],
 * а через token-coordinator (localStorage/sessionStorage + маркер
 * "qwen_token_session_marker"), поэтому смотрим все хранилища и ищем JWT-подобное.
 */
async function readSessionState(page) {
  return page.evaluate(async () => {
    const looksLikeJwt = (v) => typeof v === 'string' && v.split('.').length === 3 && v.length > 40;
    const hits = [];
    for (const storeName of ['localStorage', 'sessionStorage']) {
      let store;
      try {
        store = window[storeName];
      } catch (_) {
        continue;
      }
      if (!store) continue;
      for (let i = 0; i < store.length; i++) {
        let k;
        try {
          k = store.key(i);
        } catch (_) {
          continue;
        }
        if (!k) continue;
        let v = '';
        try {
          v = store.getItem(k) || '';
        } catch (_) {
          continue;
        }
        if (/token|jwt|session|auth/i.test(k) && v.length > 10) {
          hits.push({ store: storeName, key: k, preview: v.slice(0, 12), len: v.length, jwt: looksLikeJwt(v) });
        }
        if (looksLikeJwt(v)) hits.push({ store: storeName, key: k, preview: v.slice(0, 12), len: v.length, jwt: true });
      }
    }
    const cookies = document.cookie ? document.cookie.split(';').map((c) => c.trim().split('=')[0]) : [];
    const tokenishCookies = cookies.filter((c) => /token|session|auth|uid/i.test(c));

    // дополнительный (не обязательный) признак: авторизованный запрос к своему API из контекста страницы
    let api = { status: null, ok: false, id: null, email: null, error: null };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch('/api/v2/auths/', {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      api.status = r.status;
      const ct = r.headers.get('content-type') || '';
      if (/json/i.test(ct)) {
        const j = await r.json();
        api.ok = r.status === 200 && !!j;
        api.id = j && (j.id || null);
        api.email = j && (j.email || null);
        api.role = j && (j.role || null);
      } else {
        api.ok = false;
        api.error = 'non-json (' + ct.slice(0, 40) + ')';
      }
    } catch (e) {
      api.error = String((e && e.message) || e).slice(0, 120);
    }

    return {
      url: location.href,
      path: location.pathname,
      title: document.title,
      hits: hits.slice(0, 12),
      tokenishCookies,
      api,
      text: document.body && document.body.innerText ? document.body.innerText.slice(0, 300) : '',
    };
  });
}

async function isLoggedIn(ctx, reason = '') {
  const { page, cfg } = ctx;
  log.info(`проверяю авторизацию${reason ? ' (' + reason + ')' : ''}: открываю ${SITE}/settings/general`);

  let resp = null;
  try {
    resp = await page.goto(`${SITE}/settings/general`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
  } catch (e) {
    log.warn(`goto /settings/general бросил исключение: ${humanize(e.message, 160)} - смотрю, куда мы в итоге попали`);
  }
  await settle(ctx, 1.2);

  // SPA может доредиректить уже после domcontentloaded: ждем, пока URL устоится
  try {
    await page.waitForFunction(
      (origin) => {
        if (!location.href.startsWith(origin)) return true; // ушли на другой домен
        if (!/\/settings\/general/.test(location.pathname)) return true; // редирект прочь из настроек
        // всё еще на настройках: ждем появления контента
        return document.querySelectorAll('input,button,[role="button"]').length > 0;
      },
      { timeout: Math.min(8000, Math.max(cfg.elementTimeout, 8000)), polling: 200 },
      SITE
    );
  } catch (_) {}
  await sleep(500);

  const state = await readSessionState(page);
  const onSettings = /^\/settings(\/|$)/.test(state.path);

  log.debug('состояние после перехода', {
    url: state.url,
    path: state.path,
    httpStatus: resp ? resp.status() : 'n/a',
    onSettings,
    tokenKeys: state.hits.map((h) => `${h.store}:${h.key}${h.jwt ? '(jwt)' : ''}`),
    cookies: state.tokenishCookies,
    api: state.api,
    text: humanize(state.text, 120),
  });

  // Главное правило из ТЗ: /settings/general открывается => залогинены.
  // Анонима сайт редиректит на "/" - это и есть признак "не залогинен".
  if (onSettings) {
    const extra = state.api.ok
      ? `, API /api/v2/auths/ -> 200 (id=${state.api.id}, email=${state.api.email})`
      : `, API /api/v2/auths/ -> ${state.api.status || state.api.error || 'n/a'}`;
    log.ok(`профиль ЗАЛОГИНЕН: /settings/general открылся (url=${state.url}${extra})`);
    await shot(ctx, 'logged-in-settings');
    return true;
  }

  log.warn(
    `профиль НЕ залогинен: /settings/general не открылся, нас редиректнуло на ${state.url} ` +
      `(path=${state.path}, token-ключей найдено: ${state.hits.length}, API /api/v2/auths/ -> ${state.api.status || state.api.error || 'n/a'})`
  );
  await shot(ctx, 'not-logged-in');
  return false;
}

/* ============================ login flow ============================ */
async function clickByText(page, texts, scopeSel, label, timeout) {
  const list = Array.isArray(texts) ? texts : [texts];
  const found = await page.evaluateHandle(
    (scope, wanted) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const cands = Array.from(
        root.querySelectorAll('button, [role="button"], a, .qwen-chat-v2-btn, span.qwen-chat-v2-btn-content')
      );
      for (const w of wanted) {
        const target = norm(w);
        for (const el of cands) {
          const own = norm(el.textContent);
          if (!own) continue;
          if (own === target || own.startsWith(target)) {
            // предпочитаем кликабельного предка
            const clickable = el.closest('button,[role="button"],a') || el;
            const cs = getComputedStyle(clickable);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = clickable.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            return clickable;
          }
        }
      }
      return null;
    },
    scopeSel || null,
    list
  );
  const el = found.asElement();
  if (!el) {
    if (timeout) throw new StepError(`Не найдена кнопка "${list[0]}" (${label}) за ${timeout} мс`, EXIT.LOGIN_FAILED);
    return null;
  }
  await humanClick(page, el, label || list[0]);
  return el;
}

async function waitForAny(page, selectors, timeout, label) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = await findVisible(page, selectors, 0);
    if (hit) {
      log.debug(`${label}: найден ${hit.selector}`);
      return hit;
    }
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

async function handleCaptchaIfAny(ctx, stageLabel) {
  const cap = await detectCaptcha(ctx.page);
  const shown = cap.slider || cap.wafMeta || (cap.suspiciousIframes && cap.suspiciousIframes.length > 0);
  if (!shown) return false;

  log.warn(
    `Обнаружена капча/антибот (Aliyun Baxia) на этапе "${stageLabel}": ` +
      `slider=${cap.slider}, wafMeta=${cap.wafMeta}, iframes=${JSON.stringify(cap.suspiciousIframes)}`
  );
  await shot(ctx, 'captcha-detected');

  if (ctx.cfg.headless) {
    throw new StepError(
      'Сработала капча Aliyun Baxia, а браузер запущен в --headless - решить её некому.\n' +
        'Запустите без --headless и проведите слайдер руками (скрипт подождет --login-timeout), ' +
        'либо используйте уже "прогретый" профиль.',
      EXIT.CAPTCHA_BLOCKED
    );
  }

  log.warn(
    `!!! ТРЕБУЕТСЯ РУЧНОЕ ДЕЙСТВИЕ: решите капчу в открытом окне браузера. ` +
      `Жду до ${Math.round(ctx.cfg.loginTimeout / 1000)} с (--login-timeout)...`
  );
  const deadline = Date.now() + ctx.cfg.loginTimeout;
  while (Date.now() < deadline) {
    await sleep(1500);
    const c = await detectCaptcha(ctx.page);
    if (!c.slider && !c.wafMeta) {
      log.ok('капча решена, продолжаю');
      await settle(ctx);
      return true;
    }
    if ((Date.now() / 1000) % 15 < 1.6) log.debug('всё ещё жду решения капчи...');
  }
  throw new StepError('Капча так и не была решена за отведенное время (--login-timeout).', EXIT.CAPTCHA_BLOCKED);
}

async function ensurePasswordForm(ctx) {
  const { page, cfg } = ctx;

  const already = await findVisible(page, [SEL.passwordInput], 0);
  if (already) {
    log.debug('форма email+password уже на экране');
    return true;
  }

  // по умолчанию сайт показывает панель "Login with verification code" ->
  // переключаемся на пароль
  const otp = await findVisible(page, [SEL.otpPanel], 0);
  if (otp) log.info('вижу панель входа по коду подтверждения - переключаюсь на вход по паролю');

  const clicked = await clickByText(page, TXT.loginWithPassword, null, 'Log in with a password', 0);
  if (!clicked) {
    // запасной вариант: клик по самой ссылке-возврату в OTP-панели
    const back = await findVisible(page, [SEL.otpReturnButton], 0);
    if (back) {
      await humanClick(page, back.handle, 'otp-return button');
    }
  }
  await settle(ctx, 0.8);

  const pass = await waitForAny(page, [SEL.passwordInput, SEL.mobilePasswordInput], cfg.elementTimeout, 'поле пароля');
  if (!pass) {
    throw new StepError(
      'Не удалось добраться до формы входа по паролю: поле input[name="password"] не появилось.\n' +
        'Возможно, изменилась верстка (site version != ' + APP_VERSION_HINT + ') или форма закрыта капчей.',
      EXIT.LOGIN_FAILED
    );
  }
  log.ok('форма входа по паролю открыта');
  return true;
}

async function readErrorToasts(page) {
  try {
    return await page.evaluate(() => {
      const sels = [
        '.ant-message-notice-content',
        '.qwen-chat-v2-message',
        '[class*="message-notice"]',
        '[class*="toast"]',
        '.ant-form-item-explain-error',
      ];
      const out = [];
      for (const s of sels) {
        for (const el of Array.from(document.querySelectorAll(s))) {
          const t = (el.innerText || '').trim();
          if (t) out.push(t);
        }
      }
      return Array.from(new Set(out)).slice(0, 8);
    });
  } catch (_) {
    return [];
  }
}

async function performLogin(ctx) {
  const { page, cfg } = ctx;
  const deadline = Date.now() + cfg.loginTimeout;

  log.info(`начинаю авторизацию: ${cfg.login} (пароль: ${maskSecret(cfg.password)})`);
  await page.goto(`${SITE}/auth?action=signin`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
  await settle(ctx, 1.5);
  await shot(ctx, 'auth-page');

  const onAuth = await findVisible(page, [SEL.authRoot, SEL.otpPanel, SEL.authInputs], cfg.elementTimeout);
  if (!onAuth) {
    // возможно, мы уже залогинены (или нас выкинуло на главную)
    log.warn('страница /auth?action=signin не отдала форму авторизации - перепроверяю логин');
    if (await isLoggedIn(ctx, 'после перехода на /auth')) return true;
    throw new StepError('Не найдена форма авторизации на /auth?action=signin.', EXIT.LOGIN_FAILED);
  }
  log.debug('контейнер авторизации найден: ' + onAuth.selector);

  await handleCaptchaIfAny(ctx, 'открытие формы логина');
  await ensurePasswordForm(ctx);
  await shot(ctx, 'password-form');

  /* ---- email ---- */
  const emailHit = await findVisible(page, [SEL.emailInput, SEL.mobileEmailInput, 'input[name="email"]'], cfg.elementTimeout);
  if (!emailHit) throw new StepError('Не найдено поле email в форме входа.', EXIT.LOGIN_FAILED);
  await humanClick(page, emailHit.handle, 'email field');
  await emailHit.handle.evaluate((el) => {
    el.focus();
    if (typeof el.select === 'function') el.select();
  });
  await page.keyboard.press('Backspace');
  await sleep(randInt(80, 200));
  await setInputValue(page, emailHit.handle, cfg.login, 'email');
  // контрольный human-type последнего символа, чтобы React точно увидел ввод
  await page.keyboard.type(' ', { delay: 30 });
  await page.keyboard.press('Backspace');
  await sleep(randInt(120, 260));
  log.ok('email введен');

  /* ---- password ---- */
  const passHit = await findVisible(page, [SEL.passwordInput, SEL.mobilePasswordInput, 'input[name="password"]'], cfg.elementTimeout);
  if (!passHit) throw new StepError('Не найдено поле пароля в форме входа.', EXIT.LOGIN_FAILED);
  await humanClick(page, passHit.handle, 'password field');
  await passHit.handle.evaluate((el) => el.focus());
  await setInputValue(page, passHit.handle, cfg.password, 'password');
  await page.keyboard.type(' ', { delay: 25 });
  await page.keyboard.press('Backspace');
  await sleep(randInt(150, 320));
  log.ok('пароль введен (в логах не отображается)');

  /* ---- submit ---- */
  const submit = await findVisible(page, [SEL.submitButton], 0);
  if (submit) {
    const disabled = await submit.handle.evaluate((el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true');
    if (disabled) log.warn('кнопка "Log in" неактивна - возможно, форма считает данные неполными');
    await humanClick(page, submit.handle, 'Log in');
  } else {
    const byText = await clickByText(page, TXT.loginSubmit, null, 'Log in (by text)', 0);
    if (!byText) {
      log.warn('кнопка отправки не найдена - жму Enter в поле пароля');
      await page.keyboard.press('Enter');
    }
  }
  log.info('форма отправлена, жду результата...');

  /* ---- ждем результата ---- */
  let lastToasts = [];
  let lastUrl = page.url();
  while (Date.now() < deadline) {
    await sleep(1200);

    if (await handleCaptchaIfAny(ctx, 'после отправки формы логина')) continue;

    const st = await page.evaluate(() => {
      const otp = !!document.querySelector('.qwenchat-verification-code-input, .qwenchat-email-otp-panel-code-buttons');
      const stillAuth = !!document.querySelector('.qwenchat-page-auth');
      return {
        url: location.href,
        path: location.pathname,
        otp,
        stillAuth,
        text: document.body && document.body.innerText ? document.body.innerText.slice(0, 600) : '',
      };
    });

    const toasts = await readErrorToasts(page);
    if (toasts.length && JSON.stringify(toasts) !== JSON.stringify(lastToasts)) {
      lastToasts = toasts;
      log.warn('сообщение сайта: ' + toasts.map((t) => humanize(t, 160)).join(' | '));
    }

    // Успех = нас убрало со страницы /auth (приложение редиректит на "/" или на исходный from)
    if (!st.stillAuth && !/^\/auth/.test(st.path)) {
      const sess = await readSessionState(page).catch(() => null);
      const tokenKeys = sess ? sess.hits.map((h) => `${h.store}:${h.key}`) : [];
      log.ok(`авторизация выполнена: ушли со страницы /auth на ${st.url}`);
      log.debug('признаки сессии', { tokenKeys, cookies: sess ? sess.tokenishCookies : [], api: sess ? sess.api : null });
      await settle(ctx);
      await shot(ctx, 'after-login');
      return true;
    }

    if (st.otp) {
      throw new StepError(
        'Сайт запросил код подтверждения из почты (email OTP) - вход по паролю для этой учетки не сработал.\n' +
          'Возможные причины: аккаунт не зарегистрирован (нужен Sign up + подтверждение почты),\n' +
          'либо включена принудительная верификация. Автоматически читать почту скрипт не умеет.\n' +
          `Текст на странице: ${humanize(st.text, 220)}`,
        EXIT.LOGIN_FAILED
      );
    }

    const bad =
      /incorrect|invalid|not exist|doesn'?t exist|wrong|too many requests|неверн|не правильн|ошибк/i.test(st.text) ||
      toasts.some((t) => /incorrect|invalid|not exist|wrong|too many|неверн|ошибк/i.test(t));
    if (bad) {
      throw new StepError(
        `Вход отклонен сайтом. Вероятно, неверный логин/пароль или аккаунт не зарегистрирован.\n` +
          `login=${cfg.login}\n` +
          `Сообщения: ${JSON.stringify(toasts)}\n` +
          `Текст страницы: ${humanize(st.text, 300)}`,
        EXIT.LOGIN_FAILED
      );
    }

    if (st.url !== lastUrl) {
      log.debug('url изменился: ' + st.url);
      lastUrl = st.url;
    }
  }

  throw new StepError(
    `Авторизация не завершилась за ${Math.round(cfg.loginTimeout / 1000)} с (--login-timeout).\n` +
      `Последние сообщения сайта: ${JSON.stringify(lastToasts)}`,
    EXIT.LOGIN_FAILED
  );
}

/* ============================ agent mode ============================ */
async function getCurrentModeLabel(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '';
  }, SEL.modeCurrent);
}

async function listModeItems(page) {
  return page.evaluate(
    (menuSel, itemSel, nameSel) => {
      const menus = Array.from(document.querySelectorAll(menuSel));
      const out = [];
      const roots = menus.length ? menus : [document];
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll(itemSel))) {
          const nameEl = el.querySelector(nameSel);
          const r = el.getBoundingClientRect();
          const cls = el.className || '';
          out.push({
            text: ((nameEl ? nameEl.innerText : el.innerText) || '').replace(/\s+/g, ' ').trim(),
            disabled:
              el.getAttribute('aria-disabled') === 'true' ||
              /disabled/.test(cls) ||
              (el.closest('[aria-disabled="true"]') !== null && el.closest('.mode-select-dropdown-item') === null),
            visible: r.width > 2 && r.height > 2,
            cls: String(cls).slice(0, 120),
          });
        }
      }
      return out;
    },
    SEL.modeDropdownMenu,
    SEL.modeItem,
    SEL.modeItemName
  );
}

async function findModeItemHandle(page, wantedTexts) {
  const handle = await page.evaluateHandle(
    (itemSel, nameSel, wanted) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const items = Array.from(document.querySelectorAll(itemSel));
      for (const w of wanted) {
        const t = norm(w);
        for (const el of items) {
          const nameEl = el.querySelector(nameSel);
          const own = norm(nameEl ? nameEl.innerText : el.innerText);
          if (!own) continue;
          if (own === t || own.startsWith(t) || own.includes(t)) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            return el;
          }
        }
      }
      return null;
    },
    SEL.modeItem,
    SEL.modeItemName,
    wantedTexts
  );
  return handle.asElement();
}

async function openModeDropdown(ctx) {
  const { page, cfg } = ctx;
  const trigger = await findVisible(page, [SEL.modeCurrent], cfg.elementTimeout);
  if (!trigger) {
    throw new StepError(
      'Не найден переключатель режимов (.mode-select-current-mode) рядом с полем ввода.\n' +
        'Возможно, профиль не авторизован или верстка изменилась (ожидалась ' + APP_VERSION_HINT + ').',
      EXIT.AGENT_UNAVAILABLE
    );
  }
  const before = await getCurrentModeLabel(page);
  log.debug(`текущий режим: "${before}"`);
  await humanClick(page, trigger.handle, 'mode-select trigger');
  const menu = await waitForAny(page, [SEL.modeDropdownMenu], cfg.elementTimeout, 'выпадающее меню режимов');
  if (!menu) throw new StepError('Меню режимов не открылось после клика по переключателю.', EXIT.AGENT_UNAVAILABLE);
  await sleep(350);
  return before;
}

async function closeModeDropdown(ctx) {
  await ctx.page.keyboard.press('Escape').catch(() => {});
  await sleep(250);
}

async function enableAgentMode(ctx) {
  const { page, cfg } = ctx;
  log.info('переключаю режим в Agent Mode (--agent)');

  const before = await openModeDropdown(ctx);
  let items = await listModeItems(page);
  log.debug('пункты меню режимов', items);
  await shot(ctx, 'mode-dropdown');

  if (/agent/i.test(before)) {
    log.ok('Agent Mode уже активен - переключение не требуется');
    await closeModeDropdown(ctx);
    return;
  }

  let target = items.find((i) => /agent\s*mode|режим агента|^агент$/i.test(i.text));

  if (!target) {
    // пункт мог уехать в подменю "More" (в меню показывается максимум 8 фич)
    log.debug('Agent Mode не виден в основном меню - смотрю подменю "More"');
    const moreEl = await findModeItemHandle(page, TXT.more);
    if (moreEl) {
      await humanClick(page, moreEl, 'More submenu');
      await sleep(500);
      items = await listModeItems(page);
      log.debug('пункты после раскрытия "More"', items);
      target = items.find((i) => /agent\s*mode|режим агента|^агент$/i.test(i.text));
    }
  }

  if (!target) {
    await shot(ctx, 'agent-mode-missing');
    await closeModeDropdown(ctx);
    throw new StepError(
      'Agent Mode НЕДОСТУПЕН: пункта "Agent Mode" вообще нет в меню режимов этого аккаунта.\n' +
        `Доступные пункты: ${JSON.stringify(items.map((i) => i.text).filter(Boolean))}\n` +
        'Обычно это означает, что фича не включена для учетной записи/региона (featureStatuses из /api/v2 config)\n' +
        'или аккаунт не подтвержден. Дальше не продолжаю.',
      EXIT.AGENT_UNAVAILABLE
    );
  }

  if (target.disabled) {
    await shot(ctx, 'agent-mode-disabled');
    // попробуем вытащить подсказку
    let tip = '';
    try {
      const h = await findModeItemHandle(page, TXT.agentMode);
      if (h) {
        await h.hover().catch(() => {});
        await sleep(700);
        tip = await page.evaluate(() => {
          const t = document.querySelector('.ant-tooltip-inner, [role="tooltip"]');
          return t ? (t.innerText || '').trim() : '';
        });
      }
    } catch (_) {}
    await closeModeDropdown(ctx);
    throw new StepError(
      'Agent Mode НЕДОСТУПЕН: пункт есть в меню, но он неактивен (disabled).\n' +
        (tip ? `Подсказка сайта: ${tip}\n` : '') +
        'Частая причина - включен "temporary chat" (Agent Mode is unavailable in temporary chat)\n' +
        'либо фича выключена для аккаунта. Дальше не продолжаю.',
      EXIT.AGENT_UNAVAILABLE
    );
  }

  const targetHandle = await findModeItemHandle(page, TXT.agentMode);
  if (!targetHandle) throw new StepError('Не удалось получить handle пункта Agent Mode для клика.', EXIT.AGENT_UNAVAILABLE);
  await humanClick(page, targetHandle, 'Agent Mode item');
  await settle(ctx, 1.2);

  // сайт может открыть новый чат при переключении режима - дожидаемся поля ввода
  const input = await waitForAny(page, [SEL.textarea], cfg.elementTimeout, 'поле чата после смены режима');
  if (!input) throw new StepError('После выбора Agent Mode пропало поле ввода сообщения.', EXIT.AGENT_UNAVAILABLE);

  const after = await getCurrentModeLabel(page);
  log.debug(`режим после переключения: "${after}"`);
  if (!/agent/i.test(after)) {
    await shot(ctx, 'agent-mode-not-applied');
    const toasts = await readErrorToasts(page);
    throw new StepError(
      `Agent Mode НЕ включился: переключатель показывает "${after || '(пусто)'}" вместо Agent Mode.\n` +
        (toasts.length ? `Сообщения сайта: ${JSON.stringify(toasts)}\n` : '') +
        'Возможно, аккаунту фича недоступна или переключение требует нового чата.',
      EXIT.AGENT_UNAVAILABLE
    );
  }
  log.ok('Agent Mode включен и подтвержден переключателем режимов');
  await shot(ctx, 'agent-mode-active');
}

/* ============================ chat input & send ============================ */
async function startNewChat(ctx) {
  const { page, cfg } = ctx;
  log.info('создаю новый чат (--new-chat)');
  const btn = await findVisible(page, [SEL.newChatButton, 'a[href="/"]'], 0);
  if (btn) {
    await humanClick(page, btn.handle, 'new chat');
  } else {
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
  }
  await settle(ctx, 1.2);
}

async function ensureChatPage(ctx) {
  const { page, cfg } = ctx;
  const state = await page.evaluate(() => ({ path: location.pathname, href: location.href }));
  if (/^\/(settings|auth|community|legal)/.test(state.path)) {
    log.info(`перехожу с ${state.path} на страницу чата`);
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
    await settle(ctx, 1.5);
  } else {
    await sleep(300);
  }
}

async function typeMessage(ctx) {
  const { page, cfg } = ctx;
  log.info(`ввожу текст сообщения (${cfg.messageSource}, ${Array.from(cfg.messageText).length} симв.)`);
  log.debug('текст: ' + humanize(cfg.messageText, 200));

  const hit = await waitForAny(page, [SEL.textarea, 'textarea[placeholder]', '[contenteditable="true"]'], cfg.elementTimeout, 'поле ввода чата');
  if (!hit) {
    throw new StepError(
      'Не найдено поле ввода сообщения (textarea.message-input-textarea).\n' +
        'Возможно, профиль не авторизован, открыта не страница чата или верстка изменилась.',
      EXIT.INPUT_NOT_FOUND
    );
  }
  log.debug('поле ввода найдено: ' + hit.selector);

  await humanClick(page, hit.handle, 'chat textarea');
  await hit.handle.evaluate((el) => el.focus());

  const readOnly = await hit.handle.evaluate((el) => el.readOnly === true || el.getAttribute('readonly') !== null);
  if (readOnly) throw new StepError('Поле ввода в режиме "только чтение" - отправка невозможна.', EXIT.INPUT_NOT_FOUND);

  // Комбинация: быстрый reliable-путь (native setter + input event) и
  // "человеческий" доввод, чтобы React/autosize и антиспам-эвристики увидели живой набор.
  const text = cfg.messageText;
  const head = Array.from(text).slice(0, 12).join('');
  const tail = Array.from(text).slice(12).join('');

  await setInputValue(page, hit.handle, head, 'chat textarea');
  await page.keyboard.type(' ', { delay: 30 });
  await page.keyboard.press('Backspace');
  if (tail) {
    // добиваем остальной текст "руками"
    await hit.handle.evaluate((el, prefix) => {
      const proto = window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, prefix);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      el.setSelectionRange(prefix.length, prefix.length);
    }, head);
    await humanType(page, hit.handle, tail, cfg.typeDelay);
  }
  await sleep(randInt(200, 450));

  const actual = await hit.handle.evaluate((el) => el.value);
  if (actual !== text) {
    log.warn(`текст в поле не совпал (ожидал ${Array.from(text).length} симв., получил ${Array.from(actual || '').length}) - переустанавливаю значение`);
    await setInputValue(page, hit.handle, text, 'chat textarea (retry)');
    await sleep(250);
    const again = await hit.handle.evaluate((el) => el.value);
    if (again !== text) {
      throw new StepError(
        `Не удалось корректно вставить текст в поле ввода.\nОжидал: ${humanize(text, 120)}\nПолучил: ${humanize(again, 120)}`,
        EXIT.INPUT_NOT_FOUND
      );
    }
  }
  log.ok('текст вставлен в поле чата и сверен с эталоном');
  await shot(ctx, 'text-typed');
}

async function sendMessage(ctx) {
  const { page, cfg } = ctx;

  if (cfg.dryRun) {
    log.warn('--dry-run: текст введен, но НЕ отправлен');
    await shot(ctx, 'dry-run');
    return;
  }

  log.info('отправляю сообщение');
  const beforeCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, SEL.messageContainer);

  const sendWrap = await findVisible(page, [SEL.sendWrap], 0);
  let clicked = false;
  if (sendWrap) {
    const btn = await sendWrap.handle.evaluateHandle((el) => el.querySelector('button') || el);
    const el = btn.asElement();
    if (el) {
      const disabled = await el.evaluate((b) => b.disabled === true || b.getAttribute('aria-disabled') === 'true');
      if (disabled) {
        log.warn('кнопка отправки неактивна - пробую Enter');
      } else {
        await humanClick(page, el, 'send button');
        clicked = true;
      }
    }
  }
  if (!clicked) {
    const ta = await findVisible(page, [SEL.textarea], 0);
    if (ta) {
      await ta.handle.evaluate((el) => el.focus());
      await page.keyboard.press('Enter');
      log.debug('отправка через Enter');
    } else {
      throw new StepError('Не найдено ни кнопки отправки, ни поля ввода - отправить сообщение нечем.', EXIT.SEND_FAILED);
    }
  }

  await sleep(900);
  const sent = await page.evaluate(
    (taSel, msgSel, before) => {
      const ta = document.querySelector(taSel);
      return {
        textareaEmpty: ta ? (ta.value || '').trim().length === 0 : null,
        messageCount: document.querySelectorAll(msgSel).length,
        before,
        generating: !!document.querySelector('[class*="loading"], [class*="generating"], [class*="stop"]'),
        url: location.href,
      };
    },
    SEL.textarea,
    SEL.messageContainer,
    beforeCount
  );

  log.debug('состояние после отправки', sent);

  const okSignals = [sent.textareaEmpty === true, sent.messageCount > sent.before, /\/c\//.test(sent.url)];
  if (!okSignals.some(Boolean)) {
    await shot(ctx, 'send-failed');
    const toasts = await readErrorToasts(page);
    throw new StepError(
      'Похоже, сообщение НЕ отправилось: поле ввода не очистилось и новых сообщений не появилось.\n' +
        (toasts.length ? `Сообщения сайта: ${JSON.stringify(toasts)}\n` : '') +
        `Состояние: ${JSON.stringify(sent)}`,
      EXIT.SEND_FAILED
    );
  }

  log.ok(`сообщение отправлено (url=${sent.url}, сообщений в DOM: ${sent.before} -> ${sent.messageCount})`);
  await shot(ctx, 'message-sent');
}

async function captureResponse(ctx) {
  const { page, cfg } = ctx;
  log.info('пытаюсь вытащить текст ответа (--capture-response)');
  const deadline = Date.now() + cfg.captureTimeout;
  let lastText = '';
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const txt = await page.evaluate((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (!nodes.length) return '';
      const last = nodes[nodes.length - 1];
      return (last.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    }, SEL.messageContainer);
    if (txt && txt === lastText) {
      if (Date.now() - stableSince > 4000) break; // 4 с без изменений - считаем готовым
    } else {
      stableSince = Date.now();
      lastText = txt;
    }
    await sleep(1000);
  }
  if (lastText) log.ok('ответ ассистента:\n' + lastText.slice(0, 4000));
  else log.warn('текст ответа получить не удалось (пусто или не отрендерился)');
  await shot(ctx, 'final-response', true);
}

/* ============================ main ============================ */
async function main() {
  let cfg;
  try {
    cfg = await parseCli(process.argv.slice(2));
  } catch (err) {
    const code = err instanceof StepError ? err.exitCode : EXIT.BAD_ARGS;
    log.error(err && err.message ? err.message : String(err));
    process.exit(code);
  }

  log.info('=== qwen-chat-auto ===');
  log.debug('конфигурация (без секретов)', {
    userDataDir: path.resolve(cfg.userDataDir),
    profileCopy: cfg.profileCopy,
    agent: cfg.agent,
    headless: cfg.headless,
    lang: cfg.lang,
    messageSource: cfg.messageSource,
    messageLength: Array.from(cfg.messageText).length,
    messagePreview: humanize(cfg.messageText, 100),
    login: cfg.login || '(не задан)',
    password: cfg.password ? maskSecret(cfg.password) : '(не задан)',
    hasCreds: cfg.hasCreds,
    timings: {
      navTimeout: cfg.navTimeout,
      loginTimeout: cfg.loginTimeout,
      elementTimeout: cfg.elementTimeout,
      settleDelay: cfg.settleDelay,
      typeDelay: cfg.typeDelay,
      stepDelay: cfg.stepDelay,
      postWaitSec: cfg.postWaitSec,
    },
  });

  const launched = await launchBrowser(cfg);
  const ctx = new Ctx(cfg, launched.browser, launched.page);
  let exitCode = EXIT.OK;
  let tempCopyToRemove = launched.tempCopy;

  const shutdown = async (code, reason) => {
    try {
      if (cfg.keepOpen && code === EXIT.OK) {
        log.warn('--keep-open: оставляю браузер открытым. Нажмите Ctrl+C для выхода.');
        await new Promise(() => {});
      }
    } finally {
      try {
        await launched.browser.close();
      } catch (_) {}
      if (tempCopyToRemove) {
        try {
          fs.rmSync(tempCopyToRemove, { recursive: true, force: true });
          log.debug('временная копия профиля удалена: ' + tempCopyToRemove);
        } catch (_) {}
      }
      if (LOG_FILE.fd) {
        try {
          fs.closeSync(LOG_FILE.fd);
        } catch (_) {}
      }
      if (reason) log.info('завершение: ' + reason);
      process.exit(code);
    }
  };

  process.on('SIGINT', () => {
    log.warn('получен SIGINT - закрываю браузер');
    shutdown(EXIT.INTERNAL, 'прервано пользователем');
  });
  process.on('SIGTERM', () => shutdown(EXIT.INTERNAL, 'получен SIGTERM'));

  try {
    /* --- шаг 1: проверка логина --- */
    let authed = await isLoggedIn(ctx, 'первичная проверка');
    await sleep(cfg.stepDelay);

    /* --- шаг 2: логин при необходимости --- */
    if (!authed) {
      if (!cfg.hasCreds) {
        throw new StepError(
          'Профиль НЕ залогинен на chat.qwen.ai, а учетные данные не переданы.\n' +
            'Нужны --login и --password (или переменные окружения $QWEN_LOGIN/$QWEN_PASSWORD,\n' +
            'или --password-stdin). Без них скрипт не может авторизоваться - выхожу.\n' +
            'Альтернатива: залогиньтесь в этом профиле руками один раз, дальше сессия будет жить в --user-data-dir.',
          EXIT.NOT_LOGGED_IN
        );
      }
      const okLogin = await performLogin(ctx);
      if (!okLogin) throw new StepError('performLogin вернул false - авторизация не удалась.', EXIT.LOGIN_FAILED);

      log.info('контрольная проверка авторизации после логина');
      const verified = await isLoggedIn(ctx, 'контроль после логина');
      if (!verified) {
        throw new StepError(
          'После попытки входа /settings/general по-прежнему не открывается - профиль так и не залогинен.',
          EXIT.LOGIN_FAILED
        );
      }
      log.ok('ЭТАП ПРОЙДЕН: авторизация подтверждена открытием /settings/general');
      authed = true;
    } else {
      log.ok('ЭТАП ПРОЙДЕН: профиль уже был авторизован, логин не понадобился');
    }
    await sleep(cfg.stepDelay);

    /* --- шаг 3: страница чата --- */
    await ensureChatPage(ctx);
    if (cfg.newChat) await startNewChat(ctx);
    await settle(ctx);
    log.ok('ЭТАП ПРОЙДЕН: открыта страница чата ' + ctx.page.url());
    await shot(ctx, 'chat-page');

    /* --- шаг 4: agent mode --- */
    if (cfg.agent) {
      await enableAgentMode(ctx);
      log.ok('ЭТАП ПРОЙДЕН: режим агента активен');
      await sleep(cfg.stepDelay);
    } else {
      log.info('--agent не указан - остаюсь в текущем режиме чата');
    }

    /* --- шаг 5: ввод текста --- */
    await typeMessage(ctx);
    log.ok('ЭТАП ПРОЙДЕН: текст сообщения введен');
    await sleep(cfg.stepDelay);

    /* --- шаг 6: отправка --- */
    await sendMessage(ctx);
    if (cfg.dryRun) {
      log.ok('ЭТАП ПРОЙДЕН: dry-run завершен (сообщение не отправлялось)');
    } else {
      log.ok('ЭТАП ПРОЙДЕН: обработка сообщения запущена');
    }

    /* --- шаг 7: ожидание --- */
    const waitSec = cfg.postWaitSec;
    if (waitSec > 0) {
      log.info(`жду ${waitSec} с после запуска обработки (--post-wait)...`);
      const start = Date.now();
      for (;;) {
        const left = waitSec - Math.round((Date.now() - start) / 1000);
        if (left <= 0) break;
        if (left % 10 === 0) log.debug(`осталось ${left} с`);
        await sleep(1000);
      }
      log.ok(`ожидание завершено (${waitSec} с)`);
    }

    if (cfg.captureResponse && !cfg.dryRun) await captureResponse(ctx);

    await shot(ctx, 'final-state');
    log.ok('=== ГОТОВО: все этапы выполнены успешно ===');
    exitCode = EXIT.OK;
  } catch (err) {
    const code = err instanceof StepError ? err.exitCode : EXIT.INTERNAL;
    log.error(err && err.message ? err.message : String(err));
    if (err && err.details) log.error('детали', err.details);
    if (!(err instanceof StepError)) log.debug('stack: ' + (err && err.stack ? err.stack : 'n/a'));
    if (cfg.onErrorDump && ctx.page) {
      await dumpDiagnostics(ctx, `exit-${code}`).catch(() => {});
    }
    exitCode = code;
  }

  await shutdown(exitCode, exitCode === EXIT.OK ? 'успех' : `код выхода ${exitCode}`);
}

if (require.main === module) {
  main().catch((e) => {
    log.error('необработанная ошибка: ' + (e && e.stack ? e.stack : e));
    process.exit(EXIT.INTERNAL);
  });
}

module.exports = { EXIT, sha256hex, SEL, TXT };
