// type-and-submit.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq === -1) {
      out[item.slice(2)] = true;
    } else {
      out[item.slice(2, eq)] = item.slice(eq + 1);
    }
  }
  return out;
}

function toBool(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

const args = parseArgs(process.argv.slice(2));

const checkAuthDomain = typeof args['check-auth'] === 'string' ? args['check-auth'] : null;

if (args.help) {
  console.log(`
Использование:
  node type-and-submit.mjs \\
    --url="https://example.com/form" \\
    --text="Текст для ввода" \\
    --selector="textarea" \\
    [опции]

Обязательные:
  --url=...                 Куда переходить.
  --text=...                Текст для ввода.
                            Вместо этого можно использовать --text-file=...

Опции:
  --selector=...            Селектор поля. Если не указать, скрипт будет
                            пытаться работать с текущим активным элементом.
  --executable=...          Путь к Chromium.
                            Например: /usr/bin/chromium
                                      /usr/bin/chromium-browser
                                      /snap/bin/chromium
  --profile=...             Папка профиля Chromium.
                            По умолчанию: ~/.config/chromium-automation
  --headless                Запустить в headless-режиме.
  --fast-insert             Вставлять текст через CDP Input.insertText.
                            Полезно для большого или многострочного текста.
  --clear                   Сначала очистить поле: Ctrl+A, Backspace.
  --delay=20                Задержка между символами при обычном вводе, мс.
  --wait-after-load=2000    Сколько ждать после загрузки страницы, мс.
  --hold-open=30000         Сколько держать браузер открытым после Ctrl+Enter, мс.
  --slow-mo=0               Замедлить действия Puppeteer, удобно для отладки.
  --no-sandbox              Добавить --no-sandbox. Нужно иногда в Docker/root.
  --debug                   Логировать сетевые запросы и ответы.
  --log-file=...            Файл для записи логов (если не указан, пишет в stdout).
  --eval=...                Произвольный JS-код, который выполнится в контексте
                            страницы после вставки текста, но перед Ctrl+Enter.
  --eval-file=...           То же самое, но код читается из файла.
  --eval-delay=250          Пауза после выполнения произвольного кода, мс.
                            Полезно, если код запускает асинхронные операции.
  --check-auth=...          Проверить статус авторизации для указанного домена.
                            Пример: --check-auth=chat.qwen.ai
                            Логирует наличие cookies и признаки авторизации.
`);
  process.exit(0);
}

const url = typeof args.url === 'string' ? args.url : '';
const selector = typeof args.selector === 'string' ? args.selector : '';
let text = typeof args.text === 'string' ? args.text : '';
if (typeof args['text-file'] === 'string') {
  text = fs.readFileSync(args['text-file'], 'utf8');
}

// Произвольный код для выполнения после вставки текста
let evalCode = typeof args.eval === 'string' ? args.eval : '';
if (typeof args['eval-file'] === 'string') {
  evalCode = fs.readFileSync(args['eval-file'], 'utf8');
}

if (!url) {
  console.error('Нужно указать --url=...');
  process.exit(1);
}
if (!text) {
  console.error('Нужно указать --text=... или --text-file=...');
  process.exit(1);
}

const executablePath =
  typeof args.executable === 'string' && args.executable
    ? args.executable
    : process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const userDataDir =
  typeof args.profile === 'string' && args.profile
    ? args.profile
    : path.join(os.homedir(), '.config', 'chromium-automation');

const headless = toBool(args.headless);
const waitAfterLoad = Number(args['wait-after-load'] ?? 2000);
const holdOpen = Number(args['hold-open'] ?? 30000);
const typeDelay = Number(args.delay ?? 20);
const evalDelay = Number(args['eval-delay'] ?? 250);
const clearFirst = toBool(args.clear);
const debugMode = toBool(args.debug);

// Если текст большой или содержит переводы строк, лучше использовать insertText.
const useFastInsert =
  toBool(args['fast-insert']) ||
  text.length > 2000 ||
  text.includes('\n');

// Настройка логирования
const logFile = typeof args['log-file'] === 'string' ? args['log-file'] : null;
const logStream = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const output = data ? `${timestamp} ${message} ${JSON.stringify(data, null, 2)}` : `${timestamp} ${message}`;
  if (logStream) {
    logStream.write(output + '\n');
  } else {
    console.log(output);
  }
}

// Функция проверки статуса авторизации для конкретного домена
async function checkAuthStatus(page, domain) {
  log('Checking authentication status for domain:', { domain });
  
  try {
    // Получаем все cookies для домена
    const cookies = await page.cookies(`https://${domain}`);
    
    log('Cookies found:', { 
      count: cookies.length,
      names: cookies.map(c => c.name)
    });
    
    if (cookies.length === 0) {
      log('WARNING: No cookies found for domain - browser likely logged out', { domain });
    }
    
    // Проверяем наличие типичных auth cookies
    const authCookiePatterns = ['session', 'token', 'auth', 'next-auth', 'jwt'];
    const foundAuthCookies = cookies.filter(c => 
      authCookiePatterns.some(pattern => c.name.toLowerCase().includes(pattern))
    );
    
    if (foundAuthCookies.length === 0 && cookies.length > 0) {
      log('INFO: No authentication cookies found among existing cookies', { 
        domain,
        searchedPatterns: authCookiePatterns,
        allCookies: cookies.map(c => ({ name: c.name, expires: c.expires }))
      });
    } else if (foundAuthCookies.length > 0) {
      log('Authentication cookies found', { 
        domain,
        authCookies: foundAuthCookies.map(c => ({ name: c.name, expires: c.expires }))
      });
    }
    
    // Проверяем DOM на признаки авторизации
    const authStatus = await page.evaluate(() => {
      // Ищем кнопку "Войти" или "Sign in"
      const allElements = Array.from(document.querySelectorAll('button, a, span, div'));
      const hasSignIn = allElements.some(el => {
        const text = (el.textContent || '').toLowerCase();
        return /войти|sign\s*in|log\s*in|login/i.test(text);
      });
      
      // Ищем аватар или элементы пользователя
      const userSelectors = [
        '[class*="avatar"]',
        '[class*="user"]',
        '[data-testid*="user"]',
        '[class*="profile"]',
        '[class*="account"]'
      ];
      const hasUserElement = userSelectors.some(selector => !!document.querySelector(selector));
      
      return {
        hasSignInButton: hasSignIn,
        hasUserElement: hasUserElement,
        isLikelyLoggedIn: !hasSignIn && hasUserElement
      };
    });
    
    log('DOM authentication indicators:', authStatus);
    
    if (authStatus.hasSignInButton) {
      log('WARNING: Sign-in UI detected - user likely NOT logged in', { domain });
    }
    
    return {
      cookiesCount: cookies.length,
      authCookiesCount: foundAuthCookies.length,
      ...authStatus
    };
    
  } catch (error) {
    log('ERROR checking authentication status:', { 
      domain,
      error: error.message,
      stack: error.stack 
    });
    return { error: error.message };
  }
}


if (debugMode) {
  log('Debug mode enabled');
}

const browser = await puppeteer.launch({
  headless,
  executablePath,
  userDataDir,
  defaultViewport: null,
  slowMo: Number(args['slow-mo'] ?? 0),
  args: [
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    ...(toBool(args['no-sandbox']) ? ['--no-sandbox'] : []),
  ],
});

try {
  const pages = await browser.pages();
  const page =
    pages.find((p) => p.url() !== 'about:blank') ||
    pages[0] ||
    (await browser.newPage());

  await page.bringToFront();

  // Настраиваем логирование запросов, если включен debug-режим
  if (debugMode) {
    // Логируем исходящие запросы
    page.on('request', (request) => {
      const method = request.method();
      const resourceType = request.resourceType();
      // Пропускаем навигационные запросы и статические ресурсы
      if (request.isNavigationRequest()) return;
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) return;
      const logData = {
        url: request.url(),
        method: method,
        headers: request.headers(),
      };
      // Добавляем тело запроса для POST/PUT/PATCH
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        logData.postData = request.postData();
      }
      log(`>>> REQUEST [${method}]`, logData);
    });

    // Логируем ответы
    page.on('response', (response) => {
      const request = response.request();
      const method = request.method();
      const resourceType = request.resourceType();
      // Пропускаем навигационные запросы и статические ресурсы
      if (request.isNavigationRequest()) return;
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) return;
      const logData = {
        url: response.url(),
        method: method,
        status: response.status(),
        headers: response.headers(),
      };
      log(`<<< RESPONSE [${response.status()}]`, logData);
    });

    // Логируем ошибки страницы
    page.on('pageerror', (error) => {
      log('PAGE ERROR', { message: error.message, stack: error.stack });
    });
    page.on('error', (error) => {
      log('PAGE ERROR', { message: error.message, stack: error.stack });
    });

    // Логируем console.log из браузера
    page.on('console', (message) => {
      const type = message.type();
      const text = message.text();
      log(`CONSOLE [${type}]`, { text });
    });
  }

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  if (debugMode) {
    log('Page loaded', { url: page.url() });
  }

  await new Promise((resolve) => setTimeout(resolve, waitAfterLoad));

  // Проверяем статус авторизации, если указан домен
  if (checkAuthDomain) {
    await checkAuthStatus(page, checkAuthDomain);
  }

  if (selector) {
    await page.waitForSelector(selector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(selector);
    await page.focus(selector);
    if (debugMode) {
      log('Field focused', { selector });
    }
  } else {
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && typeof el.focus === 'function') {
        el.focus();
      }
    });
  }

  if (clearFirst) {
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
  }

  if (useFastInsert) {
    const cdp = await page.createCDPSession();
    await cdp.send('Input.insertText', { text });
    if (debugMode) {
      log('Text inserted via CDP', { length: text.length });
    }
  } else {
    await page.keyboard.type(text, { delay: typeDelay });
    if (debugMode) {
      log('Text typed', { length: text.length });
    }
  }

  // Небольшая пауза, чтобы страница успела обработать ввод.
  await new Promise((resolve) => setTimeout(resolve, 250));

  // ===== Произвольный код после вставки текста =====
  if (evalCode) {
    if (debugMode) {
      log('Evaluating custom code', { code: evalCode });
    }
    try {
      const evalResult = await page.evaluate(
        new Function('return (async () => {' + evalCode + '})()')
      );
      if (debugMode) {
        log('Custom code executed', { result: evalResult });
      }
    } catch (evalError) {
      log('CUSTOM CODE ERROR', { message: evalError.message, stack: evalError.stack });
      // Не прерываем скрипт — просто логируем ошибку.
      // Если нужно прерывать, раскомментируй строку ниже:
      // throw evalError;
    }
    // Кастомная пауза после выполнения произвольного кода.
    await new Promise((resolve) => setTimeout(resolve, evalDelay));
  }
  // ===== Конец произвольного кода =====

  // Ctrl+Enter
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');

  if (debugMode) {
    log('Ctrl+Enter pressed');
  }

  // Ждём нужное время.
  await new Promise((resolve) => setTimeout(resolve, holdOpen));
} finally {
  if (logStream) {
    logStream.end();
  }
  // Более корректное закрытие браузера для сохранения данных профиля (cookies и т.д.)
  try {
    // Закрываем все открытые страницы
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        await p.close();
      } catch (e) {
        // Игнорируем ошибки при закрытии отдельных страниц
      }
    }
    // Даём Chromium время на завершение внутренних операций и сохранение cookies
    await new Promise((resolve) => setTimeout(resolve, 10000));
  } catch (e) {
    // Если не получилось закрыть страницы, всё равно пробуем закрыть браузер
  }
  await browser.close();
}
