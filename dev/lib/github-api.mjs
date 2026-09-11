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
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'chas-ege-provide-examples-all-prs',
            ...(token && { 'Authorization': `token ${token}` })
        }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.encoding === 'base64' && data.content) {
        return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return null;
}
