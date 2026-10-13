'use strict'

const $ = (id) => document.getElementById(id)
localizePage()
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = t('dayNames').split(',')

let settings = null
let locked = false

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showTab(name) {
  for (const b of document.querySelectorAll('nav [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== 'tab-' + name
  if (name === 'stats') renderStats()
}

document.querySelector('nav').addEventListener('click', (e) => {
  const b = e.target.closest('[role=tab]')
  if (!b) return
  history.replaceState(null, '', '#' + b.dataset.tab)
  showTab(b.dataset.tab)
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let savedTimer = 0
async function save(patch) {
  settings = await saveSettings(patch)
  $('saved').hidden = false
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => ($('saved').hidden = true), 1500)
}

function renderList(panel) {
  const key = panel.dataset.list
  panel.querySelector('.chips')?.remove()
  panel.querySelector('.add-row')?.remove()

  const chips = el(
    'ul',
    { class: 'chips' },
    ...settings[key].map((item) =>
      el(
        'li',
        {},
        item,
        el('button', {
          type: 'button',
          title: t('remove'),
          text: '×',
          onclick: async () => {
            await save({ [key]: settings[key].filter((x) => x !== item) })
            renderList(panel)
          }
        })
      )
    )
  )
  if (!settings[key].length) chips.append(el('li', { class: 'muted', text: t('empty') }))

  const input = el('input', { placeholder: key === 'blocklist' ? t('egBlock') : t('egAllow'), spellcheck: false })
  const error = el('span', { class: 'error' })
  const form = el(
    'form',
    {
      class: 'add-row',
      autocomplete: 'off',
      onsubmit: async (e) => {
        e.preventDefault()
        const items = input.value.split(/[\s,]+/).filter(Boolean)
        const bad = items.filter((x) => !parseEntry(x))
        if (bad.length) return (error.textContent = t('invalidDomain', bad.join(', ')))
        await save({ [key]: normalizeList([...settings[key], ...items]) })
        renderList(panel)
        panel.querySelector('.add-row input').focus()
      }
    },
    input,
    el('button', { class: 'btn', type: 'submit', text: t('add') }),
    error
  )
  panel.append(chips, form)
  applyLock()
}

function renderSchedules() {
  $('schedules').replaceChildren(
    ...settings.schedules.map((s, i) => {
      const update = (patch) => {
        const schedules = settings.schedules.map((x, j) => (j === i ? { ...x, ...patch } : x))
        return save({ schedules })
      }
      const days = el(
        'span',
        { class: 'days' },
        ...DAY_ORDER.map((d) =>
          el('button', {
            type: 'button',
            text: DAY_NAMES[d],
            'aria-pressed': String(s.days.includes(d)),
            onclick: async () => {
              const set = new Set(s.days)
              set.has(d) ? set.delete(d) : set.add(d)
              await update({ days: [...set].sort() })
              renderSchedules()
            }
          })
        )
      )
      const time = (field) => el('input', { type: 'time', value: s[field], onchange: (e) => e.target.value && update({ [field]: e.target.value }) })
      return el(
        'li',
        {},
        days,
        time('from'),
        el('span', { class: 'muted', text: t('to') }),
        time('to'),
        el('button', {
          class: 'x',
          type: 'button',
          title: t('remove'),
          text: '×',
          onclick: async () => {
            await save({ schedules: settings.schedules.filter((_, j) => j !== i) })
            renderSchedules()
          }
        })
      )
    })
  )
  applyLock()
}

$('guard-test').addEventListener('click', () => send('guardTest'))

$('add-schedule').addEventListener('click', async () => {
  await save({ schedules: [...settings.schedules, { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] })
  renderSchedules()
})

async function renderBudgets() {
  const stats = await getStatsData()
  const today = stats[dayKey()]?.time || {}
  $('budgets').replaceChildren(
    ...settings.budgets.map((b, i) => {
      const used = Object.entries(today).reduce((a, [h, s]) => a + (hostMatches(h, b.domain) ? s : 0), 0)
      return el(
        'li',
        {},
        el('span', { class: 'name', text: b.domain }),
        el('input', {
          type: 'number',
          class: 'num',
          min: 0,
          max: 1440,
          value: b.minutes,
          onchange: (e) => {
            const minutes = Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0)))
            save({ budgets: settings.budgets.map((x, j) => (j === i ? { ...x, minutes } : x)) })
          }
        }),
        el('span', { class: 'muted', text: t('minPerDay') }),
        el('span', { class: 'muted small used', text: t('todayUsed', formatDuration(used)) }),
        el('button', {
          class: 'x',
          type: 'button',
          title: t('remove'),
          text: '×',
          onclick: async () => {
            await save({ budgets: settings.budgets.filter((_, j) => j !== i) })
            renderBudgets()
          }
        })
      )
    })
  )
  applyLock()
}

$('budget-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const entry = parseEntry($('budget-domain').value)
  if (!entry) return $('budget-domain').focus()
  const minutes = Math.max(0, Math.min(1440, Math.round(Number($('budget-minutes').value) || 0)))
  const budgets = settings.budgets.filter((b) => b.domain !== entry.host)
  await save({ budgets: [...budgets, { domain: entry.host, minutes }] })
  $('budget-domain').value = ''
  renderBudgets()
})

function bindSimple() {
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === settings.mode
    r.onchange = () => save({ mode: r.value })
  }
  for (const r of document.querySelectorAll('input[name=guardMode]')) {
    r.checked = r.value === settings.guardMode
    r.onchange = () => save({ guardMode: r.value })
  }
  for (const r of document.querySelectorAll('input[name=friction]')) {
    r.checked = r.value === settings.friction
    r.onchange = () => save({ friction: r.value })
  }
  const checks = ['schedulesOn', 'sessionLock', 'autoNext', 'tracking', 'guardSound', 'guardPenalty']
  for (const id of checks) {
    $(id).checked = !!settings[id]
    $(id).onchange = () => save({ [id]: $(id).checked })
  }
  const nums = { waitSeconds: [5, 600], graceMinutes: [1, 120], shortBreak: [1, 60], longBreak: [1, 120], longEvery: [2, 12] }
  for (const [id, [min, max]] of Object.entries(nums)) {
    $(id).value = settings[id]
    $(id).onchange = () => {
      const v = Math.max(min, Math.min(max, Math.round(Number($(id).value) || min)))
      $(id).value = v
      save({ [id]: v })
    }
  }
  $('sessionMinutes').value = String(settings.sessionMinutes)
  $('sessionMinutes').onchange = () => save({ sessionMinutes: Number($('sessionMinutes').value) })
  $('phrase').value = settings.phrase
  $('phrase').onchange = () => save({ phrase: $('phrase').value.trim() || DEFAULT_SETTINGS.phrase })
  $('note').value = settings.note
  $('note').onchange = () => save({ note: $('note').value.trim() })
}

// Lock active: you can only add things to the block list.
function applyLock() {
  const keep = document.querySelector('[data-list=blocklist] .add-row')
  for (const c of $('tab-settings').querySelectorAll('input, select, textarea, button')) {
    c.disabled = locked && !keep?.contains(c)
  }
}

async function loadSettings() {
  settings = await getSettings()
  const state = await send('state')
  locked = state.locked
  $('lock-banner').hidden = !locked
  if (locked) $('lock-banner').textContent = t('lockBanner', formatClock(state.session.endsAt))
  bindSimple()
  for (const panel of document.querySelectorAll('[data-list]')) renderList(panel)
  renderSchedules()
  await renderBudgets()
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

let periodDays = 7

async function getStatsData() {
  const { stats } = await chrome.storage.local.get('stats')
  return stats || {}
}

function lastDays(n) {
  const out = []
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d)
    x.setDate(d.getDate() - i)
    out.push(x)
  }
  return out
}

function sum(obj) {
  return Object.values(obj || {}).reduce((a, b) => a + b, 0)
}

async function renderStats() {
  const stats = await getStatsData()
  const days = lastDays(periodDays)
  const keys = days.map((d) => dayKey(d))

  const time = {}
  const blocks = {}
  const guard = { calls: 0, strikes: 0 }
  let daysWithData = 0
  for (const k of keys) {
    const s = stats[k]
    if (!s) continue
    if (sum(s.time) > 0) daysWithData++
    for (const [h, v] of Object.entries(s.time || {})) time[h] = (time[h] || 0) + v
    for (const [h, v] of Object.entries(s.blocks || {})) blocks[h] = (blocks[h] || 0) + v
    guard.calls += s.guard?.calls || 0
    guard.strikes += s.guard?.strikes || 0
  }
  const total = sum(time)
  const blockTotal = sum(blocks)
  $('t-total').textContent = formatDuration(total)
  $('t-avg').textContent = daysWithData ? formatDuration(total / daysWithData) : '—'
  $('t-blocks').textContent = `${blockTotal}×`
  $('t-strikes').textContent = guard.calls ? `${guard.strikes} / ${guard.calls}` : '—'

  const chartDays = lastDays(periodDays === 1 ? 7 : periodDays)
  drawChart(chartDays.map((d) => ({ date: d, sec: sum(stats[dayKey(d)]?.time), blocks: sum(stats[dayKey(d)]?.blocks) })))

  const hosts = [...new Set([...Object.keys(time), ...Object.keys(blocks)])]
    .sort((a, b) => (time[b] || 0) - (time[a] || 0) || (blocks[b] || 0) - (blocks[a] || 0))
    .slice(0, 100)
  const max = Math.max(1, ...hosts.map((h) => time[h] || 0))
  $('sites-empty').hidden = hosts.length > 0
  $('sites').replaceChildren(
    ...hosts.map((h) => {
      const bar = el('div', { class: 'bar' }, el('span'))
      bar.firstElementChild.style.width = ((time[h] || 0) / max) * 100 + '%'
      return el(
        'tr',
        {},
        el('td', { text: h, title: h }),
        el('td', { class: 'num-col', text: time[h] ? formatDuration(time[h]) : '—' }),
        el('td', { class: 'bar-cell' }, bar),
        el('td', { class: 'num-col', text: blocks[h] ? `${blocks[h]}×` : '' })
      )
    })
  )
}

const SVG = 'http://www.w3.org/2000/svg'
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  return n
}

function axisLabel(min) {
  return min >= 60 ? t('durHours', min / 60) : t('durMin', min)
}

function drawChart(data) {
  const box = $('chart')
  const W = Math.max(280, box.clientWidth)
  const H = 220
  const m = { l: 46, r: 4, t: 8, b: 22 }
  const pw = W - m.l - m.r
  const ph = H - m.t - m.b

  const maxMin = Math.max(...data.map((d) => d.sec / 60), 1)
  const step = [15, 30, 60, 120, 180, 240, 360, 480].find((s) => maxMin / s <= 4) || 600
  const top = Math.ceil(maxMin / step) * step
  const y = (min) => m.t + ph - (min / top) * ph

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('timePerDay') })
  for (let v = 0; v <= top; v += step) {
    root.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }))
    const label = svg('text', { class: 'axis-label', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' })
    label.textContent = axisLabel(v)
    root.append(label)
  }

  const band = pw / data.length
  const bw = Math.max(2, Math.min(40, band - 2))
  const every = data.length <= 7 ? 1 : data.length <= 31 ? 5 : 14
  data.forEach((d, i) => {
    const x = m.l + i * band + (band - bw) / 2
    const g = svg('g')
    const hit = svg('rect', { class: 'hit', x: m.l + i * band, y: m.t, width: band, height: ph })
    g.append(hit)
    const h = (d.sec / 60 / top) * ph
    if (h > 0.5) {
      const r = Math.min(4, bw / 2, h)
      const yb = m.t + ph
      g.append(
        svg('path', {
          class: 'col',
          d: `M${x},${yb}V${yb - h + r}Q${x},${yb - h} ${x + r},${yb - h}H${x + bw - r}Q${x + bw},${yb - h} ${x + bw},${yb - h + r}V${yb}Z`
        })
      )
    }
    const label = `${DAY_NAMES[d.date.getDay()]} ${d.date.getDate()} ${d.date.toLocaleDateString(t('lang'), { month: 'short' })}`
    g.addEventListener('mousemove', (e) => showTip(e, `${label}: ${formatDuration(d.sec)}${d.blocks ? ` · ${t('blockedTimes', d.blocks)}` : ''}`))
    g.addEventListener('mouseleave', hideTip)
    root.append(g)

    if (i % every === 0 || i === data.length - 1) {
      if (i === data.length - 1 && i % every !== 0 && i % every < every / 2) return
      const tick = svg('text', { class: 'axis-label', x: m.l + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' })
      tick.textContent = data.length <= 7 ? `${DAY_NAMES[d.date.getDay()]} ${d.date.getDate()}` : `${d.date.getDate()}-${d.date.getMonth() + 1}`
      root.append(tick)
    }
  })
  box.replaceChildren(root)
}

function showTip(e, text) {
  const tip = $('tooltip')
  tip.textContent = text
  tip.hidden = false
  const r = tip.getBoundingClientRect()
  tip.style.left = Math.min(window.innerWidth - r.width - 8, e.clientX + 12) + 'px'
  tip.style.top = e.clientY - r.height - 10 + 'px'
}
function hideTip() {
  $('tooltip').hidden = true
}

$('period').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]')
  if (!b) return
  periodDays = Number(b.dataset.days)
  for (const x of $('period').children) x.setAttribute('aria-checked', String(x === b))
  renderStats()
})

let armed = false
$('clear-stats').addEventListener('click', async (e) => {
  if (!armed) {
    armed = true
    e.target.textContent = t('confirmClear')
    return setTimeout(() => {
      armed = false
      e.target.textContent = t('clearStats')
    }, 4000)
  }
  await send('clearStats')
  armed = false
  e.target.textContent = t('clearStats')
  renderStats()
})

let resizeTimer = 0
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => !$('tab-stats').hidden && renderStats(), 150)
})

loadSettings()
showTab(location.hash === '#stats' ? 'stats' : 'settings')
