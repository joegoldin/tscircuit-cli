import { expect, test } from "bun:test"
import {
  deserializeReactElement,
  installWorkerFetchProxy,
} from "lib/server/project-eval-worker-boundary"
import type { WorkerFetchProxyScope } from "lib/server/project-eval-worker-boundary"

test("deserializes nested React elements before executeComponent", () => {
  const createElement = (
    type: string,
    props: Record<string, unknown>,
  ): Record<string, unknown> => ({ type, props })

  expect(
    deserializeReactElement(
      {
        __isSerializedReactElement: true,
        type: "board",
        props: {
          children: [
            {
              __isSerializedReactElement: true,
              type: "resistor",
              props: { resistance: "1k" },
            },
          ],
        },
      },
      createElement,
    ),
  ).toEqual({
    type: "board",
    props: {
      children: [{ type: "resistor", props: { resistance: "1k" } }],
    },
  })
})

test("preserves the worker fetch-proxy request and response contract", async () => {
  let messageListener: ((event: MessageEvent) => void) | undefined
  const postedMessages: unknown[] = []
  const workerScope: WorkerFetchProxyScope = {
    fetch: globalThis.fetch,
    addEventListener(_name: "message", listener: (event: MessageEvent) => void) {
      messageListener = listener
    },
    postMessage(message: unknown) {
      postedMessages.push(message)
    },
  }

  installWorkerFetchProxy(workerScope)
  messageListener?.({ data: { type: "override_global_fetch" } } as MessageEvent)
  messageListener?.({
    data: { type: "disable_cdn_loading", value: true },
  } as MessageEvent)
  expect(workerScope.__DISABLE_CDN_LOADING__).toBe(true)
  const responsePromise = workerScope.fetch("https://parts.test/item", {
    headers: new Headers({ Accept: "application/json" }),
  })
  expect(postedMessages).toEqual([
    {
      type: "worker_fetch",
      requestId: 1,
      input: "https://parts.test/item",
      init: { headers: { accept: "application/json" } },
    },
  ])

  messageListener?.({
    data: {
      type: "worker_fetch_result",
      requestId: 1,
      success: true,
      response: {
        body: '{"ok":true}',
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      },
    },
  } as MessageEvent)

  const response = await responsePromise
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })

  const failedResponse = workerScope.fetch("https://parts.test/failure")
  messageListener?.({
    data: {
      type: "worker_fetch_result",
      requestId: 2,
      success: false,
      error: {
        name: "TypeError",
        message: "proxy unavailable",
        stack: "proxy stack",
      },
    },
  } as MessageEvent)
  await expect(failedResponse).rejects.toMatchObject({
    name: "TypeError",
    message: "proxy unavailable",
    stack: "proxy stack",
  })
})
