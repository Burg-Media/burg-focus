'use strict'

// Burg Focus: block page. The original URL is after the hash.

const $ = (id) => document.getElementById(id)
localizePage()
const target = location.hash.slice(1)
const targetHost = hostOf(target) // '' if it is not http(s): then never redirect

let info = null
let countdownTimer = 0

const REASONS = {
  session: t('reasonSession'),
  schedule: t('reasonSchedule'),
  budget: ''
}

async function load() {
  info = await send('blockInfo', { url: target })
  $('host').textContent = targetHost || target

  if (!info?.blocked) return showFree()
  send('blocked', { url: target })

  $('reason').textContent =
    info.reason === 'budget'
      ? t('reasonBudget', info.budget?.minutes ?? '?', info.budget?.domain || targetHost)
      : REASONS[info.reason]

  if (info.until) {
    $('countdown-box').hidden = false
    $('countdown-label').textContent = info.reason === 'budget' ? t('freeAgainIn') : t('remaining')
    $('countdown-until').textContent = t('untilTime', formatClock(info.until))
    clearInterval(countdownTimer)
    const tick = () => {
      const left = info.until - Date.now()
      $('countdown').textContent = formatCountdown(left)
      if (left <= 0) {
        clearInterval(countdownTimer)
        setTimeout(load, 1500)
      }
    }
    countdownTimer = setInterval(tick, 1000)
    tick()
  }

  $('guard-quip').hidden = !info.guardLine
  $('guard-quip').textContent = info.guardLine ? `${t('guardName')}: “${info.guardLine}”` : ''

  $('note-box').hidden = !info.note
  $('note').textContent = info.note || ''

  $('anyway').hidden = info.locked || !targetHost
  $('locked').hidden = !info.locked
  if (info.locked) $('locked').textContent = t('lockAnywayAfter', formatClock(info.session.endsAt))
}

function showFree() {
  $('title').textContent = t('freeAgain')
  $('reason').textContent = t('notBlocked')
  $('countdown-box').hidden = true
  $('guard-quip').hidden = true
  $('note-box').hidden = true
  $('back').hidden = true
  $('go').hidden = !targetHost
  $('anyway').hidden = true
  $('locked').hidden = true
  $('friction').hidden = true
}

function goToTarget() {
  if (targetHost) location.replace(target)
}

$('go').addEventListener('click', goToTarget)

$('back').addEventListener('click', async () => {
  if (history.length > 1) return history.back()
  const tab = await chrome.tabs.getCurrent()
  chrome.tabs.update(tab.id, { url: 'chrome://newtab/' })
})

$('anyway').addEventListener('click', () => {
  $('anyway').hidden = true
  const label = t('openFor', info.graceMinutes)
  showFriction($('friction'), info, label, async () => {
    const res = await send('allowTemporarily', { url: target })
    if (res?.ok) goToTarget()
    else load()
  })
})

window.addEventListener('hashchange', () => location.reload())
load()
