import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

/**
 * Получает токен GitHub из переменной окружения или через `gh auth token`.
 * @returns {Promise<string|null>} Токен GitHub или null, если не удалось получить.
 */
export async function getGitHubToken() {
    if (process.env.GITHUB_TOKEN) {
        return process.env.GITHUB_TOKEN;
    }
    try {
        const { stdout } = await execFileAsync('gh', ['auth', 'token']);
        return stdout.trim();
    } catch (e) {
        console.warn('Could not get token via `gh auth token` or GITHUB_TOKEN.');
        return null;
    }
}

/**
 * Получает ID репозитория GitHub.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {string} token - Токен GitHub.
 * @returns {Promise<number|null>} ID репозитория или null при ошибке.
 */
export async function getRepositoryId(owner, repo, token) {
    try {
        const repoInfoUrl = `https://api.github.com/repos/${owner}/${repo}`;
        const repoInfoResp = await fetch(repoInfoUrl, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-ci-scripts',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        if (repoInfoResp.ok) {
            return (await repoInfoResp.json()).id;
        }
    } catch (e) {
        console.warn('Failed to fetch repository ID:', e.message);
    }
    return null;
}

/**
 * Получает все файлы из pull request с автоматической обработкой пагинации.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {number} prNum - Номер pull request.
 * @param {string} token - Токен GitHub.
 * @returns {Promise<Array>} Массив файлов PR.
 */
export async function fetchAllPRFiles(owner, repo, prNum, token) {
    let allFiles = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/files?per_page=100`;

    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-ci-scripts',
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

/**
 * Получает SHA последнего коммита в pull request.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {number} prNum - Номер pull request.
 * @param {string} token - Токен GitHub.
 * @returns {Promise<string>} SHA коммита или 'unknown' при ошибке.
 */
export async function getPRHeadSha(owner, repo, prNum, token) {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`, {
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'chas-ege-ci-scripts',
            ...(token && { 'Authorization': `token ${token}` })
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.head.sha;
}

/**
 * Находит ID последнего комментария с указанным маркером.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {number} prNum - Номер pull request.
 * @param {string} token - Токен GitHub.
 * @param {string} marker - Маркер для поиска в тексте комментария.
 * @returns {Promise<number|null>} ID комментария или null, если не найден.
 */
export async function findLastCommentId(owner, repo, prNum, token, marker) {
    let comments = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNum}/comments?per_page=100`;
    while (url) {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'chas-ege-ci-scripts',
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
    const markerComments = comments.filter(c => c.body.includes(marker));
    if (markerComments.length === 0) return null;
    return markerComments[markerComments.length - 1].id;
}

/**
 * Редактирует существующий комментарий.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {number} commentId - ID комментария.
 * @param {string} body - Новое содержимое комментария.
 * @param {string} token - Токен GitHub.
 * @returns {Promise<Object>} Обновлённый комментарий.
 */
export async function editComment(owner, repo, commentId, body, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;
    const response = await fetch(url, {
        method: 'PATCH',
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'chas-ege-ci-scripts',
            'Authorization': `token ${token}`
        },
        body: JSON.stringify({ body })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
}

/**
 * Создаёт новый комментарий в issue/PR.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {number} prNum - Номер pull request (issue number).
 * @param {string} body - Содержимое комментария.
 * @param {string} token - Токен GitHub.
 * @returns {Promise<Object>} Созданный комментарий.
 */
export async function postComment(owner, repo, prNum, body, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNum}/comments`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'chas-ege-ci-scripts',
            'Authorization': `token ${token}`
        },
        body: JSON.stringify({ body })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
}

export async function getFileContent(owner, repo, filePath, ref, token) {
    console.log(`[DEBUG getFileContent] owner=${owner}, repo=${repo}, filePath=${filePath}, ref=${ref}`);
    // 1. Локально через git (если коммит/ветка есть в локальном репозитории)
    try {
        const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`]);
        console.log(`[DEBUG getFileContent] git show succeeded, length=${stdout.length}`);
        return stdout;
    } catch (e) {
        console.log(`[DEBUG getFileContent] git show failed: ${e.message}`);
        // Локально не получилось, пробуем следующий вариант
    }

    // 2. Fetch raw URL (не тратит API rate limit)
    try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
        console.log(`[DEBUG getFileContent] Fetching rawUrl: ${rawUrl}`);
        const response = await fetch(rawUrl, {
            headers: {
                'User-Agent': 'chas-ege-provide-examples-all-prs',
                ...(token && { 'Authorization': `token ${token}` })
            }
        });
        console.log(`[DEBUG getFileContent] rawUrl response status: ${response.status}`);
        if (response.ok) {
            const text = await response.text();
            console.log(`[DEBUG getFileContent] rawUrl succeeded, length=${text.length}`);
            return text;
        }
    } catch (e) {
        console.log(`[DEBUG getFileContent] rawUrl fetch exception: ${e.message}`);
        // Raw fetch не удался, пробуем API
    }

    // 3. GitHub API (тратит API rate limit, используем только в крайнем случае)
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
    console.log(`[DEBUG getFileContent] Fetching API url: ${url}`);
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'chas-ege-provide-examples-all-prs',
            ...(token && { 'Authorization': `token ${token}` })
        }
    });
    console.log(`[DEBUG getFileContent] API response status: ${response.status}`);
    if (!response.ok) {
        console.log(`[DEBUG getFileContent] API failed, returning null`);
        return null;
    }
    const data = await response.json();
    if (data.encoding === 'base64' && data.content) {
        const text = Buffer.from(data.content, 'base64').toString('utf8');
        console.log(`[DEBUG getFileContent] API succeeded, length=${text.length}`);
        return text;
    }
    console.log(`[DEBUG getFileContent] API data invalid, returning null`);
    return null;
}


/**
 * Определяет симлинки среди указанных путей, используя локальный git или GitHub API.
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {string} sha - SHA коммита для проверки.
 * @param {Array<string>} candidatePaths - Пути файлов для проверки на симлинковость.
 * @param {string} [token] - Токен GitHub (опционально, если не передан - пытается получить автоматически).
 * @returns {Promise<Set<string>>} Set путей файлов, которые являются симлинками.
 */
export async function fetchSymlinkPaths(owner, repo, sha, candidatePaths, token = null) {
    const symlinks = new Set();
    const candidates = new Set(candidatePaths);
    
    // Try local git first to save API requests
    try {
        // First try ls-tree directly (in case sha is already fetched)
        try {
            const { stdout } = await execFileAsync('git', ['ls-tree', '-r', sha], { cwd: projectRoot });
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                const parts = line.split(/\s+/);
                if (parts.length >= 4) {
                    const mode = parts[0];
                    const filePath = parts[3];
                    if (mode === '120000' && candidates.has(filePath)) {
                        symlinks.add(filePath);
                    }
                }
            }
            console.log(`[symlink-detect] Used local git (sha already present), found ${symlinks.size} symlinks`);
            return symlinks;
        } catch (e) {
            console.log(`[symlink-detect] sha ${sha} not found locally, attempting fetch...`);
        }
        
        // Fetch the commit
        await execFileAsync('git', ['fetch', 'origin'], { cwd: projectRoot, timeout: 30000 });
        
        // Now try ls-tree again
        const { stdout } = await execFileAsync('git', ['ls-tree', '-r', sha], { cwd: projectRoot });
        const lines = stdout.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                const mode = parts[0];
                const filePath = parts[3];
                if (mode === '120000' && candidates.has(filePath)) {
                    symlinks.add(filePath);
                }
            }
        }
        console.log(`[symlink-detect] Used local git (after fetch), found ${symlinks.size} symlinks`);
        return symlinks;
    } catch (e) {
        console.warn(`[symlink-detect] Local git failed (${e.message}), falling back to API`);
    }
    
    // Fallback to API
    let apiToken = token;
    if (!apiToken) {
        apiToken = await getGitHubToken();
    }
    if (!apiToken) {
        console.warn('[symlink-detect] No GitHub token available, cannot fallback to API');
        return symlinks;
    }
    
    const apiHeaders = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'chas-ege-ci-scripts',
        'Authorization': `token ${apiToken}`
    };
    try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, { headers: apiHeaders });
        if (!resp.ok) {
            console.warn(`[symlink-detect] Trees API responded ${resp.status}, not excluding anything`);
            return symlinks;
        }
        const data = await resp.json();
        if (data.truncated) {
            console.warn('[symlink-detect] Recursive tree truncated, falling back to per-directory walk');
            return await fetchSymlinkPathsPerDir(owner, repo, sha, candidatePaths, apiToken);
        }
        for (const entry of data.tree || []) {
            if (entry.mode === '120000' && candidates.has(entry.path)) {
                symlinks.add(entry.path);
            }
        }
        console.log(`[symlink-detect] Used API, found ${symlinks.size} symlinks`);
    } catch (e) {
        console.warn('[symlink-detect] API error:', e.message);
    }
    return symlinks;
}

/**
 * Вспомогательная функция для определения симлинков по директориям (fallback при truncated tree).
 * @param {string} owner - Владелец репозитория.
 * @param {string} repo - Название репозитория.
 * @param {string} sha - SHA коммита.
 * @param {Array<string>} candidatePaths - Пути файлов для проверки.
 * @param {string} token - Токен GitHub.
 * @returns {Promise<Set<string>>} Set путей симлинков.
 */
async function fetchSymlinkPathsPerDir(owner, repo, sha, candidatePaths, token) {
    const symlinks = new Set();
    const candidatesSet = new Set(candidatePaths);
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'chas-ege-ci-scripts',
        'Authorization': `token ${token}`
    };
    
    const dirs = new Set();
    for (const p of candidatePaths) {
        const dir = p.substring(0, p.lastIndexOf('/'));
        if (dir) dirs.add(dir);
    }
    
    for (const dir of dirs) {
        try {
            const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}:${dir}`, { headers });
            if (!resp.ok) continue;
            const data = await resp.json();
            for (const entry of data.tree || []) {
                const fullPath = `${dir}/${entry.path}`;
                if (entry.mode === '120000' && candidatesSet.has(fullPath)) {
                    symlinks.add(fullPath);
                }
            }
        } catch (e) {
            console.warn(`[symlink-detect] fetchSymlinkPathsPerDir error for ${dir}:`, e.message);
        }
    }
    return symlinks;
}

