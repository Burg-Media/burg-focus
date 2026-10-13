'use strict'

const $ = (id) => document.getElementById(id)
localizePage()
const DAYS = t('dayNames').split(',')

let state = null
let minutes = 25
let stopCleanup = () => {}

async function load() {
  state = await send('state')
  render()
}

function render() {
  const { settings, session, focus, locked } = state

  // Status in the top right corner
  const pill = $('pill')
  pill.className = 'pill'
  if (session?.phase === 'break' || session?.phase === 'ready') {
    pill.textContent = t('pillBreak')
    pill.classList.add('break')
  } else if (focus) {
    pill.textContent = focus.reason === 'session' ? t('pillFocus') : t('pillSchedule')
    pill.classList.add('on')
  } else pill.textContent = t('pillOff')

  // Session or start buttons
  $('start-view').hidden = !!session
  $('session-view').hidden = !session
  if (!session) {
    if (!$('durations').dataset.init) {
      minutes = settings.sessionMinutes
      $('lock').checked = settings.sessionLock
      $('durations').dataset.init = '1'
    }
    for (const b of $('durations').children) b.setAttribute('aria-checked', String(Number(b.dataset.min) === minutes))
  } else {
    const phase = $('phase')
    phase.className = 'phase' + (session.phase === 'focus' ? '' : ' break')
    phase.textContent = { focus: t('phaseFocus', session.round), break: t('phaseBreak'), ready: t('breakOver') }[session.phase]
    $('clock').hidden = session.phase === 'ready'
    $('session-meta').textContent =
      session.phase === 'ready' ? t('readyForRoundMin', session.round + 1, session.minutes) : `${t('untilTime', formatClock(session.endsAt))}${session.lock ? ' · ' + t('lockOn') : ''}`
    $('session-note').hidden = !session.note
    $('session-note').textContent = session.note || ''
    $('next').hidden = session.phase !== 'ready'
    $('skip').hidden = session.phase !== 'break'
    $('stop').disabled = locked
    $('lock-msg').hidden = !locked
    $('lock-msg').textContent = locked ? t('lockStopAfter', formatClock(session.endsAt)) : ''
    tickClock()
  }
  $('guard-mode').value = settings.guardMode
  renderGuard()

  // Schedule
  $('schedules-on').checked = settings.schedulesOn
  $('schedule-status').textContent = scheduleStatus(settings)

  renderSite()
  renderExceptions()
  renderToday()
}

// Warden Gerrit during a focus round.
function renderGuard() {
  const { settings, session, guard } = state
  const mode = GUARD_MODES[settings.guardMode]
  const line = $('guard-line')
  line.hidden = !mode || session?.phase !== 'focus'
  if (line.hidden) return
  const g = guard?.round === session.startedAt ? guard : { calls: 0, strikes: 0 }
  line.classList.toggle('alert', !!g.pending)
  line.textContent = g.pending
    ? t('guardCalling', GUARD_NAME)
    : `${GUARD_NAME} (${mode.label.toLowerCase()}) · ${plural(g.strikes, 'nStrikes')}${settings.guardPenalty ? ` · ${t('penaltyPerStrike', PENALTY_MINUTES)}` : ''}`
}

function scheduleStatus(settings) {
  if (!settings.schedules.length) return t('noSchedule')
  if (!settings.schedulesOn) return ''
  const until = scheduleActiveUntil(settings.schedules)
  if (until) return t('focusTimeUntil', formatClock(until))
  const next = scheduleWindows(settings.schedules).find((w) => w.start > Date.now())
  if (!next) return ''
  const d = new Date(next.start)
  const today = dayKey() === dayKey(d)
  return t('nextFocusTime', today ? t('todayLower') : DAYS[d.getDay()], formatClock(next.start))
}

function tickClock() {
  const s = state?.session
  if (!s || !s.endsAt) return
  const left = s.endsAt - Date.now()
  $('clock').textContent = formatCountdown(left)
  if (left <= 0) setTimeout(load, 1200)
}

function renderSite() {
  const { settings, active, budgets, locked } = state
  const host = active.host
  $('site-box').hidden = !host
  if (!host) return
  $('site').textContent = host
  const btn = $('site-action')
  const url = active.url
  btn.disabled = false
  if (settings.mode === 'allow') {
    const allowed = settings.allowlist.map(parseEntry).filter(Boolean).some((e) => entryMatches(url, e))
    btn.textContent = allowed ? t('siteAllowed') : t('siteAllow')
    btn.disabled = allowed || locked
    btn.onclick = () => addTo('allowlist', host)
  } else {
    const listed = settings.blocklist.map(parseEntry).filter(Boolean).some((e) => entryMatches(url, e))
    btn.textContent = listed ? t('siteListed') : t('siteBlock')
    btn.disabled = listed
    btn.onclick = () => addTo('blocklist', host)
  }

  const budget = budgets.find((b) => hostMatches(host, b.domain))
  $('site-budget').hidden = !budget
  if (budget) {
    const limit = budget.minutes * 60
    const pct = limit ? Math.min(100, (budget.usedSec / limit) * 100) : 100
    $('site-budget-bar').classList.toggle('over', budget.usedSec >= limit)
    $('site-budget-bar').firstElementChild.style.width = pct + '%'
    $('site-budget-text').textContent = t('budgetUsed', budget.domain, formatDuration(budget.usedSec), budget.minutes)
  }
}

async function addTo(list, host) {
  const settings = await getSettings()
  await saveSettings({ [list]: normalizeList([...settings[list], host]) })
  setTimeout(load, 300)
}

function renderExceptions() {
  const list = Object.entries(state.exceptions)
  $('exceptions-box').hidden = !list.length
  $('exceptions').replaceChildren(
    ...list.map(([host, until]) => el('li', {}, el('span', { text: host }), el('span', { class: 'muted', text: t('untilTime', formatClock(until)) }))),
    el('li', {}, el('button', { class: 'link small', type: 'button', text: t('blockAgainNow'), onclick: () => send('endExceptions').then(load) }))
  )
}

function renderToday() {
  const time = Object.entries(state.today.time || {}).sort((a, b) => b[1] - a[1])
  const blocks = Object.values(state.today.blocks || {}).reduce((a, b) => a + b, 0)
  const total = time.reduce((a, [, s]) => a + s, 0)
  $('today-total').textContent = `${formatDuration(total)}${blocks ? ` · ${t('blockedTimes', blocks)}` : ''}`
  const top = time.slice(0, 5)
  const max = top[0]?.[1] || 1
  $('top-empty').hidden = top.length > 0
  $('top').replaceChildren(
    ...top.map(([host, sec]) => {
      const bar = el('div', { class: 'bar' }, el('span'))
      bar.firstElementChild.style.width = Math.max(2, (sec / max) * 100) + '%'
      return el('li', { title: `${host}: ${formatDuration(sec)}` }, el('span', { class: 'name', text: host }), el('span', { class: 'val', text: formatDuration(sec) }), bar)
    })
  )
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

$('durations').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-min]')
  if (!b) return
  minutes = Number(b.dataset.min)
  render()
})

$('start').addEventListener('click', async () => {
  await send('startSession', { minutes, lock: $('lock').checked, note: $('note').value.trim() })
  load()
})

$('note').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('start').click()
})

$('guard-mode').addEventListener('change', (e) => saveSettings({ guardMode: e.target.value }))
$('guard-line').addEventListener('click', () => send('guardOpen'))

$('next').addEventListener('click', () => send('nextRound').then(load))
$('skip').addEventListener('click', () => send('skipBreak').then(load))

$('stop').addEventListener('click', () => {
  // Break or waiting for the next round: no hurdle needed.
  if (state.session.phase !== 'focus') return send('stopSession').then(load)
  $('stop').hidden = true
  stopCleanup = showFriction($('stop-friction'), state.settings, t('stopSession'), async () => {
    stopCleanup()
    $('stop-friction').hidden = true
    $('stop').hidden = false
    await send('stopSession')
    load()
  })
})

$('schedules-on').addEventListener('change', async (e) => {
  const on = e.target.checked
  const activeNow = state.settings.schedulesOn && scheduleActiveUntil(state.settings.schedules)
  if (on || !activeNow) {
    await saveSettings({ schedulesOn: on })
    return setTimeout(load, 300)
  }
  // Turning it off in the middle of focus time: hurdle first.
  e.target.checked = true
  showFriction($('schedule-friction'), state.settings, t('turnOffSchedule'), async () => {
    $('schedule-friction').hidden = true
    await saveSettings({ schedulesOn: false })
    setTimeout(load, 300)
  })
})

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage())
$('open-stats').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#stats') }))

setInterval(tickClock, 1000)
setInterval(load, 15000)
load()
