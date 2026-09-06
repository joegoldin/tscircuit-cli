export type ReactElementFactory = (
  type: any,
  props: Record<string, unknown>,
) => unknown

type WorkerMessageListener = (event: MessageEvent) => void
type WorkerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface WorkerFetchProxyScope {
  fetch: WorkerFetch
  addEventListener(type: "message", listener: WorkerMessageListener): void
  postMessage(message: unknown): void
  __DISABLE_CDN_LOADING__?: boolean
}

type DeserializeReactElement = (
  serialized: unknown,
  createElement: ReactElementFactory,
) => unknown

type InstallWorkerFetchProxy = (scope: WorkerFetchProxyScope) => void

const deserializeReactElementSource = `
function deserializeReactElement(serialized, createElement) {
  if (!serialized || typeof serialized !== "object") return serialized
  if (
    !("__isSerializedReactElement" in serialized) ||
    serialized.__isSerializedReactElement !== true ||
    !("type" in serialized)
  ) {
    return serialized
  }

  const props = "props" in serialized ? serialized.props : undefined
  if (!props || typeof props !== "object") {
    return createElement(serialized.type, {})
  }

  const deserializedProps = {}
  for (const [key, value] of Object.entries(props)) {
    if (key !== "children") {
      deserializedProps[key] = value
      continue
    }
    deserializedProps.children = Array.isArray(value)
      ? value.map((child) => deserializeReactElement(child, createElement))
      : deserializeReactElement(value, createElement)
  }
  return createElement(serialized.type, deserializedProps)
}
`

const installWorkerFetchProxySource = `
function installWorkerFetchProxy(scope) {
  function headersToRecord(headers) {
    const result = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }

  const pendingRequests = new Map()
  let requestCounter = 0

  function fetchProxy(input, init) {
    const requestId = ++requestCounter
    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject })
      let url
      let requestInit = init ? { ...init } : {}

      if (typeof input === "string" || input instanceof URL) {
        url = input.toString()
      } else {
        url = input.url
        requestInit = {
          ...requestInit,
          method: input.method,
          headers: headersToRecord(input.headers),
          body: input.bodyUsed ? undefined : input.body,
        }
      }

      if (requestInit.headers instanceof Headers) {
        requestInit.headers = headersToRecord(requestInit.headers)
      }

      scope.postMessage({
        type: "worker_fetch",
        requestId,
        input: url,
        init: requestInit,
      })
    })
  }

  scope.addEventListener("message", (event) => {
    const data = event.data
    if (!data || typeof data !== "object" || !("type" in data)) return

    if (data.type === "override_global_fetch") {
      scope.fetch = fetchProxy
      return
    }
    if (
      data.type === "disable_cdn_loading" &&
      "value" in data &&
      typeof data.value === "boolean"
    ) {
      scope.__DISABLE_CDN_LOADING__ = data.value
      return
    }
    if (
      data.type !== "worker_fetch_result" ||
      !("requestId" in data) ||
      typeof data.requestId !== "number" ||
      !("success" in data) ||
      typeof data.success !== "boolean"
    ) {
      return
    }

    const handlers = pendingRequests.get(data.requestId)
    if (!handlers) return
    pendingRequests.delete(data.requestId)

    if (
      data.success &&
      "response" in data &&
      data.response &&
      typeof data.response === "object" &&
      "body" in data.response &&
      "status" in data.response &&
      typeof data.response.status === "number" &&
      "statusText" in data.response &&
      typeof data.response.statusText === "string" &&
      "headers" in data.response
    ) {
      handlers.resolve(
        new Response(data.response.body, {
          status: data.response.status,
          statusText: data.response.statusText,
          headers: data.response.headers,
        }),
      )
      return
    }

    if (
      !("error" in data) ||
      !data.error ||
      typeof data.error !== "object" ||
      !("message" in data.error) ||
      typeof data.error.message !== "string"
    ) {
      handlers.reject(new Error("Worker fetch failed without an error message"))
      return
    }
    const error = new Error(data.error.message)
    if ("name" in data.error && typeof data.error.name === "string") {
      error.name = data.error.name
    }
    if ("stack" in data.error && typeof data.error.stack === "string") {
      error.stack = data.error.stack
    }
    handlers.reject(error)
  })
}
`

export const deserializeReactElement = Function(
  `"use strict"; return (${deserializeReactElementSource})`,
)() as DeserializeReactElement

export const installWorkerFetchProxy = Function(
  `"use strict"; return (${installWorkerFetchProxySource})`,
)() as InstallWorkerFetchProxy

export const getProjectEvalWorkerBoundarySource = (): string => `
const deserializeReactElement = (${deserializeReactElementSource})
const installWorkerFetchProxy = (${installWorkerFetchProxySource})
`
