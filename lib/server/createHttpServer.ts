import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
// @ts-ignore
import runFrameStandaloneBundleContent from "@tscircuit/runframe/standalone" with {
  type: "text",
}
import { getNodeHandler } from "winterspec/adapters/node"
import pkg from "../../package.json"

// @ts-ignore
import winterspecBundle from "@tscircuit/file-server/dist/bundle.js"
import { createLocalCacheEngine } from "../shared/get-platform-config-with-cli-defaults"
import { getIndex } from "../site/getIndex"
import {
  buildProjectEvalWorker,
  PROJECT_EVAL_WORKER_PATH,
} from "./build-project-eval-worker"
import { createKicadPcmProxy } from "./kicad-pcm-proxy"

const RUNFRAME_CACHE_PATH = "/api/cache"

const readRequestBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

export const createHttpServer = async ({
  port = 3020,
  defaultMainComponentPath,
  kicadPcm,
  projectDir,
  entryFile,
}: {
  port?: number
  defaultMainComponentPath?: string
  kicadPcm?: boolean
  projectDir?: string
  entryFile?: string
}) => {
  const explicitStandalonePath = process.env.RUNFRAME_STANDALONE_FILE_PATH
  const projectBrowserRuntime =
    !explicitStandalonePath && projectDir
      ? await buildProjectEvalWorker(projectDir)
      : undefined
  const fileServerHandler = getNodeHandler(winterspecBundle as any, {})
  const localCacheEngine = projectDir
    ? createLocalCacheEngine(path.join(projectDir, ".tscircuit", "cache"))
    : undefined

  // Create PCM proxy if enabled
  const pcmProxy =
    kicadPcm && projectDir && entryFile
      ? createKicadPcmProxy({ projectDir, entryFile, port })
      : null

  const server = http.createServer(async (req, res) => {
    const requestHost = req.headers.host ?? `localhost:${port}`
    const url = new URL(req.url!, `http://${requestHost}`)

    if (url.pathname === RUNFRAME_CACHE_PATH) {
      const key = url.searchParams.get("key")
      if (!localCacheEngine || !key) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("A project directory and cache key are required")
        return
      }

      if (req.method === "GET") {
        const value = await localCacheEngine.getItem(key)
        if (value === null) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        })
        res.end(value)
        return
      }

      if (req.method === "POST") {
        await localCacheEngine.setItem(key, await readRequestBody(req))
        res.writeHead(204)
        res.end()
        return
      }

      res.writeHead(405, { Allow: "GET, POST" })
      res.end()
      return
    }

    if (
      url.pathname === "/api/files/upsert-multipart" &&
      req.method === "POST"
    ) {
      try {
        const request = new Request(url.toString(), {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: req as unknown as BodyInit,
          duplex: "half",
        } as RequestInit)

        const formData = await request.formData()
        const filePath = formData.get("file_path")?.toString()
        const initiator = formData.get("initiator")?.toString()
        const binaryFile = formData.get("binary_file")

        if (!filePath || !(binaryFile instanceof Blob)) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              error:
                "Missing required multipart fields: file_path, binary_file",
            }),
          )
          return
        }

        const binaryContentB64 = Buffer.from(
          await binaryFile.arrayBuffer(),
        ).toString("base64")

        const upstreamResponse = await fetch(
          `http://${requestHost}/api/files/upsert`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              file_path: filePath,
              initiator,
              binary_content_b64: binaryContentB64,
            }),
          },
        )

        const responseText = await upstreamResponse.text()
        res.writeHead(upstreamResponse.status, {
          "Content-Type":
            upstreamResponse.headers.get("content-type") ?? "application/json",
        })
        res.end(responseText)
        return
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error_code: "MULTIPART_UPLOAD_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Failed to process multipart upload",
          }),
        )
        return
      }
    }

    if (url.pathname === "/standalone.min.js") {
      if (!explicitStandalonePath) {
        if (projectBrowserRuntime) {
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          })
          res.end(projectBrowserRuntime.standaloneBundle)
          return
        }

        // Otherwise use the bundle from the globally installed tscircuit (the one
        // that provides the `tsci` binary, set by tscircuit's cli.mjs).
        const globalStandalonePath =
          process.env.TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH
        if (globalStandalonePath) {
          try {
            const content = fs.readFileSync(globalStandalonePath, "utf8")
            res.writeHead(200, {
              "Content-Type": "application/javascript; charset=utf-8",
            })
            res.end(content)
            return
          } catch {
            // fall back to the CLI-bundled runframe standalone below
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
        })
        res.end(runFrameStandaloneBundleContent)
        return
      }

      try {
        const content = fs.readFileSync(explicitStandalonePath, "utf8")
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
        })
        res.end(content)
        return
      } catch (error) {
        console.info(
          "Local runframe standalone not found, falling back to the production version.",
        )
      }

      res.writeHead(302, {
        Location: `https://cdn.jsdelivr.net/npm/@tscircuit/runframe@${{ ...pkg.devDependencies }["@tscircuit/runframe"].replace(/^[^0-9]+/, "")}/dist/standalone.min.js`,
      })
      res.end()
      return
    }

    if (url.pathname === PROJECT_EVAL_WORKER_PATH) {
      if (!projectBrowserRuntime) {
        res.writeHead(404)
        res.end("Project eval worker not available")
        return
      }
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      })
      res.end(projectBrowserRuntime.workerBundle)
      return
    }

    if (url.pathname === "/") {
      const fileServerApiBaseUrl = `http://${req.headers.host}/api`
      const html = await getIndex(
        defaultMainComponentPath,
        fileServerApiBaseUrl,
      )
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(html)
      return
    }

    // Handle PCM proxy requests
    if (pcmProxy && url.pathname.startsWith("/pcm")) {
      await pcmProxy.handleRequest(url, res)
      return
    }

    if (url.pathname.startsWith("/api/")) {
      req.url = req.url!.replace("/api/", "/")
      fileServerHandler(req, res)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  return new Promise<{ server: http.Server }>((resolve) => {
    server.listen(port, () => {
      resolve({ server })
    })
  })
}
