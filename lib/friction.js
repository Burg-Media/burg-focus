'use strict'

// Burg Focus: a hurdle before you turn something off or continue anyway.
// friction: 'none' | 'wait' (countdown) | 'type' (retype a sentence, pasting is not allowed)
//
// Draws the hurdle in `box` and calls onPass() once you are through.

function showFriction(box, { friction, waitSeconds, phrase }, confirmLabel, onPass) {
  box.replaceChildren()
  box.hidden = false
  const btn = el('button', { class: 'btn primary', type: 'button', text: confirmLabel, onclick: () => onPass() })

  if (friction === 'wait') {
    let left = Math.max(1, Number(waitSeconds) || 30)
    const msg = el('p', { class: 'friction-msg' })
    const render = () => {
      btn.disabled = left > 0
      msg.textContent = left > 0 ? t('frictionBreathe', left) : t('areYouSure')
      btn.textContent = left > 0 ? `${confirmLabel} (${left})` : confirmLabel
    }
    const timer = setInterval(() => {
      left--
      render()
      if (left <= 0) clearInterval(timer)
    }, 1000)
    render()
    box.append(msg, btn)
    return () => clearInterval(timer)
  }

  if (friction === 'type') {
    const want = String(phrase || '').trim()
    const input = el('input', { type: 'text', class: 'friction-input', autocomplete: 'off', spellcheck: false, placeholder: want })
    const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ')
    btn.disabled = true
    input.addEventListener('paste', (e) => e.preventDefault())
    input.addEventListener('drop', (e) => e.preventDefault())
    input.addEventListener('input', () => (btn.disabled = norm(input.value) !== norm(want)))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btn.disabled) onPass()
    })
    box.append(el('p', { class: 'friction-msg' }, t('typeOver') + ' ', el('strong', { text: want })), input, btn)
    input.focus()
    return () => {}
  }

  box.append(btn)
  return () => {}
}
