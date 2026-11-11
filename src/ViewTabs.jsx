import React from 'react'

export function ViewTabs({ id, label, options, active, className, onChange }) {
  function onKeyDown(event) {
    const index = options.findIndex(option => option.id === active)
    let nextIndex
    if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = options.length - 1
    else if (event.key === 'ArrowLeft') nextIndex = (index + options.length - 1) % options.length
    else if (event.key === 'ArrowRight') nextIndex = (index + 1) % options.length
    else return
    event.preventDefault()
    onChange(options[nextIndex].id)
    event.currentTarget.children[nextIndex]?.focus()
  }

  return <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
    {options.map(option => <button key={option.id} type="button" role="tab"
      id={`${id}-${option.id}`} aria-controls={`${id}-${option.id}-panel`} aria-selected={active === option.id}
      tabIndex={active === option.id ? 0 : -1} onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>
}
