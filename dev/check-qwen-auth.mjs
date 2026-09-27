#!/usr/bin/env node
// check-qwen-auth.mjs
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

if (args.help) {
  console.log(`
Использование:
  node check-qwen-auth.mjs [опции]

Опции:
  --executable=...          Путь к Chromium.
  --profile=...             Папка профиля Chromium.
                            По умолчанию: ~/.config/chromium-automation
  --headless                Запустить в headless-режиме.
  --no-sandbox              Добавить --no-sandbox.
  --log-file=...            Файл для записи логов.
`);
  process.exit(0);
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

async function checkAuthStatus(page, domain) {
  log('Checking authentication status for domain:', { domain });
  
  try {
    const cookies = await page.cookies(`https://${domain}`);
    
    log('Cookies found:', { 
      count: cookies.length,
      names: cookies.map(c => c.name)
    });
    
    if (cookies.length === 0) {
      log('WARNING: No cookies found for domain - browser likely logged out', { domain });
    }
    
    const authCookiePatterns = ['session', 'token', 'auth', 'next-auth', 'jwt'];
    const foundAuthCookies = cookies.filter(c => 
      authCookiePatterns.some(pattern => c.name.toLowerCase().includes(pattern))
    );
    
    if (foundAuthCookies.length === 0 && cookies.length > 0) {
      log('INFO: No authentication cookies found among existing cookies', { 
        domain,
        searchedPatterns: authCookiePatterns
      });
    } else if (foundAuthCookies.length > 0) {
      log('Authentication cookies found', { 
        domain,
        authCookies: foundAuthCookies.map(c => ({ name: c.name, expires: c.expires }))
      });
    }
    
    const authStatus = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('button, a, span, div'));
      const hasSignIn = allElements.some(el => {
        const text = (el.textContent || '').toLowerCase();
        return /войти|sign\s*in|log\s*in|login/i.test(text);
      });
      
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
    
    return {
      cookiesCount: cookies.length,
      authCookiesCount: foundAuthCookies.length,
      ...authStatus
    };
    
  } catch (error) {
    log('ERROR checking authentication status:', { 
      domain,
      error: error.message
    });
    return { error: error.message };
  }
}

const browser = await puppeteer.launch({
  headless,
  executablePath,
  userDataDir,
  defaultViewport: null,
  args: [
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    ...(toBool(args['no-sandbox']) ? ['--no-sandbox'] : []),
  ],
});

try {
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  
  log('=== Проверка существующими методами ===');
  await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const authStatus = await checkAuthStatus(page, 'chat.qwen.ai');
  
  log('=== Проверка редиректами ===');
  
  // Проверка 1: /settings/general
  log('Переход на https://chat.qwen.ai/settings/general');
  await page.goto('https://chat.qwen.ai/settings/general', { waitUntil: 'networkidle2', timeout: 30000 });
  const settingsUrl = page.url();
  log('Текущий URL:', { url: settingsUrl });
  const settingsRedirected = !settingsUrl.startsWith('https://chat.qwen.ai/settings/general');
  log('Редирект с /settings/general:', { redirected: settingsRedirected });
  const isLoggedInBySettings = !settingsRedirected;
  log('Вывод по /settings/general:', { isLoggedIn: isLoggedInBySettings });

  // Проверка 2: /auth
  log('Переход на https://chat.qwen.ai/auth');
  await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'networkidle2', timeout: 30000 });
  const authUrl = page.url();
  log('Текущий URL:', { url: authUrl });
  const authRedirected = !authUrl.startsWith('https://chat.qwen.ai/auth');
  log('Редирект с /auth:', { redirected: authRedirected });
  const isLoggedInByAuth = authRedirected;
  log('Вывод по /auth:', { isLoggedIn: isLoggedInByAuth });
  
  log('=== Итог ===');
  log('Итоговый статус по редиректам:', {
    settings: isLoggedInBySettings ? 'Залогинен' : 'Не залогинен',
    auth: isLoggedInByAuth ? 'Залогинен' : 'Не залогинен',
    cookies: authStatus
  });

} finally {
  if (logStream) {
    logStream.end();
  }
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        await p.close();
      } catch (e) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (e) {}
  await browser.close();
}
