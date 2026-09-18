#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execSync } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';
import { getFileContent, fetchSymlinkPaths, projectRoot } from './lib/github-api.mjs';

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// projectRoot is imported from ./lib/github-api.mjs

const args = process.argv.slice(2);
const editLastFlag = args.includes('--edit-last');
const filteredArgs = args.filter(a => a !== '--edit-last');

const owner = 'nickkolok';
const repo = 'chas-ege';

async function getGitHubToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try {
        const { stdout } = await execFileAsync('gh', ['auth', 'token']);
        return stdout.trim();
    } catch (e) {
        console.error('No GitHub token found.');
        process.exit(1);
    }
}


async function getRateLimit(token) {
    try {
        const response = await fetch('https://api.github.com/rate_limit', {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.resources.core;
    } catch (e) {
        return null;
    }
}

async function fetchAllOpenPRs(token) {
    let allPRs = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`;

    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const data = await response.json();
        allPRs = allPRs.concat(data);

        const linkHeader = response.headers.get('link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        } else {
            url = null;
        }
    }
    return allPRs;
}

async function fetchAllPRFiles(prNum, token) {
    let allFiles = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/files?per_page=100`;

    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const data = await response.json();
        allFiles = allFiles.concat(data);

        const linkHeader = response.headers.get('link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        } else {
            url = null;
        }
    }
    return allFiles;
}

async function fetchPRComments(prNum, token) {
    let comments = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNum}/comments?per_page=100`;
    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const data = await response.json();
        comments = comments.concat(data);
        const linkHeader = response.headers.get('link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        } else {
            url = null;
        }
    }
    
    url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/comments?per_page=100`;
    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const data = await response.json();
        comments = comments.concat(data);
        const linkHeader = response.headers.get('link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        } else {
            url = null;
        }
    }
    return comments;
}

async function fetchPRReviewComments(prNum, token) {
    let reviewComments = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/comments?per_page=100`;
    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (!response.ok) return [];
        const data = await response.json();
        reviewComments = reviewComments.concat(data);
        const linkHeader = response.headers.get('link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        } else {
            url = null;
        }
    }
    return reviewComments;
}

async function isLastCommentInPR(issueComments, reviewComments, targetCommentId) {
    const allComments = [...issueComments, ...reviewComments];
    allComments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (allComments.length === 0) return false;
    return allComments[allComments.length - 1].id === targetCommentId;
}

async function checkDevelCommits() {
    try {
        // Проверяем коммиты за последние 2 часа локально через git (без API-запросов)
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const since = twoHoursAgo.toISOString();
        
        const { stdout } = await execFileAsync('git', [
            'log',
            '--name-only',
            '--pretty=format:',
            `--since=${since}`,
            'devel'
        ], { cwd: projectRoot });
        
        const files = stdout.trim().split('\n').filter(f => f.trim().length > 0);
        const hasNonZdnMdDoc = files.some(file => {
            const p = file.trim();
            return !p.startsWith('zdn/') && !p.startsWith('md/') && !p.startsWith('doc/');
        });
        
        return hasNonZdnMdDoc;
    } catch (e) {
        console.warn('Failed to check devel commits locally:', e.message);
        return false;
    }
}

async function runProvideScript(prNum, extraArgs) {
    const scriptPath = path.join(projectRoot, 'dev', 'provide_examples_to_PR.mjs');
    const scriptArgs = [scriptPath, prNum.toString(), ...extraArgs];
    const runStart = Date.now();
    try {
        const { stdout, stderr } = await execFileAsync('node', scriptArgs, { maxBuffer: 1024 * 1024 * 50 });
        if (stderr) console.warn(`stderr from provide_examples_to_PR.mjs:\n${stderr}`);
        if (stdout) console.log(stdout);
    } catch (error) {
        console.error(`provide_examples_to_PR.mjs failed for PR ${prNum}:`);
        if (error.stderr) console.error(`stderr: ${error.stderr}`);
        if (error.stdout) console.log(error.stdout);
    }
    const elapsed = Date.now() - runStart;
    console.log(`⏱️  Время генерации для PR #${prNum}: ${(elapsed / 1000).toFixed(2)} с`);
    return elapsed;
}




async function main() {
    const scriptStartTime = Date.now();
    let totalGenerationTime = 0;

    console.log('Starting script to process all PRs...');
    const token = await getGitHubToken();
    if (!token) {
        console.error('No GitHub token found.');
        process.exit(1);
    }

    const startRateLimit = await getRateLimit(token);
    if (startRateLimit) {
        console.log(`🚦 Rate limit at start: ${startRateLimit.remaining} / ${startRateLimit.limit} (сброс в ${new Date(startRateLimit.reset * 1000).toLocaleString()})`);
    } else {
        console.warn('🚦 Не удалось получить rate limit на старте.');
    }

    // Создаём уникальную временную директорию для профилей Chromium на весь прогон
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskexamples-'));
    console.log(`Created temporary user data directory: ${userDataDir}`);

    let fatalError = null;
    try {
        const recentDevelCommits = await checkDevelCommits();
        console.log(`Recent non-zdn/md/doc devel commits: ${recentDevelCommits}`);

        let prs = await fetchAllOpenPRs(token);
        if (recentDevelCommits) {
            prs.sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));
        } else {
            prs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
        }


        let currentGitStatus = 'unknown';
        try {
            const gitStatusPath = path.join(projectRoot, 'dist', 'gitstatus.txt');
            const gitStatusContent = fs.readFileSync(gitStatusPath, 'utf8');
            currentGitStatus = gitStatusContent.split('\n')[0].trim();
        } catch (e) {
            console.warn('Could not read dist/gitstatus.txt:', e.message);
        }

        const cacheFilePath = path.join(projectRoot, '.examples-generated.cache');
        let cache = new Set();
        if (fs.existsSync(cacheFilePath)) {
            const content = fs.readFileSync(cacheFilePath, 'utf8');
            cache = new Set(content.split('\n').filter(Boolean));
            console.log(`Loaded ${cache.size} entries from cache.`);
        }

        // Фетчим только открытые PR, чтобы не тянуть тысячи закрытых
        console.log(`🚀 Fetching ${prs.length} open PR refs from upstream...`);
        const refspecs = prs.map(pr => `+refs/pull/${pr.number}/head:refs/remotes/upstream/pr/${pr.number}`);
        for (let i = 0; i < refspecs.length; i += 100) {
            const batch = refspecs.slice(i, i + 100);
            try {
                execSync(`git fetch upstream ${batch.join(' ')}`, { stdio: 'inherit', timeout: 120000 });
            } catch (e) {
                console.warn(`Fetch batch failed: ${e.message}`);
            }
        }


        for (const pr of prs) {
            if (currentGitStatus === 'unknown') {
                console.log(`⚠️ Current git status is unknown. Skipping PR #${pr.number} to avoid infinite regeneration.`);
                continue;
            }

            const prHeadSha = pr.head.sha;
            const cacheKey = `${prHeadSha}:${currentGitStatus}`;

            if (cache.has(cacheKey)) {
                console.log(`🎉 PR #${pr.number} уже проверен для текущих хэшей (pr=${prHeadSha.slice(0,7)}, devel=${currentGitStatus.slice(0,7)}). Пропускаем!`);
                continue;
            }

            console.log(`\n--- Checking PR #${pr.number} ---`);
            try {
                const files = await fetchAllPRFiles(pr.number, token);
                
                let validFiles = files.filter(f => {
                    if (f.status === 'removed' || f.status === 'renamed') return false;
                    if (f.filename.startsWith('md/') || f.filename.startsWith('doc/')) return false;
                    if (/^zdn\/[^\/]+\/[^\/]+\/(main|fipi)\.js$/.test(f.filename)) return false;
                    if (/^zdn\/[^\/]+\/[^\/]+\.js$/.test(f.filename)) return false;
                    return /^zdn\/[^\/]+\/[^\/]+\/[^\/]+\.js$/.test(f.filename);
                });
                
                const symlinkPaths = await fetchSymlinkPaths(owner, repo, pr.head.sha, validFiles.map(f => f.filename), token);
                if (symlinkPaths.size > 0) {
                    console.log(`Excluding symlinks from file count: ${[...symlinkPaths].join(', ')}`);
                }
                validFiles = validFiles.filter(f => !symlinkPaths.has(f.filename));

                if (validFiles.length < 1 || validFiles.length > 4) {
                    console.log(`PR #${pr.number} has ${validFiles.length} valid zdn/*/*/*.js files. Skipping.`);
                    cache.add(cacheKey);
                    fs.appendFileSync(cacheFilePath, cacheKey + '\n');
                    cache.add(cacheKey);
                    fs.appendFileSync(cacheFilePath, cacheKey + '\n');
                    continue;
                }

                const comments = await fetchPRComments(pr.number, token);
                const exampleComments = comments.filter(c => c.body.includes('ПРИМЕРЫ_ЗАДАЧ'));

                if (exampleComments.length === 0) {
                    console.log(`PR #${pr.number} has no ПРИМЕРЫ_ЗАДАЧ comment. Generating examples.`);
                    totalGenerationTime += await runProvideScript(pr.number, [...filteredArgs, '--user-data-dir', userDataDir]);
                    cache.add(cacheKey);
                    fs.appendFileSync(cacheFilePath, cacheKey + '\n');
                    continue;
                }

                const lastComment = exampleComments[exampleComments.length - 1];
                const commentBody = lastComment.body;
                const match = commentBody.match(/ПРИМЕРЫ_ЗАДАЧ\s+([^\s]+)\s+([0-9a-f]+)\s+сборка\s+([0-9a-f]+)/);
                if (!match) {
                    console.log(`Could not parse ПРИМЕРЫ_ЗАДАЧ comment in PR #${pr.number}. Generating.`);
                    totalGenerationTime += await runProvideScript(pr.number, [...filteredArgs, '--user-data-dir', userDataDir]);
                    continue;
                }

                let commentedFile = match[1].replace(/^`|`$/g, '');
                const commitHash = match[2];
                const buildCommit = match[3];

                if (buildCommit !== currentGitStatus) {
                    const compareUrl = `https://api.github.com/repos/${owner}/${repo}/compare/${buildCommit}...${currentGitStatus}`;
                    const compareResp = await fetch(compareUrl, {
                        headers: {
                            'Accept': 'application/vnd.github.v3+json',
                            'User-Agent': 'chas-ege-provide-examples-all-prs',
                            'Authorization': `token ${token}`
                        }
                    });
                    if (compareResp.ok) {
                        const compareData = await compareResp.json();
                        const diffFiles = compareData.files || [];
                        const hasNonZdnMdDoc = diffFiles.some(f => !f.filename.startsWith('zdn/') && !f.filename.startsWith('md/') && !f.filename.startsWith('doc/'));
                        if (hasNonZdnMdDoc) {
                            console.log(`Build commit differs from current not only by zdn/md/doc. Generating.`);
                            
                            // Check if we should edit last comment
                            let shouldEditLast = false;
                            if (editLastFlag && validFiles.length === 1) {
                                const reviewComments = await fetchPRReviewComments(pr.number, token);
                                shouldEditLast = await isLastCommentInPR(comments, reviewComments, lastComment.id);
                            }
                            
                            if (shouldEditLast) {
                                console.log(`Editing last comment for PR #${pr.number}`);
                                totalGenerationTime += await runProvideScript(pr.number, [...filteredArgs, '--user-data-dir', userDataDir, '--edit-last']);
                            } else {
                                totalGenerationTime += await runProvideScript(pr.number, [...filteredArgs, '--user-data-dir', userDataDir]);
                            }
                            cache.add(cacheKey);
                            fs.appendFileSync(cacheFilePath, cacheKey + '\n');
                            continue;
                        }
                    } else {
                        const errorText = await compareResp.text();
                        console.log(`Failed to compare commits. Status: ${compareResp.status} ${compareResp.statusText}. Response: ${errorText.substring(0, 500)}`);
                        console.log(`Debug: buildCommit=${buildCommit}, currentGitStatus=${currentGitStatus}`);
                        totalGenerationTime += await runProvideScript(pr.number, [...filteredArgs, '--user-data-dir', userDataDir]);
                        cache.add(cacheKey);
                        fs.appendFileSync(cacheFilePath, cacheKey + '\n');
                        continue;
                    }
                }

                console.log(`[DEBUG] PR #${pr.number}: commentedFile=${commentedFile}`);
                console.log(`[DEBUG] PR #${pr.number}: pr.head.sha=${pr.head.sha}`);
                console.log(`[DEBUG] PR #${pr.number}: commitHash=${commitHash}`);

                let filesDiffer = false;
                try {
                    console.log(`[DEBUG] PR #${pr.number}: Running git diff ${commitHash} ${pr.head.sha} -- ${commentedFile}`);
                    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', commitHash, pr.head.sha, '--', commentedFile], { cwd: projectRoot });
                    if (stdout.trim() !== '') {
                        filesDiffer = true;
                        console.log(`[DEBUG] PR #${pr.number}: git diff found differences.`);
                    } else {
                        console.log(`[DEBUG] PR #${pr.number}: git diff output is empty, files are identical.`);
                    }
                } catch (gitError) {
                    console.warn(`[DEBUG] PR #${pr.number}: git diff failed: ${gitError.message}. Falling back to content comparison.`);
                    // Фоллбэк на старый метод
                    const currentFileContent = await getFileContent(owner, repo, commentedFile, pr.head.sha, token);
                    const oldFileContent = await getFileContent(owner, repo, commentedFile, commitHash, token);
                    console.log(`[DEBUG] PR #${pr.number}: currentFileContent length=${currentFileContent ? currentFileContent.length : 'null'}`);
                    console.log(`[DEBUG] PR #${pr.number}: oldFileContent length=${oldFileContent ? oldFileContent.length : 'null'}`);

                    if (currentFileContent !== oldFileContent) {
                        filesDiffer = true;
                    }
                }

                if (filesDiffer) {
                    console.log(`File ${commentedFile} differs. Generating.`);
                    totalGenerationTime += await runProvideScript(pr.number, [...filteredArgs, '--user-data-dir', userDataDir]);
                } else {
                    console.log(`File ${commentedFile} is identical. Skipping.`);
                }
                cache.add(cacheKey);
                fs.appendFileSync(cacheFilePath, cacheKey + '\n');

            } catch (e) {
                console.error(`Error processing PR #${pr.number}:`, e.message);
            }
        }
    } catch (e) {
        fatalError = e;
    } finally {
        const endRateLimit = await getRateLimit(token);
        if (endRateLimit) {
            console.log(`🚦 Rate limit at end: ${endRateLimit.remaining} / ${endRateLimit.limit} (сброс в ${new Date(endRateLimit.reset * 1000).toLocaleString()})`);
        } else {
            console.warn('🚦 Не удалось получить rate limit в конце.');
        }

        // Удаляем временную директорию в конце
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
            console.log('Cleaned up temporary directory.');
        } catch (e) {
            console.warn(`Failed to clean up temporary directory: ${e.message}`);
        }
    }

    const totalScriptTime = Date.now() - scriptStartTime;
    console.log('\n==========================================');
    console.log(`⏱️  Суммарное время генерации задач: ${(totalGenerationTime / 1000).toFixed(2)} с`);
    console.log(`⏱️  Полное время работы скрипта:       ${(totalScriptTime / 1000).toFixed(2)} с`);
    console.log(`⏱️  Разница (API и прочие накладные):  ${((totalScriptTime - totalGenerationTime) / 1000).toFixed(2)} с`);
    console.log('==========================================');
    
    if (fatalError) {
        console.error('Fatal error in main:', fatalError.message);
        process.exit(1);
    }
}

main();
