#!/usr/bin/env node
'use strict';
// push-silentpr: перенос silentpr/<target>/<branch> из source-форка в целевые ремоуты.
// Реализация на NodeJS (основной язык проекта) — без bash-экранирования и ловушек stdin.
const { spawnSync } = require('child_process');
const readline = require('readline');

// ---------- git-обёртки ----------
function git(args) { return spawnSync('git', args, { encoding: 'utf8' }); }
function gitOut(args) { const r = git(args); return r.status === 0 ? r.stdout : null; }
function gitOk(args) { return git(args).status === 0; }
// inherit: git сам рисует цветной diff / пейджер / прогресс пуша в терминал
function gitInherit(args) { return spawnSync('git', args, { stdio: 'inherit' }).status; }
function gitQuiet(args) { return spawnSync('git', args, { stdio: ['ignore', 'ignore', 'ignore'] }).status; }
function revparse(ref) { const o = gitOut(['rev-parse', ref]); return o ? o.trim() : null; }
function shortSha(sha) { const o = gitOut(['rev-parse', '--short', sha]); return o ? o.trim() : sha; }

// ---------- состояние целевой ветки ----------
// Fetch с ЯВНЫМ refspec: при урезанном remote.<name>.fetch обычный
// `git fetch remote branch` возвращает 0, но refs/remotes/<remote>/<branch> не создаёт.
function fetchTargetBranch(remote, branch) {
  const r = git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  if (r.status === 0) return { ok: true, absent: false, err: '' };
  const err = (r.stderr || '').trim();
  // «Ветки нет» — это ответ сервера, а не сбой связи: только он даёт право считать target отсутствующим.
  const absent = /couldn'?t find remote ref|remote ref does not exist/i.test(err);
  return { ok: false, absent, err };
}
function targetState(remote, branch) {
  const f = fetchTargetBranch(remote, branch);
  const sha = revparse(`refs/remotes/${remote}/${branch}`);
  return { sha, exists: !!sha, certain: f.ok || f.absent, err: f.err };
}
// Правда с сервера: локальный refs/remotes/... может врать (протухший кэш, упавший fetch).
function lsRemoteBranch(remote, branch) {
  const r = git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  if (r.status !== 0) return { ok: false, sha: null, err: (r.stderr || '').trim() };
  const want = `refs/heads/${branch}`;
  for (const line of (r.stdout || '').split('\n').filter(Boolean)) {
    const [sha, ref] = line.split(/\s+/);
    if (ref === want) return { ok: true, sha, err: '' };
  }
  return { ok: true, sha: null, err: '' };
}
// Подсказка «а не перепутано ли имя ветки»: похожие ветки целевого ремоута.
function branchTokens(s) { return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3); }
function suggestBranches(remote, branch) {
  const names = (gitOut(['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`]) || '')
    .split('\n').filter(Boolean).map((r) => r.slice(remote.length + 1));
  const want = branchTokens(branch);
  const best = names
    .map((n) => ({ n, score: branchTokens(n).filter((t) => want.includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.n.localeCompare(b.n))
    .slice(0, 8);
  if (!best.length) { console.log('   Похожих веток в этом ремоуте не нашлось.'); return; }
  console.log(`   Похожие ветки в ${remote} (вдруг имя ветки перепутано):`);
  for (const x of best) console.log(`     • ${x.n}`);
}

// ---------- ввод ----------
// terminal:false — терминал в каноническом режиме (пейджер git живёт, echo делает драйвер).
// Строки складываем в очередь: при ответах через pipe они приходят заранее,
// и rl.question потерял бы те, что пришли до вызова вопроса. Очередь ничего не теряет.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lineQueue = [];
let lineWaiter = null;
let inputClosed = false;
rl.on('line', (l) => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); }
  else lineQueue.push(l);
});
rl.on('close', () => {
  inputClosed = true;
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(null); }
});
function ask(prompt) {
  process.stdout.write(prompt);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((res) => { lineWaiter = res; });
}
function eofExit() { console.log('\n⏹️  Ввод закончился (EOF) — выходим.'); process.exit(0); }

// ---------- строка состояния ----------
// safe (по умолчанию): счётчики в заголовке окна/вкладки (OSC) + печатная строка
//   перед каждым silentpr. Курсором не управляет вовсе — вывод git затереть не может.
// top (--ui=top): верхняя строка терминала под панель, остальное — область прокрутки
//   (DECSTBM). Область прокрутки — состояние терминала, а не процесса, поэтому
//   цветной diff и пейджер git живут как жили.
// Без TTY (pipe, CI), при TERM=dumb и с --no-ui всё выключено.
const UI = {
  mode: 'off', total: 0, index: 0, pushed: 0, deleted: 0, skipped: 0, hidden: 0, failed: 0, current: '',
  line() {
    return `silentpr ${this.index}/${this.total} | осталось ${Math.max(0, this.total - this.index)}` +
      ` | запушено ${this.pushed} | снесено ${this.deleted} | пропущено ${this.skipped}` +
      (this.hidden ? ` | скрыто ${this.hidden}` : '') +
      (this.failed ? ` | ошибок ${this.failed}` : '') + (this.current ? ` | ${this.current}` : '');
  },
  init() {
    if (this.mode === 'safe') { process.stdout.write('\x1b[22;0t'); this.draw(); return; }
    if (this.mode !== 'top') return;
    const rows = process.stdout.rows || 24;
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`\x1b[2;${rows}r\x1b[2;1H`);
    this.draw();
  },
  draw() {
    if (this.mode === 'off') return;
    const cols = process.stdout.columns || 80;
    let s = this.line();
    if (s.length > cols) s = s.slice(0, cols - 1) + '…';
    if (this.mode === 'safe') { process.stdout.write(`\x1b]0;${s}\x07`); return; }
    // top: сохраняем/возвращаем курсор — панель не сдвигает точку вывода git.
    process.stdout.write('\x1b7\x1b[1;1H\x1b[2K\x1b[7m' + s.padEnd(cols) + '\x1b[0m\x1b8');
  },
  banner() { if (this.mode === 'safe') console.log(`📊 ${this.line()}`); },
  done() {
    const m = this.mode; this.mode = 'off';
    if (m === 'safe') { process.stdout.write('\x1b[23;0t'); return; }
    if (m !== 'top') return;
    process.stdout.write('\x1b[r\x1b7\x1b[1;1H\x1b[2K\x1b8\n');
  },
};
process.on('exit', () => UI.done());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));

// Ветка с таким именем в ДРУГИХ ремоутах: частая причина «target не существует» —
// в имени silentpr указан не тот ремоут (например, автор PR, а ветка лежит в upstream).
function branchElsewhere(branch, excludeRemote) {
  const out = gitOut(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']) || '';
  const hits = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const i = line.indexOf('/');
    if (i < 0) continue;
    const r = line.slice(0, i), b = line.slice(i + 1);
    if (r !== excludeRemote && b === branch && !hits.includes(r)) hits.push(r);
  }
  return hits;
}

// ---------- классификация пробелов ----------
function normWs(buf) {
  const lines = buf.toString('utf8').split('\n')
    .map((l) => l.replace(/^[ \t\r\f\v]+|[ \t\r\f\v]+$/g, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
function showFileBuf(sha, f) {
  const r = spawnSync('git', ['show', `${sha}:${f}`]);
  return r.status === 0 ? r.stdout : null;
}
// '' | 'whitespace-only' | 'trimmed-whitespace only'
function classifyWhitespace(a, b) {
  if (gitOk(['diff', '--quiet', a, b])) return '';
  const ign = gitOut(['diff', '--ignore-all-space', '--ignore-blank-lines', a, b]);
  if (ign === null || ign.length > 0) return '';
  const names = gitOut(['diff', '--name-only', '--no-renames', '-z', a, b]) || '';
  let trimmed = true;
  for (const f of names.split('\0').filter(Boolean)) {
    if (!gitOk(['cat-file', '-e', `${a}:${f}`]) || !gitOk(['cat-file', '-e', `${b}:${f}`])) { trimmed = false; break; }
    const fa = showFileBuf(a, f), fb = showFileBuf(b, f);
    if (fa === null || fb === null || normWs(fa) !== normWs(fb)) { trimmed = false; break; }
  }
  return trimmed ? 'trimmed-whitespace only' : 'whitespace-only';
}
function wsNote(a, b) { const n = classifyWhitespace(a, b); if (n) console.log(`⚙️  ${n}`); }

// ---------- показ изменений ----------
function commitMessage(sha) {
  console.log(`💬 Сообщение коммита ${shortSha(sha)}:`);
  gitInherit(['log', '-1', '--format=%B', sha]);
}
function showDiff(a, b) {
  const cnt = gitOut(['rev-list', '--count', '--first-parent', `${a}..${b}`]);
  if (cnt && cnt.trim() === '1') commitMessage(b);
  wsNote(a, b);
  gitInherit(['diff', '--color=always', '--stat', '--patch', a, b]);
}
function showCommit(c) {
  commitMessage(c);
  wsNote(`${c}^`, c);
  gitInherit(['diff', '--color=always', '--stat', '--patch', `${c}^`, c]);
}

// ---------- что показывать и что фильтровать ----------
// Пара для диффа считается один раз: её используют и фильтры (--skip-reverse,
// --max-diff-lines), и askAction. После действия f пересчитывается заново.
function displayPair(sourceSha, targetRemote, branchName, st) {
  const p = { a: '', b: '', splitBase: '', splitWhy: '', title: '', reverse: false };
  if (st.exists) {
    if (gitOk(['merge-base', '--is-ancestor', sourceSha, st.sha])) {
      p.a = sourceSha; p.b = st.sha; p.reverse = true;
      p.title = '📄 Diff source → target (что получит source при обновлении):';
      p.splitWhy = 's недоступен: source отстаёт от target, пушить нечего (y обновит source)';
    } else {
      p.a = st.sha; p.b = sourceSha;
      p.title = '📄 Diff target → source (что уйдёт в target при пуше):';
      if (gitOk(['merge-base', '--is-ancestor', st.sha, sourceSha])) p.splitBase = st.sha;
      else p.splitWhy = 's недоступен: ветки diverged, сначала нужен merge/rebase';
    }
    return p;
  }
  let base = '', baseName = '';
  for (const cand of ['devel', 'main', 'master']) {
    const r = `refs/remotes/${targetRemote}/${cand}`;
    if (gitOk(['rev-parse', '--verify', '--quiet', r])) {
      const mb = gitOut(['merge-base', sourceSha, r]);
      if (mb && mb.trim()) { base = mb.trim(); baseName = `${targetRemote}/${cand}`; break; }
    }
  }
  if (!base && gitQuiet(['fetch', '--quiet', targetRemote, 'devel']) === 0) {
    const mb = gitOut(['merge-base', sourceSha, 'FETCH_HEAD']);
    if (mb && mb.trim()) { base = mb.trim(); baseName = `${targetRemote}/devel`; }
  }
  if (base) {
    p.a = base; p.b = sourceSha; p.splitBase = base;
    p.title = `📄 Diff от общей базы с ${baseName} (ветка новая):`;
  } else {
    p.title = '📄 Общей базы нет, показываю последний коммит source:';
    p.splitWhy = 's недоступен: нет общей базы для отсчёта коммитов';
  }
  return p;
}
// Сколько строк изменено в том самом диффе, который увидит человек (сумма + и −).
// Бинарники в --numstat дают '-' и в счёт не идут. null — git посчитать не смог.
function diffLines(p, sourceSha) {
  const out = p.a ? gitOut(['diff', '--numstat', '--no-renames', p.a, p.b])
    : gitOut(['show', '--numstat', '--format=', '--no-renames', sourceSha]);
  if (out === null) return null;
  let n = 0;
  for (const line of out.split('\n').filter(Boolean)) {
    const [add, del] = line.split('\t');
    n += (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
  }
  return n;
}

// ---------- автоочистка принятых silentpr ----------
// --prune-trivial / --prune-reverse: голова silentpr уже целиком в target
// (совпадает с ней или является её предком) — по соглашению такой silentpr удаляют.
// Вызывается только при достоверном состоянии target (st.certain).
function pruneAccepted(sourceRemote, srcRef, sourceSha, why) {
  console.log(`🗑️  ${why} — сносим принятую ветку source ${sourceRemote}/${srcRef}`);
  console.log(`   Было: ${sourceSha}`);
  console.log(`   Вернуть, если передумаешь: git push ${sourceRemote} ${sourceSha}:refs/heads/${srcRef}`);
  if (gitInherit(['push', sourceRemote, '--delete', `refs/heads/${srcRef}`]) === 0) {
    gitQuiet(['update-ref', '-d', `refs/remotes/${sourceRemote}/${srcRef}`]);
    console.log('   ✅ Ветка source удалена');
    return true;
  }
  console.log('   ❌ Ошибка удаления ветки source');
  return false;
}

// ---------- интерактивный вопрос ----------
const HELP = [
  '  y - Запушить source в target (или обновить source если target опережает)',
  '  n - Пропустить этот silentpr',
  '  d - Удалить изменения: force reset source к target; если target НЕ существует — снести ветку source',
  '  s - Разбить на коммиты: принимать по одному, от старых к новым',
  '  f - Сфетчить целевой ремоут целиком (--prune) и перепроверить target',
  '  ? - Показать эту справку',
];
async function askAction(ref, targetRemote, branchName, sourceSha, state, pair) {
  // redraw: после действия f шапка и diff перерисовываются заново, уже по свежему состоянию.
  redraw: for (;;) {
    const targetSha = state.sha, targetExists = state.exists;
    console.log('');
    console.log(`📋 SilentPR: ${ref}`);
    console.log(`   Целевой ремоут: ${targetRemote}`);
    console.log(`   Имя ветки: ${branchName}`);
    console.log(`   Source SHA: ${sourceSha.slice(0, 9)}`);
    if (targetExists) {
      console.log(`   Target SHA: ${targetSha.slice(0, 9)}`);
      if (gitOk(['merge-base', '--is-ancestor', sourceSha, targetSha]))
        console.log('   Статус: ⚠️  Target опережает source (можно обновить source)');
      else if (gitOk(['merge-base', '--is-ancestor', targetSha, sourceSha]))
        console.log('   Статус: 🚀 Source опережает target (можно запушить)');
      else
        console.log('   Статус: ❌ Ветки diverged (нужен merge/rebase)');
      if (!state.certain)
        console.log('   ⚠️  Fetch target не удался: показан локальный ref, он может быть устаревшим (f — перепроверить)');
    } else if (state.certain) {
      console.log('   Target SHA: (не существует)');
      console.log('   Статус: 🆕 Target не существует');
      console.log('   ⚠️  d снесёт ветку source насовсем; f — сфетчить ремоут и перепроверить имя ветки');
      const other = branchElsewhere(branchName, targetRemote);
      if (other.length) console.log(`   ℹ️  Ветка '${branchName}' есть в других ремоутах: ${other.join(', ')} — похоже, в имени silentpr не тот ремоут`);
    } else {
      console.log('   Target SHA: (неизвестно)');
      console.log('   Статус: ❓ Target не проверен: fetch упал (f — попробовать снова)');
      if (state.err) console.log(`   git: ${state.err.split('\n')[0]}`);
    }

    // Diff перед вопросом + база для split-режима (действие s)
    let splitBase = pair.splitBase, splitWhy = pair.splitWhy;
    console.log('');
    console.log(pair.title);
    // Неизвестное состояние target — никаких разрушительных действий и никакой разбивки.
    if (!state.certain) { splitBase = ''; splitWhy = 's недоступен: состояние target неизвестно, сначала f'; }
    if (pair.a) showDiff(pair.a, pair.b);
    else gitInherit(['show', '--color=always', '--stat', sourceSha]);

    console.log('');
    console.log('Действие? [y/n/d/s/f/?]');
    HELP.forEach((l) => console.log(l));
    console.log('');
    for (;;) {
      const choice = await ask('Ваш выбор: ');
      if (choice === null) eofExit();
      const c = choice.trim();
      if (/^[yY]$/.test(c)) return { action: 'y', splitBase };
      if (/^[nN]$/.test(c)) return { action: 'n', splitBase };
      if (/^[dD]$/.test(c)) {
        if (!targetExists && !state.certain) {
          console.log('⛔ Состояние target неизвестно — удалять ветку source нельзя. Нажми f.');
          continue;
        }
        return { action: 'd', splitBase };
      }
      if (/^[sS]$/.test(c)) {
        if (splitBase) return { action: 's', splitBase };
        console.log(splitWhy);
        continue;
      }
      if (/^[fF]$/.test(c)) {
        console.log('');
        console.log(`🔄 Фетчим ${targetRemote} целиком (--prune)...`);
        const rc = gitInherit(['fetch', '--prune', targetRemote, `+refs/heads/*:refs/remotes/${targetRemote}/*`]);
        const sha = revparse(`refs/remotes/${targetRemote}/${branchName}`);
        state.sha = sha; state.exists = !!sha;
        state.certain = rc === 0; state.err = rc === 0 ? '' : 'fetch завершился с ошибкой';
        if (rc !== 0) console.log(`❌ Fetch не удался — состояние ${targetRemote} по-прежнему неизвестно.`);
        else if (state.exists) console.log(`✅ Target найден: ${sha.slice(0, 9)}`);
        else {
          console.log(`ℹ️  Ветки '${branchName}' в ${targetRemote} нет и после полного fetch.`);
          suggestBranches(targetRemote, branchName);
        }
        pair = displayPair(sourceSha, targetRemote, branchName, state);
        continue redraw;
      }
      if (c === '?') {
        console.log('');
        console.log('Доступные действия:');
        HELP.forEach((l) => console.log(l));
        console.log('');
        continue;
      }
      console.log(`Неизвестный выбор: ${choice}`);
    }
  }
}

// ---------- split-режим ----------
async function splitPush(base, targetRemote, branchName, sourceSha) {
  const total = (gitOut(['rev-list', '--count', '--first-parent', `${base}..${sourceSha}`]) || '0').trim();
  console.log('');
  console.log(`✂️  Split-режим: коммитов к разбору: ${total} (от старых к новым)`);
  const list = (gitOut(['rev-list', '--reverse', '--first-parent', `${base}..${sourceSha}`]) || '')
    .split('\n').filter(Boolean);
  let i = 0, pushed = 0;
  for (const c of list) {
    i++;
    console.log('');
    console.log(`── Коммит ${i}/${total} ──`);
    showCommit(c);
    let choice;
    for (;;) {
      choice = await ask('Принять этот коммит? [y/n/?] ');
      if (choice === null) eofExit();
      const cc = choice.trim();
      if (/^[yYnN]$/.test(cc)) { choice = cc; break; }
      if (cc === '?') {
        console.log('  y - запушить этот коммит и перейти к следующему');
        console.log('  n - остановиться (остальные коммиты останутся только в source)');
        continue;
      }
      console.log(`Неизвестный выбор: ${choice}`);
    }
    if (choice === 'n' || choice === 'N') {
      console.log('⏹️  Останавливаемся: без этого коммита дальше по истории идти нельзя.');
      break;
    }
    console.log(`🚀 Пушим коммит ${shortSha(c)} в '${targetRemote}' как '${branchName}'...`);
    if (gitInherit(['push', targetRemote, `${c}:refs/heads/${branchName}`]) === 0) {
      console.log('✅ Коммит принят и запушен');
      pushed++;
    } else {
      console.log('❌ Ошибка пуша — останавливаемся.');
      break;
    }
  }
  console.log(`📊 Принято коммитов: ${pushed}/${total}`);
  console.log('-----------------------------------');
}

// ---------- main ----------
async function main() {
  let sourceRemote = '', interactive = false, all = false, uiMode = 'safe', skipReverse = false, maxDiff = null;
  let skipDiverged = false, listDiverged = false, pruneTrivial = false, pruneReverse = false;
  const usage = (code) => {
    console.log(`Использование: ${process.argv[1]} [-i] <source_remote>`);
    console.log(`Пример: ${process.argv[1]} -i chas-ege-ulyana`);
    console.log('Флаги можно ставить где угодно: и до, и после имени ремоута.');
    console.log('  -i, --interactive  Интерактивный режим (y/n/d/s/f для каждого silentpr)');
    console.log('  --all              Все ремоуты: пройти по всем silentpr во всех форках');
    console.log('  --skip-reverse     Не показывать silentpr, где target опережает source (--no-reverse — устаревший синоним)');
    console.log('  --skip-diverged    Не показывать silentpr, где ветки разошлись (diverged)');
    console.log('  --list-diverged    В конце вывести список diverged silentpr');
    console.log('  --prune-trivial    Автоматически удалять принятые целиком: голова silentpr == голова target');
    console.log('  --prune-reverse    Автоматически удалять принятые целиком: голова silentpr — предок головы target');
    console.log('  --max-diff-lines N Пропускать silentpr с диффом больше N строк (сумма + и −, бинарники не в счёт)');
    console.log('  --ui=top|safe|off  Строка состояния: top — панель вверху терминала;');
    console.log('                     safe (по умолчанию) — заголовок окна + строка перед каждым silentpr;');
    console.log('                     off — ничего не рисовать');
    console.log('  --no-ui            То же, что --ui=off');
    console.log('  -h, --help         Эта справка');
    process.exit(code);
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i' || a === '--interactive') interactive = true;
    else if (a === '-h' || a === '--help') usage(0);
    else if (a === '--all') all = true;
    else if (a === '--no-ui') uiMode = 'off';
    else if (a === '--skip-reverse' || a === '--no-reverse') skipReverse = true;
    else if (a === '--skip-diverged') skipDiverged = true;
    else if (a === '--list-diverged') listDiverged = true;
    else if (a === '--prune-trivial') pruneTrivial = true;
    else if (a === '--prune-reverse') pruneReverse = true;
    else if (a === '--max-diff-lines' || a.startsWith('--max-diff-lines=')) {
      const v = a.includes('=') ? a.slice('--max-diff-lines='.length) : argv[++i];
      if (!/^\d+$/.test(v || '') || parseInt(v, 10) <= 0) { console.log(`--max-diff-lines ждёт положительное целое, получено: ${v}`); usage(1); }
      maxDiff = parseInt(v, 10);
    }
    else if (a.startsWith('--ui=')) {
      const v = a.slice(5);
      if (!['top', 'safe', 'off'].includes(v)) { console.log(`Неизвестный режим UI: ${v} (top|safe|off)`); usage(1); }
      uiMode = v;
    }
    else if (a.startsWith('-')) { console.log(`Неизвестный флаг: ${a}`); usage(1); }
    else if (sourceRemote) { console.log(`Лишний аргумент: ${a} (ремоут уже задан: ${sourceRemote})`); usage(1); }
    else sourceRemote = a;
  }
  if (all && sourceRemote) { console.log('--all и имя ремоута вместе нельзя: выбери что-то одно.'); usage(1); }
  if (!all && !sourceRemote) usage(1);
  UI.mode = (process.stdout.isTTY && process.env.TERM !== 'dumb') ? uiMode : 'off';
  if (UI.mode === 'top') process.stdout.on('resize', () => {
    const rows = process.stdout.rows || 24;
    // DECSTBM ставит курсор в home (строка 1, ВНЕ области) — сохраняем и возвращаем курсор,
    // иначе следующая строка вывода git ляжет на панель и будет затёрта перерисовкой.
    process.stdout.write(`\x1b7\x1b[2;${rows}r\x1b8`);
    UI.draw();
  });

  const remotes = all ? (gitOut(['remote']) || '').split('\n').filter(Boolean) : [sourceRemote];
  const jobs = [];
  for (let i = 0; i < remotes.length; i++) {
    const r = remotes[i];
    console.log(`🔄 [${i + 1}/${remotes.length}] Подтягиваем свежие ветки из ${r}...`);
    gitInherit(['fetch', '--quiet', '--prune', r]);
    const refs = (gitOut(['for-each-ref', '--format=%(refname:short)', `refs/remotes/${r}/silentpr`]) || '')
      .split('\n').filter(Boolean);
    for (const ref of refs) jobs.push({ remote: r, ref });
  }
  UI.total = jobs.length;
  UI.init();
  console.log(`📋 Всего silentpr к разбору: ${jobs.length}`);
  const divergedRefs = [];
  for (const job of jobs) {
    const sourceRemote = job.remote, ref = job.ref;
    UI.index++; UI.current = ref; UI.draw();
    const parts = ref.split('/');
    if (parts.length < 4) continue;
    const targetRemote = parts[2];
    const branchName = parts.slice(3).join('/');
    const sourceSha = revparse(`refs/remotes/${ref}`);
    if (!sourceSha) continue;

    const st = targetState(targetRemote, branchName);

    const srcRef = `silentpr/${targetRemote}/${branchName}`;

    // Классификация по достоверному состоянию target: равенство / reverse / diverged.
    const equal = st.exists && sourceSha === st.sha;
    const isReverse = !equal && st.exists && st.certain && gitOk(['merge-base', '--is-ancestor', sourceSha, st.sha]);
    const isDiverged = st.exists && st.certain && !equal && !isReverse &&
      !gitOk(['merge-base', '--is-ancestor', st.sha, sourceSha]);
    if (isDiverged) divergedRefs.push(ref);

    // Автоочистка принятых целиком — раньше фильтров: --prune-reverse сильнее --skip-reverse.
    if (equal && pruneTrivial && st.certain) {
      if (pruneAccepted(sourceRemote, srcRef, sourceSha, 'Голова silentpr совпадает с target (принят целиком)')) UI.deleted++;
      else UI.failed++;
      UI.draw(); console.log('-----------------------------------'); continue;
    }
    if (isReverse && pruneReverse) {
      if (pruneAccepted(sourceRemote, srcRef, sourceSha, 'Target опережает source (всё принято)')) UI.deleted++;
      else UI.failed++;
      UI.draw(); console.log('-----------------------------------'); continue;
    }

    // Ветки совпадают — молча пропускаем в любом режиме
    if (equal) { UI.skipped++; UI.draw(); continue; }

    // Фильтры: скрытые не рисуются вообще, но видны счётчиком «скрыто».
    // Пара считается лениво: без фильтров и без -i лишние fetch не нужны.
    let pair = null;
    const getPair = () => (pair || (pair = displayPair(sourceSha, targetRemote, branchName, st)));
    if (skipReverse && isReverse) { UI.hidden++; UI.draw(); continue; }
    if (skipDiverged && isDiverged) { UI.hidden++; UI.draw(); continue; }
    if (maxDiff !== null) {
      const n = diffLines(getPair(), sourceSha);
      if (n !== null && n > maxDiff) { UI.hidden++; UI.draw(); continue; }
    }
    UI.banner();
    if (interactive) {
      // askAction может обновить st (действие f) — дальше работаем со свежим состоянием
      const { action, splitBase } = await askAction(ref, targetRemote, branchName, sourceSha, st, getPair());
      if (action === 'n') {
        console.log(`⏭️  Пропускаем ${ref}`); UI.skipped++; UI.draw();
        console.log('-----------------------------------');
        continue;
      }
      if (action === 'd') {
        if (st.exists) {
          console.log('🗑️  Force reset source к target...');
          if (gitQuiet(['push', '--force', sourceRemote, `${st.sha}:refs/heads/${srcRef}`, '--quiet']) === 0) {
            console.log('✅ Source сброшен к состоянию target'); UI.deleted++; UI.draw();
          } else
            console.log('❌ Ошибка force reset');
        } else {
          // Цель не существует: сбрасывать не к чему — сносим саму ветку source.
          // Перед необратимым действием сверяемся с сервером: локальный кэш мог соврать.
          console.log(`🗑️  Target не существует — сносим ветку source ${sourceRemote}/${srcRef}...`);
          const other = branchElsewhere(branchName, targetRemote);
          if (other.length) {
            console.log(`❌ Ветка '${branchName}' есть в других ремоутах: ${other.join(', ')}.`);
            console.log('   Удаление отменено: скорее всего, в имени silentpr указан не тот ремоут.');
            console.log(`   Перенести: git push ${sourceRemote} ${sourceSha}:refs/heads/silentpr/${other[0]}/${branchName}`);
            console.log(`   Затем:     git push ${sourceRemote} --delete refs/heads/${srcRef}`);
            console.log('-----------------------------------');
            continue;
          }
          const chk = lsRemoteBranch(targetRemote, branchName);
          if (!chk.ok) {
            console.log(`❌ Не могу проверить ${targetRemote}: ${chk.err.split('\n')[0]}`);
            console.log('   Удаление отменено (сначала f).');
          } else if (chk.sha) {
            console.log(`❌ Ветка '${branchName}' всё-таки есть в ${targetRemote} (${chk.sha.slice(0, 9)}).`);
            console.log('   Удаление отменено: нажми f, чтобы подтянуть её.');
          } else {
            console.log(`   Было: ${sourceSha}`);
            console.log(`   Вернуть, если передумаешь: git push ${sourceRemote} ${sourceSha}:refs/heads/${srcRef}`);
            if (gitInherit(['push', sourceRemote, '--delete', `refs/heads/${srcRef}`]) === 0) {
              gitQuiet(['update-ref', '-d', `refs/remotes/${sourceRemote}/${srcRef}`]);
              console.log('✅ Ветка source удалена'); UI.deleted++; UI.draw();
            } else {
              console.log('❌ Ошибка удаления ветки source');
            }
          }
        }
        console.log('-----------------------------------');
        continue;
      }
      if (action === 's') {
        await splitPush(splitBase, targetRemote, branchName, sourceSha);
        continue;
      }
      // action === 'y' — продолжаем с обычным пушем
    }

    if (st.exists && gitOk(['merge-base', '--is-ancestor', sourceSha, st.sha])) {
      console.log('🔄 Target опережает source, обновляем source...');
      gitQuiet(['push', sourceRemote, `${st.sha}:refs/heads/${srcRef}`, '--quiet']);
      console.log('✅ Source обновлён'); UI.pushed++; UI.draw();
      console.log('-----------------------------------');
      continue;
    }

    console.log(`🚀 Отправляем коммит ${sourceSha} в ремоут '${targetRemote}' как ветку '${branchName}'...`);
    // Пушим именно SHA коммита (обход GitHub cross-fork push protection)
    if (gitInherit(['push', targetRemote, `${sourceSha}:refs/heads/${branchName}`]) === 0)
      console.log('✅ Успешно запушено!');
    else
      console.log('❌ Ошибка пуша. Возможно, нет прав или ветка diverged.');
    if (gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/${targetRemote}/${branchName}`])) { UI.pushed++; } else { UI.failed++; }
    UI.draw();
    console.log('-----------------------------------');
  }
  rl.close();
  UI.done();
  console.log(`📊 Итого из ${UI.total}: запушено ${UI.pushed}, снесено ${UI.deleted}, пропущено ${UI.skipped}, скрыто ${UI.hidden}, ошибок ${UI.failed}`);
  if (listDiverged) {
    console.log(`🔀 Diverged: ${divergedRefs.length}`);
    for (const r of divergedRefs) console.log(`   ${r}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
