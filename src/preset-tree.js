export function isGroup(row) {
  return row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group'
}

export function childRows(row) {
  return isGroup(row) && Array.isArray(row.config) ? row.config : []
}

export function indexRows(rows, parent = null, result = []) {
  rows.forEach((row, index) => {
    const entry = { row, index, parent, siblings: rows.length }
    result.push(entry)
    indexRows(childRows(row), entry, result)
  })
  return result
}

export function hasAncestor(entry, id) {
  for (let parent = entry.parent; parent; parent = parent.parent) {
    if (parent.row.id === id) return true
  }
  return false
}

export function editRows(rows, parentId, edit) {
  if (parentId === null) return edit(rows)
  const next = rows.map(row => {
    if (!isGroup(row)) return row
    const children = childRows(row)
    const updated = row.id === parentId ? edit(children) : editRows(children, parentId, edit)
    return children === updated ? row : { ...row, config: updated }
  })
  return next.some((row, index) => row !== rows[index]) ? next : rows
}

export function replaceRow(rows, entry, nextRow) {
  return editRows(rows, entry.parent?.row.id ?? null, siblings => siblings.map(row => row.id === entry.row.id ? nextRow : row))
}

export function removeRow(rows, entry) {
  return editRows(rows, entry.parent?.row.id ?? null, siblings => siblings.filter(row => row.id !== entry.row.id))
}

export function insertRow(rows, parentId, row, position) {
  return editRows(rows, parentId, siblings => {
    const next = siblings.slice()
    next.splice(position ?? siblings.length, 0, row)
    return next
  })
}

export function reorderRow(rows, entry, direction) {
  const position = entry.index + direction
  if (position < 0 || position >= entry.siblings) return rows
  return editRows(rows, entry.parent?.row.id ?? null, siblings => {
    const next = siblings.slice()
    const [row] = next.splice(entry.index, 1)
    next.splice(position, 0, row)
    return next
  })
}

export function uniqueRowId(taken, base) {
  let id = base
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`
  taken.add(id)
  return id
}

export function duplicateRow(row, taken) {
  const id = uniqueRowId(taken, `${row.id}-copy`)
  return isGroup(row)
    ? { ...row, id, config: childRows(row).map(child => duplicateRow(child, taken)) }
    : { ...row, id }
}

export function disabledMode(row) {
  if (row.disabled === true) return 'disabled'
  if (row.disabled == null || row.disabled === false) return 'enabled'
  return typeof row.disabled?.__jsExpr === 'string' ? 'conditional' : 'custom'
}

export function equalJson(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key]))
}

function rowFields(row) {
  const { id: _id, config, ...fields } = row
  return isGroup(row) ? fields : { ...fields, config }
}

function siblingOrder(entries, otherIndex) {
  const byParent = new Map()
  for (const entry of entries) {
    const parentId = entry.parent?.row.id ?? null
    const other = otherIndex.get(entry.row.id)
    if (!other || (other.parent?.row.id ?? null) !== parentId) continue
    if (!byParent.has(parentId)) byParent.set(parentId, [])
    byParent.get(parentId).push(entry.row.id)
  }
  return byParent
}

export function compareDocuments(base, draft) {
  const oldRows = indexRows(base.rows)
  const newRows = indexRows(draft.rows)
  const oldIndex = new Map(oldRows.map(entry => [entry.row.id, entry]))
  const newIndex = new Map(newRows.map(entry => [entry.row.id, entry]))
  const previousOrder = siblingOrder(oldRows, newIndex)
  const nextOrder = siblingOrder(newRows, oldIndex)
  return {
    added: newRows.filter(entry => !oldIndex.has(entry.row.id)).map(entry => entry.row),
    removed: oldRows.filter(entry => !newIndex.has(entry.row.id)).map(entry => entry.row),
    changed: newRows.filter(entry => {
      const previous = oldIndex.get(entry.row.id)
      return previous && !equalJson(rowFields(previous.row), rowFields(entry.row))
    }).map(entry => entry.row),
    moved: newRows.filter(entry => {
      const previous = oldIndex.get(entry.row.id)
      return previous && previous.parent?.row.id !== entry.parent?.row.id
    }).map(entry => entry.row),
    reordered: [...nextOrder.entries()].filter(([parentId, order]) => !equalJson(previousOrder.get(parentId), order))
      .map(([parentId]) => parentId ?? '顶层'),
    metadata: base.name !== draft.name || base.description !== draft.description,
  }
}
