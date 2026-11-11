import { isDeepStrictEqual } from 'node:util'

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const identity = value => typeof value === 'string' && value.trim().length > 0
export const presetIdFor = id => `loop-studio.${id}`
export const isGroup = row => row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group'

/** The native !!js codec uses plain data; neither validation nor persistence runs it. */
export function detachedJson(value) {
  const copy = JSON.parse(JSON.stringify(value))
  if (!isDeepStrictEqual(copy, value)) throw new Error('Expected lossless JSON data.')
  return copy
}

export function validateStructureDocument(input, { assignIds = false, protectedId, protectedModule } = {}) {
  const issues = []
  const add = (code, message, field, rowId) => issues.push({ severity: 'error', code, message, field, ...(rowId === undefined ? {} : { rowId }) })
  if (!record(input) || Object.keys(input).some(key => !['name', 'description', 'rows', 'execution'].includes(key))) {
    add('invalid-document', 'A name and an ordered list of plugin rows are required.', 'document')
    return { issues }
  }
  const { name, description = '', execution } = input
  if (!identity(name) || name.length > 256) add('invalid-name', 'Enter a preset name of up to 256 characters.', 'name')
  if (typeof description !== 'string') add('invalid-description', 'The description must be text.', 'description')
  let rows
  try { rows = detachedJson(input.rows) } catch { add('invalid-rows', 'Plugin rows must contain lossless JSON data.', 'rows'); return { issues } }
  if (!Array.isArray(rows)) {
    add('invalid-rows', 'The composition must be an ordered list of plugin rows.', 'rows')
    return { issues }
  }
  const ids = new Set()
  const missingIds = []
  const lists = [rows]
  while (lists.length) {
    for (const row of lists.pop()) {
      if (!record(row)) {
        add('invalid-row', 'Each plugin row must be an object.', 'rows')
        continue
      }
      const id = identity(row.id) ? row.id : undefined
      if (id === undefined) {
        if (assignIds && (row.id === undefined || row.id === null || row.id === '')) missingIds.push(row)
        else add('invalid-row-id', 'Each plugin row needs a stable ID.', 'id')
      } else {
        if (ids.has(id)) add('duplicate-row-id', 'Plugin row IDs must be unique within the preset.', 'id', id)
        if (id === protectedId) add('reserved-row-id', 'This row ID belongs to the published execution adapter.', 'id', id)
        ids.add(id)
      }
      if (!identity(row.name)) add('invalid-module', 'Each plugin row needs a module name.', 'name', id)
      if (row.name === 'dsh-loop-studio/execution' || (protectedModule !== undefined && row.name === protectedModule)) {
        add('reserved-module', 'The execution adapter is supplied by the published execution graph.', 'name', id)
      }
      if (row.group !== undefined && typeof row.group !== 'boolean') add('invalid-group', 'The group field must be true or false.', 'group', id)
      if (row.disabled != null && typeof row.disabled !== 'boolean'
        && !(record(row.disabled) && typeof row.disabled.__jsExpr === 'string' && Object.keys(row.disabled).length === 1)) {
        add('invalid-disabled', 'Use true, false, or a native JavaScript expression for the disabled field.', 'disabled', id)
      }
      if (row.inject != null && !(record(row.inject) || (Array.isArray(row.inject) && row.inject.every(identity)))) {
        add('invalid-inject', 'Inject must be a list of service names or a service map.', 'inject', id)
      }
      if (row.isolate != null && !record(row.isolate)) add('invalid-isolate', 'Isolate must be a service map.', 'isolate', id)
      if (row.intercept != null && !record(row.intercept)) add('invalid-intercept', 'Intercept must be a service map.', 'intercept', id)
      if (isGroup(row)) {
        if (Array.isArray(row.config)) lists.push(row.config)
        else add('invalid-group-rows', 'A group requires an ordered list of child rows.', 'config', id)
      }
    }
  }
  let sequence = 0
  for (const row of missingIds) {
    do { row.id = `row-${++sequence}` } while (ids.has(row.id))
    ids.add(row.id)
  }
  return { issues, document: { name, description, rows, ...(execution === undefined ? {} : { execution }) } }
}
