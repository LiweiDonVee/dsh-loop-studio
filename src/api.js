export function createLoopApi(send = (...args) => globalThis.fetch(...args)) {
  async function request(action, sessionId, input, signal) {
    const response = await send(new URL('api/loop-studio/request', document.baseURI), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ action, sessionId, ...input }),
    })
    let data
    try { data = await response.json() }
    catch { throw new Error('无法读取 Loop Studio 响应，请刷新后重试。') }
    if (data?.error) {
      const error = new Error(data.error.message || 'Loop Studio 请求失败。')
      error.code = data.error.code
      if (Array.isArray(data.error.issues)) error.issues = data.error.issues
      throw error
    }
    if (!response.ok) throw new Error('Loop Studio 请求失败，请刷新后重试。')
    return data
  }
  return {
    inspect: (sessionId, signal) => request('inspect', sessionId, {}, signal),
    savePolicy: (sessionId, input, signal) => request('savePolicy', sessionId, input, signal),
    resetPolicy: (sessionId, input, signal) => request('resetPolicy', sessionId, input, signal),
    listStructures: (sessionId, signal) => request('listStructures', sessionId, {}, signal),
    readStructure: (sessionId, input, signal) => request('readStructure', sessionId, input, signal),
    createStructure: (sessionId, input, signal) => request('createStructure', sessionId, input, signal),
    saveStructure: (sessionId, input, signal) => request('saveStructure', sessionId, input, signal),
    validateStructure: (sessionId, input, signal) => request('validateStructure', sessionId, input, signal),
    publishStructure: (sessionId, input, signal) => request('publishStructure', sessionId, input, signal),
    selectStructure: (sessionId, input, signal) => request('selectStructure', sessionId, input, signal),
    subscribe(sessionId, onEvent, onError) {
      const url = new URL('api/loop-studio/events', document.baseURI)
      url.searchParams.set('sessionId', sessionId)
      const source = new EventSource(url)
      for (const type of ['connected', 'changed']) source.addEventListener(type, event => {
        try {
          const data = JSON.parse(event.data)
          if (data.sessionId === sessionId) onEvent({ ...data, type })
        } catch { /* Ignore incomplete transport frames. */ }
      })
      source.onerror = onError
      return () => source.close()
    },
  }
}
