'use strict'

// Burg Focus: Warden Gerrit ("Cipier Gerrit" in Dutch), the guard who checks
// during a focus round whether you are still at it. Modes, lines and helpers
// shared by the service worker, the popup, the block page and the guard window.

const GUARD_NAME = t('guardName')

// Mode ids are Dutch: mild, streng (strict), gek (crazy).
// idleSec: sitting still this long (no mouse/keys, no sound) = check.
// rollCall: random roll call between [min, max] minutes, or null.
// offsiteMin: this long in a row on a non-work site = check (0 = never).
// answerSec: time you get to report in. code: retype your prisoner number.
const GUARD_MODES = {
  mild: { label: t('modeMild'), idleSec: 300, rollCall: null, offsiteMin: 0, answerSec: 90, code: false },
  streng: { label: t('modeStrict'), idleSec: 180, rollCall: [15, 30], offsiteMin: 10, answerSec: 60, code: false },
  gek: { label: t('modeCrazy'), idleSec: 90, rollCall: [6, 14], offsiteMin: 5, answerSec: 30, code: true }
}

const PENALTY_MINUTES = 2

// Message keys per kind of line (texts in _locales/*/messages.json).
// {nr}, {sec}, {idle}, {host}, {min} and {strikes} are filled in by fillLine().
const GUARD_LINES = {
  appel: ['gAppel1', 'gAppel2', 'gAppel3', 'gAppel4', 'gAppel5', 'gAppel6', 'gAppel7', 'gAppel8'],
  idle: ['gIdle1', 'gIdle2', 'gIdle3', 'gIdle4', 'gIdle5'],
  offsite: ['gOffsite1', 'gOffsite2', 'gOffsite3', 'gOffsite4'],
  ok: ['gOk1', 'gOk2', 'gOk3', 'gOk4', 'gOk5'],
  late: ['gLate1', 'gLate2', 'gLate3', 'gLate4'],
  wrong: ['gWrong1', 'gWrong2'],
  escape: ['gEscape1', 'gEscape2', 'gEscape3', 'gEscape4'],
  lawyer: ['gLawyer1', 'gLawyer2', 'gLawyer3']
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function fillLine(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

function guardLine(kind, vars) {
  return fillLine(GUARD_LINES[kind] ? t(pick(GUARD_LINES[kind])) : '…', vars)
}

// Verdict at the end of a round.
function guardVerdict({ calls = 0, strikes = 0, escapes = 0 }) {
  const tally = `${plural(calls, 'nRollCalls')}, ${plural(strikes, 'nStrikes')}${escapes ? `, ${plural(escapes, 'nEscapes')}` : ''}`
  const bad = strikes + escapes
  const remark =
    bad === 0 ? (calls ? t('verdictPerfect') : t('verdictQuiet')) : bad <= 2 ? t('verdictSome') : t('verdictBad')
  return `${tally}. ${remark}`
}
