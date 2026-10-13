'use strict'

// Burg Focus: settings, storage and helpers shared by the popup, options page,
// block page and service worker.

const DEFAULT_SETTINGS = {
  mode: 'block', // 'block' = block list, 'allow' = only allowed sites
  blocklist: ['youtube.com/shorts', 'instagram.com/reels', 'tiktok.com', 'x.com', 'facebook.com', 'reddit.com'],
  allowlist: ['github.com', 'stackoverflow.com', 'developer.mozilla.org', 'developer.chrome.com'],
  workDomains: [], // always allowed, in both modes
  schedulesOn: false,
  schedules: [
    { days: [1, 2, 3, 4, 5], from: '09:00', to: '12:30' },
    { days: [1, 2, 3, 4, 5], from: '13:30', to: '17:00' }
  ],
  budgets: [], // [{ domain: 'youtube.com', minutes: 20 }]
  friction: 'wait', // 'none' | 'wait' | 'type'
  waitSeconds: 30,
  phrase: t('defaultPhrase'),
  graceMinutes: 5,
  sessionMinutes: 25,
  sessionLock: false,
  shortBreak: 5,
  longBreak: 15,
  longEvery: 4,
  autoNext: false,
  tracking: true,
  note: '',
  guardMode: 'off', // 'off' | 'mild' | 'streng' (strict) | 'gek' (crazy), see lib/guard.js
  guardSound: true,
  guardPenalty: false // penalty point = round lasts a few minutes longer
}

// Always allowed: local development environments.
const ALWAYS_ALLOWED = ['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.test', '*.local']

const STATS_DAYS = 90

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...(settings || {}) }
}

async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ settings })
  return settings
}

async function getSession() {
  const { session } = await chrome.storage.local.get('session')
  return session || null
}

// Date as 'YYYY-MM-DD' in local time.
function dayKey(date = new Date()) {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function hostOf(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain)
}

// Seconds → "1 h 05 min", "12 min", "45 s"
function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec))
  if (sec < 60) return t('durSec', sec)
  const min = Math.round(sec / 60)
  if (min < 60) return t('durMin', min)
  return t('durHourMin', Math.floor(min / 60), String(min % 60).padStart(2, '0'))
}

// "2 penalty points" / "1 penalty point": key + '1' holds the singular.
function plural(n, key) {
  return t(n === 1 ? key + '1' : key, n)
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString(t('lang'), { hour: '2-digit', minute: '2-digit' })
}

// Time left as "12:05" (mm:ss) or "1:02:05"
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k in node) node[k] = v
    else node.setAttribute(k, v)
  }
  for (const c of children) if (c != null) node.append(c)
  return node
}

function send(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data })
}
