'use strict'

// Burg Focus: guard window. Warden Gerrit calls, you report in.

const $ = (id) => document.getElementById(id)
localizePage()

let data = null
let seenPending = null
let closeTimer = 0
let loading = false
let flash = '' // temporary text in the speech bubble (wrong number, lawyer)

async function load() {
  if (loading) return
  loading = true
  try {
    data = await send('guardState')
    render()
  } finally {
    loading = false
  }
}

function setMood(mood) {
  const g = $('gerrit')
  g.classList.remove('mood-neutral', 'mood-shout', 'mood-happy', 'mood-angry')
  g.classList.add('mood-' + mood)
}

function say(text) {
  const b = $('bubble')
  if (b.textContent === text) return
  b.textContent = text
  b.classList.remove('pop')
  void b.offsetWidth
  b.classList.add('pop')
}

function render() {
  const { guard, mode, prisoner, session } = data
  document.body.dataset.mode = mode
  $('mode').textContent = GUARD_MODES[mode]?.label || t('guardOffCap')
  $('prisoner').textContent = prisoner
  $('prisoner-hint').textContent = prisoner

  const p = guard?.pending
  $('answer').hidden = !p
  $('after').hidden = !!p
  clearTimeout(closeTimer)
  $('autoclose').textContent = ''

  if (p) {
    if (p.id !== seenPending) {
      seenPending = p.id
      flash = ''
      $('code').value = ''
      resetLawyer()
      $('gerrit').classList.remove('enter')
      void $('gerrit').offsetWidth
      $('gerrit').classList.add('enter')
      if (data.sound) whistle()
    }
    setMood('shout')
    say(flash || p.line)
    $('code-box').hidden = !p.code
    $('present').disabled = false
    if (p.code) $('code').focus()
    else $('present').focus()
    tick()
  } else {
    $('gerrit').classList.remove('hurry')
    const last = guard?.last && Date.now() - guard.last.at < 10 * 60000 ? guard.last : null
    if (last) {
      setMood(last.kind === 'ok' ? 'happy' : 'angry')
      say(last.line)
      if (last.kind === 'ok') autoClose(6)
    } else {
      setMood('neutral')
      say(session?.phase === 'focus' ? t('guardPatrol') : t('guardCoffee'))
    }
    $('close').textContent = last?.kind === 'late' ? t('sorryGerrit') : t('close')
  }

  $('tally').textContent =
    guard && guard.round && session?.phase === 'focus'
      ? t('thisRound', `${plural(guard.calls, 'nRollCalls')} · ${plural(guard.strikes, 'nStrikes')} · ${plural(guard.escapes || 0, 'nEscapes')}`)
      : ''
}

function autoClose(sec) {
  const step = () => {
    $('autoclose').textContent = t('windowClosesIn', sec)
    if (sec-- <= 0) return window.close()
    closeTimer = setTimeout(step, 1000)
  }
  step()
}

// Count down to the deadline.
function tick() {
  const p = data?.guard?.pending
  if (!p) return
  const total = p.deadline - p.askedAt
  const left = Math.max(0, p.deadline - Date.now())
  $('seconds').textContent = Math.ceil(left / 1000) + ' s'
  $('timebar').firstElementChild.style.width = (left / total) * 100 + '%'
  const low = left < total * 0.3
  $('seconds').parentElement.classList.toggle('low', low)
  $('gerrit').classList.toggle('hurry', low)
  if (left <= 0) {
    $('present').disabled = true
    setTimeout(load, 600)
  }
}

async function answer() {
  const res = await send('guardAnswer', { code: $('code').value })
  if (res?.error === 'wrong') {
    flash = res.line
    say(flash)
    const box = $('code-box')
    box.classList.remove('wrong')
    void box.offsetWidth
    box.classList.add('wrong')
    $('code').select()
    return
  }
  flash = ''
  load()
}

$('present').addEventListener('click', answer)
$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') answer()
})
$('code').addEventListener('input', () => ($('code').value = $('code').value.replace(/\D/g, '')))
$('close').addEventListener('click', () => window.close())

// "I want a lawyer": in Crazy mode the button runs away.
function resetLawyer() {
  $('lawyer').style.transform = ''
}
$('lawyer').addEventListener('pointerenter', () => {
  if (data?.mode !== 'gek') return
  const box = $('actions').getBoundingClientRect()
  const btn = $('lawyer').getBoundingClientRect()
  const x = (Math.random() - 0.5) * Math.max(0, box.width - btn.width)
  const y = -Math.random() * 40
  $('lawyer').style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
})
$('lawyer').addEventListener('click', () => {
  flash = guardLine('lawyer')
  say(flash)
})

// Eyes follow the mouse; in Crazy mode they now and then look every which way.
function lookAt(x, y) {
  for (const id of ['pup-l', 'pup-r']) {
    const pup = $(id)
    const eye = pup.previousElementSibling.getBoundingClientRect()
    const cx = eye.left + eye.width / 2
    const cy = eye.top + eye.height / 2
    const a = Math.atan2(y - cy, x - cx)
    const d = Math.min(5, Math.hypot(x - cx, y - cy) / 12)
    pup.setAttribute('transform', `translate(${(Math.cos(a) * d).toFixed(1)} ${(Math.sin(a) * d).toFixed(1)})`)
  }
}
document.addEventListener('pointermove', (e) => lookAt(e.clientX, e.clientY))
setInterval(() => {
  if (data?.mode !== 'gek' || Math.random() < 0.5) return
  for (const id of ['pup-l', 'pup-r']) {
    const a = Math.random() * Math.PI * 2
    $(id).setAttribute('transform', `translate(${(Math.cos(a) * 5).toFixed(1)} ${(Math.sin(a) * 5).toFixed(1)})`)
  }
}, 900)

// Whistle: two blasts with a trill, entirely with Web Audio.
function whistle() {
  try {
    const ac = new AudioContext()
    const blow = (t0, dur) => {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      const lfo = ac.createOscillator()
      const depth = ac.createGain()
      osc.frequency.value = 2700
      lfo.frequency.value = 26
      depth.gain.value = 140
      lfo.connect(depth).connect(osc.frequency)
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(0.15, t0 + 0.03)
      gain.gain.setValueAtTime(0.15, t0 + dur - 0.06)
      gain.gain.linearRampToValueAtTime(0, t0 + dur)
      osc.connect(gain).connect(ac.destination)
      for (const n of [osc, lfo]) {
        n.start(t0)
        n.stop(t0 + dur)
      }
    }
    const t = ac.currentTime + 0.05
    blow(t, 0.3)
    blow(t + 0.42, 0.75)
    if (ac.state === 'suspended') document.addEventListener('pointerdown', () => ac.resume(), { once: true })
  } catch {
    // no sound, never mind
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.guard || changes.session)) load()
})

setInterval(tick, 250)
setInterval(load, 10000)
load()
