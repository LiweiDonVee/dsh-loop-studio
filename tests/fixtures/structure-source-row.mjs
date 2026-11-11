import { readFile } from 'node:fs/promises'

export const name = 'loop-structure-fixture-source-row'
export const inject = ['systemPrompt']

export async function apply(ctx, config) {
  const resource = (await readFile(new URL(config.resource, import.meta.url), 'utf8')).trim()
  ctx.systemPrompt.section({
    name: config.marker,
    order: 410,
    text: config.marker + ' ' + resource,
  })
}
