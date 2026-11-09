import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const selection = value => value && typeof value.provider === 'string' && value.provider.length > 0
  && typeof value.model === 'string' && value.model.length > 0
  && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
  && (value.maxTokens === undefined || Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0)
const same = (a, b) => a && b && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

/** Only tiny ownership receipts are synchronous: the Inbox claim cannot await I/O. */
export function createRoutingJournal({ home = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  directory = join(home, 'app-data', 'loop-studio', 'routing-owners') } = {}) {
  const root = resolve(directory)
  const file = sessionId => join(root, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  return {
    read(session) {
      let receipt
      try { receipt = JSON.parse(readFileSync(file(session.id), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
      const event = session.snapshotEvents().findLast(item => item.type === 'model/selection')
      if (receipt.schemaVersion !== 1 || receipt.sessionId !== session.id || !selection(receipt.baseline)
        || !selection(receipt.selection) || !Number.isSafeInteger(receipt.selectionSeq)
        || receipt.previous && (!selection(receipt.previous.selection) || !Number.isSafeInteger(receipt.previous.selectionSeq))) throw new Error('Invalid Loop Studio route ownership receipt.')
      const matched = [receipt, receipt.previous].find(candidate => candidate && event?.seq === candidate.selectionSeq && same(event.data, candidate.selection))
      return matched ? { ...receipt, selection: matched.selection, selectionSeq: matched.selectionSeq } : null
    },
    write(receipt) {
      if (receipt.schemaVersion !== 1 || typeof receipt.sessionId !== 'string' || !selection(receipt.baseline)
        || !selection(receipt.selection) || !Number.isSafeInteger(receipt.selectionSeq)
        || receipt.previous && (!selection(receipt.previous.selection) || !Number.isSafeInteger(receipt.previous.selectionSeq))) throw new Error('Invalid Loop Studio route ownership receipt.')
      mkdirSync(root, { recursive: true })
      const target = file(receipt.sessionId), temporary = `${target}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify(receipt) + '\n', { encoding: 'utf8', flag: 'wx' })
        renameSync(temporary, target)
      } catch (error) {
        try { unlinkSync(temporary) } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup]) }
        throw error
      }
    },
    clear(sessionId) {
      try { unlinkSync(file(sessionId)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    },
  }
}
