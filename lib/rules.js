'use strict'

// Burg Focus: what gets blocked.
//
// One source of truth for two places:
// - decide(url, ctx): in JS, for tabs that are already open and for sites that
//   change pages without a real navigation (YouTube, Instagram);
// - buildDnrRules(ctx): dynamic declarativeNetRequest rules that redirect a
//   navigation to the block page, with the original URL after the hash.

// "https://www.YouTube.com/shorts/" → { host: 'youtube.com', path: '/shorts' }
function parseEntry(text) {
  let s = String(text || '').trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '')
  const slash = s.search(/[/?#]/)
  const host = (slash < 0 ? s : s.slice(0, slash)).replace(/:\d+$/, '').replace(/\.$/, '')
  let path = slash < 0 ? '' : s.slice(slash)
  path = path.replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) && host !== 'localhost') return null
  return { host, path }
}

function entryText(e) {
  return e.host + e.path
}

function normalizeList(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const e = parseEntry(item)
    if (!e) continue
    const t = entryText(e)
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

function entryMatches(url, e) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.replace(/^www\./, '').toLowerCase()
  if (!hostMatches(host, e.host)) return false
  if (!e.path) return true
  const p = u.pathname.toLowerCase()
  return p === e.path || p.startsWith(e.path + '/')
}

function isAlwaysAllowed(url) {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) || /\.(localhost|test|local)$/.test(hostname)
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

// All schedule windows (start/end in ms) that touch the coming days.
function scheduleWindows(schedules, now = Date.now(), daysAhead = 8) {
  const out = []
  const base = new Date(now)
  base.setHours(0, 0, 0, 0)
  for (let offset = -1; offset <= daysAhead; offset++) {
    const day = new Date(base)
    day.setDate(base.getDate() + offset)
    for (const s of schedules) {
      if (!s.days?.includes(day.getDay())) continue
      const from = minutesOf(s.from)
      let to = minutesOf(s.to)
      if (to <= from) to += 24 * 60 // past midnight
      const start = new Date(day)
      start.setMinutes(from)
      const end = new Date(day)
      end.setMinutes(to)
      out.push({ start: start.getTime(), end: end.getTime() })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// End time of the schedule window we are in now (adjacent windows
// merged), or 0.
function scheduleActiveUntil(schedules, now = Date.now()) {
  let until = 0
  for (const w of scheduleWindows(schedules, now)) {
    if (w.start <= (until || now) && w.end > now) until = Math.max(until, w.end)
  }
  return until
}

function nextScheduleBoundary(schedules, now = Date.now()) {
  let next = 0
  for (const w of scheduleWindows(schedules, now)) {
    for (const t of [w.start, w.end]) if (t > now && (!next || t < next)) next = t
  }
  return next
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

// ctx = {
//   focus: null | { reason: 'session' | 'schedule', until },
//   mode, block: [entry], allow: [entry], work: [entry],
//   budgetBlocked: [domain], exceptions: [host]
// }
function decide(url, ctx) {
  const host = hostOf(url)
  if (!host) return null
  if (ctx.exceptions.some((h) => hostMatches(host, h))) return null
  const budget = ctx.budgetBlocked.find((d) => hostMatches(host, d))
  if (budget) return { reason: 'budget', domain: budget }
  if (!ctx.focus) return null
  if (isAlwaysAllowed(url) || ctx.work.some((e) => entryMatches(url, e))) return null
  if (ctx.mode === 'allow') {
    return ctx.allow.some((e) => entryMatches(url, e)) ? null : { reason: ctx.focus.reason }
  }
  return ctx.block.some((e) => entryMatches(url, e)) ? { reason: ctx.focus.reason } : null
}

// ---------------------------------------------------------------------------
// declarativeNetRequest
// ---------------------------------------------------------------------------

const PRIO_EXCEPTION = 40
const PRIO_BUDGET = 30
const PRIO_ALLOW = 20
const PRIO_BLOCK = 10

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function entryRegex(e) {
  return `^https?://([^/?#]*\\.)?${escapeRe(e.host)}(:[0-9]+)?${escapeRe(e.path)}([/?#].*)?$`
}

function buildDnrRules(ctx, blockPageUrl) {
  const rules = []
  const redirect = { type: 'redirect', redirect: { regexSubstitution: blockPageUrl + '#\\0' } }
  const add = (priority, action, condition) =>
    rules.push({ id: rules.length + 1, priority, action, condition: { resourceTypes: ['main_frame'], ...condition } })

  if (ctx.exceptions.length) add(PRIO_EXCEPTION, { type: 'allow' }, { requestDomains: ctx.exceptions })

  for (const d of ctx.budgetBlocked) add(PRIO_BUDGET, redirect, { regexFilter: entryRegex({ host: d, path: '' }) })

  if (ctx.focus) {
    add(PRIO_ALLOW, { type: 'allow' }, {
      regexFilter: '^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]|[^/?#]*\\.(localhost|test|local))(:[0-9]+)?([/?#].*)?$'
    })
    for (const e of ctx.work) add(PRIO_ALLOW, { type: 'allow' }, { regexFilter: entryRegex(e) })
    if (ctx.mode === 'allow') {
      for (const e of ctx.allow) add(PRIO_ALLOW, { type: 'allow' }, { regexFilter: entryRegex(e) })
      add(PRIO_BLOCK, redirect, { regexFilter: '^https?://.*$' })
    } else {
      for (const e of ctx.block) add(PRIO_BLOCK, redirect, { regexFilter: entryRegex(e) })
    }
  }
  return rules
}
