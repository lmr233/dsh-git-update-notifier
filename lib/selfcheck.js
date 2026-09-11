/**
 * 本插件"自己"的定位与远端版本查询。
 *
 * 插件一直在检测 dsh 本体，却检测不了自己 —— 这个模块补上这一半。难点在于**它自己是
 * 怎么被装进来的**：可能是 git 检出、可能是 profile 里声明的 `github:` 依赖、可能是
 * npm 依赖，也可能只是被手工复制进 `node_modules` 的一份副本。所以这里先判形态，
 * 再决定"去哪儿问最新版本"，并且**始终保留 GitHub 兜底** —— 最后那种形态除了 GitHub
 * 之外没有任何来源可问。
 *
 * 全是本地读取 + 两个只读网络查询，不修改任何东西。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getJson } from './registry.js'

/**
 * GitHub API 基址。
 *
 * 可用 `DSH_GIT_UPDATE_NOTIFIER_GITHUB_API` 指向镜像或本地 mock —— 测试就是靠它
 * 注入一个本地 http server，从而完全不联网地验证查询与回退逻辑。
 */
function githubApiBase() {
  const fromEnv = process.env.DSH_GIT_UPDATE_NOTIFIER_GITHUB_API
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim().replace(/\/+$/, '')
  return 'https://api.github.com'
}

/** 本插件的包名。远端查询与"在 profile 里怎么声明的"都以它为准。 */
export const SELF_PACKAGE = 'dsh-git-update-notifier'

/** 本插件的包目录（`lib/index.js` 的上一级）。 */
export function selfPackageDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function safeRealpath(target) {
  try {
    return realpathSync(target)
  } catch {
    return undefined
  }
}

/** 读本插件自己的 `package.json`；读不到返回 undefined。 */
export function readSelfManifest() {
  try {
    const parsed = JSON.parse(readFileSync(join(selfPackageDir(), 'package.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // 读不到就当作"无法判断自身来源"，由调用方降级。
  }
  return undefined
}

/** 从 `repository` 字段解析出 `owner/repo`。 */
export function selfRepo(manifest) {
  const repository = manifest?.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string') return undefined
  const matched = /github\.com[/:]([^/]+)\/([^/#]+)/i.exec(url)
  if (matched === null) return undefined
  return `${matched[1]}/${matched[2].replace(/\.git$/i, '')}`
}

/** `.git` 可能是目录，也可能是 worktree / submodule 里的一个文件。 */
function hasGitEntry(dir) {
  try {
    return statSync(join(dir, '.git')) !== undefined
  } catch {
    return false
  }
}

/** 从自己所在路径上溯找含 `.git` 的目录（说明这是 git 检出而不是解包安装）。 */
function findGitRootUp(start) {
  let current = safeRealpath(start) ?? start
  for (let depth = 0; depth < 12; depth += 1) {
    if (hasGitEntry(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * 本插件所在的 profile / 项目根。
 *
 * pnpm 会把包放进 `<root>/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>`，
 * 所以先在路径里找 `.pnpm`，再退回普通的 `node_modules`。
 */
export function selfProfileRoot() {
  const real = safeRealpath(selfPackageDir())
  if (real === undefined) return undefined
  const parts = real.split(sep)
  const pnpmIndex = parts.lastIndexOf('.pnpm')
  if (pnpmIndex > 0) return parts.slice(0, pnpmIndex - 1).join(sep)
  const modulesIndex = parts.lastIndexOf('node_modules')
  if (modulesIndex > 0) return parts.slice(0, modulesIndex).join(sep)
  return undefined
}

/** 读宿主清单里对本插件的声明（`dependencies` / `devDependencies`）。 */
export function selfDependencySpec(profileRoot, packageName = SELF_PACKAGE) {
  if (typeof profileRoot !== 'string' || profileRoot === '') return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const table = manifest?.[field]
      if (table !== null && typeof table === 'object' && typeof table[packageName] === 'string') {
        return table[packageName]
      }
    }
  } catch {
    // 没有清单 / 解析失败：调用方会把它当成"未声明"。
  }
  return undefined
}

/**
 * 判定本插件自己的安装形态。
 *
 * | kind | 判定依据 | 远端来源 |
 * |---|---|---|
 * | `checkout` | 自己的目录在一个含 `.git` 的仓库里 | git 上游 |
 * | `npm` | 宿主清单里声明为本包（semver / `^` / `~`） | npm registry |
 * | `github` | 宿主清单里声明为 `github:` / git URL | GitHub |
 * | `manual` | 目录在、但没有任何声明（例如手工复制的副本） | 只用 GitHub 兜底 |
 */
export function selfLayout() {
  const packageDir = selfPackageDir()
  const manifest = readSelfManifest()
  if (manifest === undefined) return { kind: 'unknown', packageDir, version: null }

  const name = typeof manifest.name === 'string' ? manifest.name : SELF_PACKAGE
  const version = typeof manifest.version === 'string' ? manifest.version : null

  const gitRoot = findGitRootUp(packageDir)
  if (gitRoot !== undefined) {
    return { kind: 'checkout', packageDir, gitRoot, name, version, profileRoot: null, spec: null }
  }

  const profileRoot = selfProfileRoot()
  const spec = selfDependencySpec(profileRoot, name)
  if (typeof spec === 'string' && spec !== '') {
    const isGit = /^(github:|git\+|git:|https?:\/\/github\.com)/i.test(spec.trim())
    return {
      kind: isGit ? 'github' : 'npm',
      packageDir,
      profileRoot: profileRoot ?? null,
      name,
      version,
      spec,
      gitRoot: null,
    }
  }

  return { kind: 'manual', packageDir, profileRoot: profileRoot ?? null, name, version, spec: null, gitRoot: null }
}

/** 去掉版本号 / tag 的前导 `v`。 */
function stripV(text) {
  const value = String(text ?? '').trim()
  return /^v/i.test(value) ? value.slice(1) : value
}

/** 直连优先、失败走代理的一次 JSON 请求。 */
async function tryJson(url, proxy) {
  const direct = await getJson(url, undefined)
  if (direct.ok) return { ok: true, value: direct.value, viaProxy: false }
  if (proxy === undefined) return { ok: false, error: direct.error, viaProxy: false }
  const proxied = await getJson(url, proxy)
  if (proxied.ok) return { ok: true, value: proxied.value, viaProxy: true }
  return {
    ok: false,
    error: `直连失败（${direct.error}）；经代理 ${proxy} 也失败（${proxied.error}）`,
    viaProxy: true,
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}T/

/**
 * 查 GitHub 上本插件的最新版本。
 *
 * 先看 **release**（作者显式发布的版本，语义最明确），再退回 **tags**（本仓库每个版本都打了
 * 标签，所以这一层同样可靠）。未认证的 API 有每小时 60 次的限额，而插件一天只查一次，
 * 完全够用。
 */
export async function fetchGithubLatest(repo, proxy) {
  if (typeof repo !== 'string' || repo === '') return { ok: false, error: '没有可用的仓库地址' }

  const release = await tryJson(`${githubApiBase()}/repos/${repo}/releases/latest`, proxy)
  const tagName = release.ok ? release.value?.tag_name : undefined
  if (typeof tagName === 'string' && tagName !== '') {
    return {
      ok: true,
      version: stripV(tagName),
      source: 'github-release',
      viaProxy: release.viaProxy,
      detail: typeof release.value?.published_at === 'string' && DATE_RE.test(release.value.published_at)
        ? `发布于 ${release.value.published_at.slice(0, 10)}`
        : null,
      url: typeof release.value?.html_url === 'string' ? release.value.html_url : null,
    }
  }

  // release 查不到（仓库没建 release，或 API 报错）再退到 tags。
  const tags = await tryJson(`${githubApiBase()}/repos/${repo}/tags`, proxy)
  const first = tags.ok && Array.isArray(tags.value) ? tags.value[0] : undefined
  if (first !== undefined && typeof first.name === 'string' && first.name !== '') {
    return {
      ok: true,
      version: stripV(first.name),
      source: 'github-tag',
      viaProxy: tags.viaProxy,
      detail: null,
      url: null,
    }
  }

  return {
    ok: false,
    error: release.ok ? (tags.error ?? '仓库上没有任何 release 或 tag') : release.error,
    viaProxy: release.viaProxy === true || tags.viaProxy === true,
  }
}
