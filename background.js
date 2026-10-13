'use strict'

// Burg Focus: service worker
//
// Everything runs through refresh(): add measured time, update the session
// phase, decide whether focus is on (session or schedule) and which budgets are
// used up, build the declarativeNetRequest rules from that, check open tabs,
// set the badge and set one alarm for the next moment something changes.
// During a focus round, Warden Gerrit (guardCheck) checks whether you are still at it.
// On top of that, an alarm ticks every 30 seconds for time tracking and the badge.

importScripts('lib/i18n.js', 'lib/store.js', 'lib/rules.js', 'lib/guard.js')

const BLOCK_PAGE = chrome.runtime.getURL('blocked/blocked.html')
const MAX_SEGMENT_MS = 90 * 1000 // safety net in case a tick was missed
const IDLE_SECONDS = 60

let ctxCache = null

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

async function getStats() {
  const { stats } = await chrome.storage.local.get('stats')
  return stats || {}
}

function pruneStats(stats) {
  const cutoff = dayKey(Date.now() - STATS_DAYS * 86400000)
  for (const day of Object.keys(stats)) if (day < cutoff) delete stats[day]
}

function dayStats(stats, day = dayKey()) {
  return (stats[day] ||= { time: {}, blocks: {} })
}

function usedToday(stats, domain) {
  const time = stats[dayKey()]?.time || {}
  let sec = 0
  for (const [host, s] of Object.entries(time)) if (hostMatches(host, domain)) sec += s
  return sec
}

// ---------------------------------------------------------------------------
// Time tracking: the active tab in the focused window, and you are not idle
// (unless the tab is playing sound: watching a video counts too).
// ---------------------------------------------------------------------------

async function currentTarget() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    if (!win?.focused) return null
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
    const host = hostOf(tab?.url || '')
    if (!host) return null
    const idle = await chrome.idle.queryState(IDLE_SECONDS)
    if (idle !== 'active' && !tab.audible) return null
    return { host, url: tab.url, tabId: tab.id }
  } catch {
    return null
  }
}

async function track(settings, stats) {
  const now = Date.now()
  const { seg } = await chrome.storage.session.get('seg')
  let changed = false
  if (seg) {
    const tracked = settings.tracking || settings.budgets.some((b) => hostMatches(seg.host, b.domain))
    const sec = Math.min(now - seg.start, MAX_SEGMENT_MS) / 1000
    if (tracked && sec > 0) {
      const time = dayStats(stats).time
      time[seg.host] = Math.round(((time[seg.host] || 0) + sec) * 10) / 10
      changed = true
    }
  }
  const target = await currentTarget()
  await chrome.storage.session.set({ seg: target ? { ...target, start: now } : null })
  return { changed, target }
}

// ---------------------------------------------------------------------------
// Sessions (Pomodoro)
// ---------------------------------------------------------------------------

function notify(id, title, message, buttons) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'images/icon_128.png',
    title,
    message,
    buttons,
    priority: 2,
    requireInteraction: !!buttons
  })
}

function focusRound(settings, round, minutes, lock, note) {
  const now = Date.now()
  return { phase: 'focus', round, minutes, lock, note, startedAt: now, endsAt: now + minutes * 60000 }
}

// Finish the phase when its time is up. Returns the (possibly new) session.
async function advanceSession(session, settings) {
  const now = Date.now()
  if (!session || !session.endsAt || now < session.endsAt) return session
  if (session.phase === 'focus') {
    const long = session.round % settings.longEvery === 0
    const brk = long ? settings.longBreak : settings.shortBreak
    let msg = t(long ? 'breakMsgLong' : 'breakMsg', brk)
    const guard = GUARD_MODES[settings.guardMode] && (await getGuard())
    if (guard?.round === session.startedAt) msg += `\n${GUARD_NAME}: ${guardVerdict(guard)}`
    notify('break', t('roundDone', session.round), msg)
    session = { ...session, phase: 'break', startedAt: now, endsAt: now + brk * 60000 }
  } else if (session.phase === 'break') {
    if (settings.autoNext) {
      session = focusRound(settings, session.round + 1, session.minutes, session.lock, session.note)
      notify('next', t('breakOver'), t('roundStarted', session.round, session.minutes))
    } else {
      session = { ...session, phase: 'ready', startedAt: now, endsAt: 0 }
      notify('ready', t('breakOver'), t('readyForRound', session.round + 1), [{ title: t('startNextRound') }])
    }
  }
  await chrome.storage.local.set({ session })
  return session
}

function isLocked(session) {
  return !!(session?.lock && session.phase === 'focus' && session.endsAt > Date.now())
}

// ---------------------------------------------------------------------------
// Warden Gerrit
//
// storage.local.guard = { round, calls, strikes, escapes, nextCallAt,
//   offsite: { host, since }, idleArmed, pending, last }
// round = startedAt of the focus round; a new round starts with a clean slate.
// pending = the check that is running now: { id, kind, line, askedAt, deadline, code, test }
// ---------------------------------------------------------------------------

async function getGuard() {
  const { guard } = await chrome.storage.local.get('guard')
  return guard || null
}

async function prisonerNumber() {
  let { prisoner } = await chrome.storage.local.get('prisoner')
  if (!prisoner) {
    prisoner = String(1000 + Math.floor(Math.random() * 9000))
    await chrome.storage.local.set({ prisoner })
  }
  return prisoner
}

function guardMode(settings, session) {
  return session?.phase === 'focus' ? GUARD_MODES[settings.guardMode] || null : null
}

function nextRollCall(mode, now = Date.now()) {
  if (!mode.rollCall) return 0
  const [a, b] = mode.rollCall
  return now + (a + Math.random() * (b - a)) * 60000
}

// Work = local or a work domain. In "only these sites" mode everything that is
// open is already allowed, so slacking off does not count there.
function isWorkUrl(url, ctx) {
  return ctx.mode === 'allow' || isAlwaysAllowed(url) || ctx.work.some((e) => entryMatches(url, e))
}

async function bumpGuardStat(field) {
  const stats = await getStats()
  const g = (dayStats(stats).guard ||= { calls: 0, strikes: 0 })
  g[field] = (g[field] || 0) + 1
  await chrome.storage.local.set({ stats })
}

async function newCall(guard, mode, { kind, vars = {}, test = false }) {
  const nr = await prisonerNumber()
  const now = Date.now()
  guard.pending = {
    id: now,
    kind,
    test,
    askedAt: now,
    deadline: now + mode.answerSec * 1000,
    code: mode.code,
    line: guardLine(kind, { nr, sec: mode.answerSec, ...vars })
  }
  guard.last = null
  if (!test) {
    guard.calls++
    await bumpGuardStat('calls')
  }
}

async function focusGuardWindow() {
  const { guardWin } = await chrome.storage.session.get('guardWin')
  if (guardWin) {
    try {
      await chrome.windows.update(guardWin, { focused: true, drawAttention: true })
      return
    } catch {
      // window no longer exists
    }
  }
  const W = 400
  const H = 660
  let pos = {}
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    pos = { left: Math.max(0, Math.round(win.left + (win.width - W) / 2)), top: Math.max(0, win.top + 60) }
  } catch {
    // no normal window: Chrome picks the position
  }
  const win = await chrome.windows.create({ url: 'guard/guard.html', type: 'popup', width: W, height: H, focused: true, ...pos })
  await chrome.storage.session.set({ guardWin: win.id })
}

async function showGuard(pending) {
  const title = t(pending.kind === 'appel' ? 'guardTitleRollCall' : 'guardTitleCheck', GUARD_NAME)
  notify('guard', title, pending.line, pending.code ? undefined : [{ title: t('present') }])
  await focusGuardWindow()
}

// Runs on every refresh. Returns the (updated) guard state.
async function guardCheck(state) {
  const { settings, session, ctx, target } = state
  const now = Date.now()
  let guard = await getGuard()
  const before = JSON.stringify(guard)
  const mode = guardMode(settings, session)
  let fresh = false

  if (mode && guard?.round !== session.startedAt) {
    guard = { round: session.startedAt, calls: 0, strikes: 0, escapes: 0, nextCallAt: nextRollCall(mode, now), offsite: null, idleArmed: true, pending: null, last: null }
  }

  // Reported in too late (or not at all).
  if (guard?.pending && now >= guard.pending.deadline) {
    const test = guard.pending.test
    guard.pending = null
    let line = test ? t('testLate') : ''
    if (!test && mode) {
      guard.strikes++
      await bumpGuardStat('strikes')
      line = guardLine('late', { strikes: guard.strikes })
      if (settings.guardPenalty) {
        session.endsAt += PENALTY_MINUTES * 60000
        if (ctx.focus?.reason === 'session') ctx.focus.until = session.endsAt
        await chrome.storage.local.set({ session })
        line += ' ' + t('penaltyAdded', PENALTY_MINUTES)
      }
      notify('guard', GUARD_NAME, line)
    }
    if (line) guard.last = { kind: 'late', at: now, line }
  }

  // Outside a focus round Gerrit takes a break (a practice roll call may continue).
  if (!mode) {
    if (guard?.pending && !guard.pending.test) guard.pending = null
  } else {
    if (!mode.rollCall) guard.nextCallAt = 0
    else if (!guard.nextCallAt) guard.nextCallAt = nextRollCall(mode, now)

    const idle = await chrome.idle.queryState(mode.idleSec)
    const still = idle !== 'active' && !(await chrome.tabs.query({ audible: true })).length
    if (!still) guard.idleArmed = true

    const off = mode.offsiteMin && ctx.work.length && target && !isWorkUrl(target.url, ctx) ? target.host : null
    if (!off) guard.offsite = null
    else if (guard.offsite?.host !== off) guard.offsite = { host: off, since: now }

    if (!guard.pending) {
      let call = null
      if (still && guard.idleArmed) {
        guard.idleArmed = false
        call = { kind: 'idle', vars: { idle: formatDuration(mode.idleSec) } }
      } else if (guard.offsite && now - guard.offsite.since >= mode.offsiteMin * 60000) {
        call = { kind: 'offsite', vars: { host: guard.offsite.host, min: Math.round((now - guard.offsite.since) / 60000) } }
        guard.offsite.since = now
      } else if (guard.nextCallAt && now >= guard.nextCallAt) {
        call = { kind: 'appel' }
        guard.nextCallAt = nextRollCall(mode, now)
      }
      if (call) {
        await newCall(guard, mode, call)
        fresh = true
      }
    }
  }

  if (JSON.stringify(guard) !== before) await chrome.storage.local.set({ guard })
  if (fresh) await showGuard(guard.pending)
  return guard
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

// Temporarily opened sites; expired ones are cleaned up right away.
async function getExceptions() {
  const { exceptions = {} } = await chrome.storage.local.get('exceptions')
  const now = Date.now()
  const out = {}
  for (const [host, until] of Object.entries(exceptions)) if (until > now) out[host] = until
  if (Object.keys(out).length !== Object.keys(exceptions).length) await chrome.storage.local.set({ exceptions: out })
  return out
}

async function computeState() {
  const settings = await getSettings()
  const stats = await getStats()
  const { changed, target } = await track(settings, stats)
  if (changed) {
    pruneStats(stats)
    await chrome.storage.local.set({ stats })
  }

  const session = await advanceSession(await getSession(), settings)
  const exceptions = await getExceptions()

  let focus = null
  if (session?.phase === 'focus') focus = { reason: 'session', until: session.endsAt }
  else if (settings.schedulesOn) {
    const until = scheduleActiveUntil(settings.schedules)
    if (until) focus = { reason: 'schedule', until }
  }

  const budgetBlocked = settings.budgets
    .filter((b) => b.minutes >= 0 && usedToday(stats, b.domain) >= b.minutes * 60)
    .map((b) => b.domain)

  const parse = (list) => list.map(parseEntry).filter(Boolean)
  const ctx = {
    focus,
    mode: settings.mode,
    block: parse(settings.blocklist),
    allow: parse(settings.allowlist),
    work: parse(settings.workDomains),
    budgetBlocked,
    exceptions: Object.keys(exceptions)
  }
  return { settings, stats, session, exceptions, ctx, target }
}

async function applyRules(ctx) {
  const rules = buildDnrRules(ctx, BLOCK_PAGE)
  const sig = JSON.stringify(rules)
  const { ruleSig } = await chrome.storage.session.get('ruleSig')
  if (sig === ruleSig) return false
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules
  })
  await chrome.storage.session.set({ ruleSig: sig })
  return true
}

function blockTab(tabId, url) {
  return chrome.tabs.update(tabId, { url: BLOCK_PAGE + '#' + url }).catch(() => {})
}

async function enforceOpenTabs(ctx) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.url && decide(tab.url, ctx)) await blockTab(tab.id, tab.url)
  }
}

// Badge in house style: lime (extension color) during focus, signal orange during
// a break (same break color as in the popup), text always ink.
const BADGE_FOCUS = '#C6F24E'
const BADGE_BREAK = '#FF6E33'
const BADGE_TEXT = '#0E0E10'

async function updateBadge(session, focus) {
  let text = ''
  let color = BADGE_FOCUS
  if (session?.phase === 'focus' || session?.phase === 'break') {
    text = String(Math.max(1, Math.ceil((session.endsAt - Date.now()) / 60000)))
    if (session.phase === 'break') color = BADGE_BREAK
  } else if (session?.phase === 'ready') {
    text = '▶'
    color = BADGE_BREAK
  } else if (focus) {
    text = t('badgeOn')
  }
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT })
  await chrome.action.setBadgeText({ text })
}

async function scheduleWake({ settings, session, exceptions, stats, target, guard }) {
  const now = Date.now()
  const times = []
  if (session?.endsAt) times.push(session.endsAt)
  if (settings.schedulesOn) times.push(nextScheduleBoundary(settings.schedules, now))
  times.push(...Object.values(exceptions))
  if (guard?.pending) times.push(guard.pending.deadline)
  if (guard?.nextCallAt) times.push(guard.nextCallAt)
  const midnight = new Date(now)
  midnight.setHours(24, 0, 1, 0)
  times.push(midnight.getTime())
  // Moment when the budget of the site that is open now runs out.
  if (target) {
    for (const b of settings.budgets) {
      if (!hostMatches(target.host, b.domain)) continue
      const left = b.minutes * 60 - usedToday(stats, b.domain)
      if (left > 0) times.push(now + left * 1000)
    }
  }
  const when = Math.min(...times.filter((t) => t > now))
  if (Number.isFinite(when)) await chrome.alarms.create('wake', { when })
}

async function doRefresh({ enforce = false } = {}) {
  const state = await computeState()
  ctxCache = state.ctx
  await chrome.storage.session.set({ ctx: state.ctx })
  const rulesChanged = await applyRules(state.ctx)
  if (rulesChanged || enforce) await enforceOpenTabs(state.ctx)
  state.guard = await guardCheck(state)
  await updateBadge(state.session, state.ctx.focus)
  await scheduleWake(state)
  if (!(await chrome.alarms.get('tick'))) await chrome.alarms.create('tick', { periodInMinutes: 0.5 })
  return state
}

// Everything that reads and writes back the stored state runs one after another.
let chain = Promise.resolve()
function serial(fn) {
  const run = chain.then(fn)
  chain = run.catch((e) => console.error('[Burg Focus]', e))
  return run
}

function refresh(opts) {
  return serial(() => doRefresh(opts))
}

async function getCtx() {
  if (ctxCache) return ctxCache
  const { ctx } = await chrome.storage.session.get('ctx')
  return ctx || (await refresh()).ctx
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.remove('ruleSig')
  refresh({ enforce: true })
})
chrome.runtime.onStartup.addListener(() => refresh({ enforce: true }))
chrome.idle.setDetectionInterval(IDLE_SECONDS)

chrome.alarms.onAlarm.addListener(() => refresh())
chrome.tabs.onActivated.addListener(() => refresh())
chrome.windows.onFocusChanged.addListener(() => refresh())
chrome.idle.onStateChanged.addListener(() => refresh())

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // Sites that change pages without a real navigation (YouTube Shorts,
  // Instagram Reels) slip past declarativeNetRequest; we catch them here.
  if (info.url) {
    const decision = decide(info.url, await getCtx())
    if (decision) return blockTab(tabId, info.url)
  }
  if ((info.url || 'audible' in info) && tab.active) refresh()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refresh({ enforce: true })
})

function startNext(session, settings) {
  return focusRound(settings, (session?.round || 0) + 1, session?.minutes || settings.sessionMinutes, session?.lock ?? settings.sessionLock, session?.note || '')
}

async function nextRound() {
  const settings = await getSettings()
  await chrome.storage.local.set({ session: startNext(await getSession(), settings) })
  chrome.notifications.clear('ready')
  await refresh({ enforce: true })
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'ready') nextRound()
  if (id === 'guard') focusGuardWindow()
  chrome.notifications.clear(id)
})
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === 'ready') nextRound()
  if (id === 'guard') handlers.guardAnswer({})
})

chrome.windows.onRemoved.addListener(async (id) => {
  const { guardWin } = await chrome.storage.session.get('guardWin')
  if (id === guardWin) await chrome.storage.session.remove('guardWin')
})

// Count blocks, but the same tab and URL only once within a few seconds.
const recentBlocks = new Map()

async function countBlock(tabId, url) {
  const host = hostOf(url)
  if (!host) return
  const key = tabId + ' ' + url
  const now = Date.now()
  if (now - (recentBlocks.get(key) || 0) < 3000) return
  recentBlocks.set(key, now)
  const stats = await getStats()
  const b = dayStats(stats).blocks
  b[host] = (b[host] || 0) + 1
  await chrome.storage.local.set({ stats })

  // During a guarded round this is an escape attempt.
  const guard = await getGuard()
  const session = await getSession()
  if (guard && guardMode(await getSettings(), session) && guard.round === session.startedAt) {
    guard.escapes = (guard.escapes || 0) + 1
    await chrome.storage.local.set({ guard })
  }
}

const handlers = {
  async state() {
    const s = await refresh()
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const url = active[0]?.url || ''
    const host = hostOf(url)
    const today = s.stats[dayKey()] || { time: {}, blocks: {} }
    return {
      settings: s.settings,
      session: s.session,
      focus: s.ctx.focus,
      locked: isLocked(s.session),
      exceptions: s.exceptions,
      budgetBlocked: s.ctx.budgetBlocked,
      today,
      budgets: s.settings.budgets.map((b) => ({ ...b, usedSec: usedToday(s.stats, b.domain) })),
      guard: s.guard,
      active: { url, host, blocked: !!(url && decide(url, s.ctx)) }
    }
  },

  async startSession({ minutes, lock, note }) {
    const settings = await getSettings()
    const session = focusRound(settings, 1, minutes, !!lock, String(note || '').slice(0, 300))
    await chrome.storage.local.set({ session })
    await refresh({ enforce: true })
    return { ok: true }
  },

  async stopSession() {
    if (isLocked(await getSession())) return { ok: false, error: 'locked' }
    await chrome.storage.local.set({ session: null })
    chrome.notifications.clear('ready')
    await refresh()
    return { ok: true }
  },

  nextRound: async () => (await nextRound(), { ok: true }),

  async skipBreak() {
    return handlers.nextRound()
  },

  async blockInfo({ url }) {
    const s = await refresh()
    const decision = decide(url, s.ctx)
    const host = hostOf(url)
    const budget = decision?.reason === 'budget' ? s.settings.budgets.find((b) => b.domain === decision.domain) : null
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 0)
    return {
      blocked: !!decision,
      reason: decision?.reason || null,
      until: decision?.reason === 'budget' ? midnight.getTime() : s.ctx.focus?.until || 0,
      host,
      budget,
      note: (s.session?.phase === 'focus' && s.session.note) || s.settings.note,
      session: s.session,
      locked: isLocked(s.session),
      friction: s.settings.friction,
      waitSeconds: s.settings.waitSeconds,
      phrase: s.settings.phrase,
      graceMinutes: s.settings.graceMinutes,
      guardLine: guardMode(s.settings, s.session) ? guardLine('escape', { nr: await prisonerNumber() }) : null
    }
  },

  async blocked({ url }, sender) {
    await serial(() => countBlock(sender.tab?.id, url))
    return { ok: true }
  },

  async guardState() {
    const s = await refresh()
    return {
      guard: s.guard,
      mode: s.settings.guardMode,
      sound: s.settings.guardSound,
      prisoner: await prisonerNumber(),
      session: s.session
    }
  },

  guardAnswer({ code }) {
    return serial(async () => {
      await doRefresh() // first check whether time was already up
      const guard = await getGuard()
      const p = guard?.pending
      if (!p) return { ok: false, error: 'none' }
      if (p.code && String(code || '').trim() !== (await prisonerNumber())) return { ok: false, error: 'wrong', line: guardLine('wrong') }
      guard.pending = null
      guard.last = { kind: 'ok', at: Date.now(), line: p.test ? t('testOk') : guardLine('ok') }
      await chrome.storage.local.set({ guard })
      chrome.notifications.clear('guard')
      return { ok: true, line: guard.last.line }
    })
  },

  async guardOpen() {
    await focusGuardWindow()
    return { ok: true }
  },

  guardTest() {
    return serial(async () => {
      const settings = await getSettings()
      const mode = GUARD_MODES[settings.guardMode] || GUARD_MODES.streng
      const guard = (await getGuard()) || { round: null, calls: 0, strikes: 0, escapes: 0, nextCallAt: 0, offsite: null, idleArmed: true, pending: null, last: null }
      await newCall(guard, mode, { kind: 'appel', test: true })
      await chrome.storage.local.set({ guard })
      await showGuard(guard.pending)
      return { ok: true }
    })
  },

  async allowTemporarily({ url }) {
    if (isLocked(await getSession())) return { ok: false, error: 'locked' }
    const host = hostOf(url)
    if (!host) return { ok: false }
    const settings = await getSettings()
    const exceptions = await getExceptions()
    exceptions[host] = Date.now() + settings.graceMinutes * 60000
    await chrome.storage.local.set({ exceptions })
    await refresh()
    return { ok: true }
  },

  async endExceptions() {
    await chrome.storage.local.set({ exceptions: {} })
    await refresh({ enforce: true })
    return { ok: true }
  },

  async clearStats() {
    await chrome.storage.local.set({ stats: {} })
    return { ok: true }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg?.type]
  if (!fn) return false
  fn(msg, sender).then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }))
  return true
})

// Burg Media: welcome page after installing, short page after removing.
// Only UTM tags in the URL, nothing else is sent along.
const SITE = 'https://burgmedia.eu/extensies/burg-focus/'
const utm = (campaign) => '?utm_source=burg-focus&utm_medium=extension&utm_campaign=' + campaign
chrome.runtime.setUninstallURL(SITE + 'verwijderd/' + utm('uninstall'))
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: SITE + 'welkom/' + utm('install') })
})
