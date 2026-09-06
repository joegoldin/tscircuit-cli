import { expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DevServer } from "cli/dev/DevServer"
import getPort from "get-port"
import { createLocalCacheEngine } from "lib/shared/get-platform-config-with-cli-defaults"
import { getCliTestFixture } from "../../fixtures/get-cli-test-fixture"

const LOCAL_BUNDLE = "LOCAL_TSCIRCUIT_BUNDLE_SENTINEL"
const GLOBAL_BUNDLE = "GLOBAL_TSCIRCUIT_BUNDLE_SENTINEL"
const LOCAL_RUNFRAME = "LOCAL_RUNFRAME_BUNDLE_SENTINEL"
const LOCAL_CORE = "LOCAL_PROJECT_CORE_SENTINEL"

const writeProject = async (projectDir: string): Promise<void> => {
  await writeFile(
    join(projectDir, "index.tsx"),
    'export default () => <board width="10mm" height="10mm" />\n',
  )
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "test-project", version: "1.0.0" }),
  )
}

const installLocalTscircuit = async (
  projectDir: string,
  bundle: string,
): Promise<void> => {
  const tscircuitDir = join(projectDir, "node_modules", "tscircuit")
  await mkdir(join(tscircuitDir, "dist"), { recursive: true })
  await writeFile(
    join(tscircuitDir, "package.json"),
    JSON.stringify({
      name: "tscircuit",
      version: "0.0.999-local",
      exports: {
        ".": "./dist/index.js",
        "./browser": "./dist/browser.min.js",
      },
    }),
  )
  await writeFile(join(tscircuitDir, "dist", "index.js"), "export {}")
  await writeFile(join(tscircuitDir, "dist", "browser.min.js"), bundle)
}

const installPackage = async ({
  projectDir,
  packageName,
  packageJson,
  files,
}: {
  projectDir: string
  packageName: string
  packageJson: Record<string, unknown>
  files: Record<string, string>
}): Promise<void> => {
  const packageDir = join(projectDir, "node_modules", packageName)
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0-test", ...packageJson }),
  )
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(packageDir, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, contents)
  }
}

const installLocalBrowserRuntime = async (
  projectDir: string,
): Promise<void> => {
  await installLocalTscircuit(projectDir, LOCAL_BUNDLE)
  const runtimeDir = join(projectDir, "node_modules", "tscircuit")
  await installPackage({
    projectDir: runtimeDir,
    packageName: "@tscircuit/runframe",
    packageJson: { exports: { "./standalone": "./standalone.js" } },
    files: {
      "standalone.js": `${LOCAL_RUNFRAME};const worker="<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"`,
    },
  })
  await installPackage({
    projectDir: runtimeDir,
    packageName: "@tscircuit/core",
    packageJson: { type: "module", exports: { ".": "./index.js" } },
    files: { "index.js": `export const coreMarker = "${LOCAL_CORE}"` },
  })
  await installPackage({
    projectDir: runtimeDir,
    packageName: "@tscircuit/eval",
    packageJson: {
      type: "module",
      exports: { "./eval": { import: "./eval.js" } },
    },
    files: {
      "eval.js": `
        import { coreMarker } from "@tscircuit/core"
        export class CircuitRunner {
          constructor() { this.coreMarker = coreMarker }
          executeComponent(component) { return component }
        }
      `,
    },
  })
  await installPackage({
    projectDir: runtimeDir,
    packageName: "comlink",
    packageJson: { type: "module", exports: { ".": "./index.js" } },
    files: { "index.js": "export const expose = value => { globalThis.exposed = value }" },
  })
  await installPackage({
    projectDir: runtimeDir,
    packageName: "react",
    packageJson: { type: "module", exports: { ".": "./index.js" } },
    files: {
      "index.js": `
        /*! PROJECT_REACT_LITERAL_COMMENT: process.env.NODE_ENV */
        export const createElement = (type, props) => ({
          type,
          props,
          literalEnvironmentExpression: 'process.env.NODE_ENV',
          runtimeMode:
            process.env.NODE_ENV === "production"
              ? "PROJECT_REACT_PRODUCTION_SENTINEL"
              : "PROJECT_REACT_DEVELOPMENT_SENTINEL",
        })
      `,
    },
  })

  for (const packageName of [
    "rollup",
    "@rollup/plugin-commonjs",
    "@rollup/plugin-json",
    "@rollup/plugin-node-resolve",
  ]) {
    const target = join(process.cwd(), "node_modules", packageName)
    const link = join(runtimeDir, "node_modules", packageName)
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, "dir")
  }
}

const fetchDevAsset = async (
  projectDir: string,
  assetPath: string,
): Promise<{ headers: Headers; status: number; text: string }> => {
  const port = await getPort()
  const devServer = new DevServer({
    port,
    componentFilePath: join(projectDir, "index.tsx"),
    projectDir,
  })
  try {
    await devServer.start()
    const response = await fetch(`http://localhost:${port}${assetPath}`)
    return {
      headers: response.headers,
      status: response.status,
      text: await response.text(),
    }
  } finally {
    await devServer.stop()
  }
}

test("dev server injects a project eval worker instead of serving the stale project browser bundle", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalBrowserRuntime(tmpDir)

  const globalBundlePath = join(tmpDir, "global-browser.min.js")
  await writeFile(globalBundlePath, GLOBAL_BUNDLE)
  process.env.TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH = globalBundlePath

  try {
    const standalone = (await fetchDevAsset(tmpDir, "/standalone.min.js")).text
    expect(standalone).not.toContain(LOCAL_BUNDLE)
    expect(standalone).toContain(LOCAL_RUNFRAME)
    expect(standalone).toContain("/eval-webworker.js")

    const worker = await fetchDevAsset(tmpDir, "/eval-webworker.js")
    expect(worker.status).toBe(200)
    expect(worker.headers.get("content-type")).toContain(
      "application/javascript",
    )
    expect(worker.text).toContain(LOCAL_CORE)
    expect(worker.text).toContain("ProjectCircuitRunner")
    expect(worker.text).toContain("deserializeReactElement")
    expect(worker.text).toContain("worker_fetch")
    expect(worker.text).toContain("process.env.NODE_ENV")
    expect(worker.text).toContain(
      "PROJECT_REACT_LITERAL_COMMENT: process.env.NODE_ENV",
    )
    expect(worker.text).toContain("PROJECT_REACT_PRODUCTION_SENTINEL")
    expect(worker.text).not.toContain("PROJECT_REACT_DEVELOPMENT_SENTINEL")
  } finally {
    process.env.TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH = undefined
  }
}, 30_000)

/**
 * When the project has no local tscircuit, the dev server serves the bundle from
 * the tscircuit that provides the `tsci` binary, exposed via
 * TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH (set by tscircuit's cli.mjs).
 */
test("dev server falls back to TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH when no local tscircuit", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)

  const globalBundlePath = join(tmpDir, "global-browser.min.js")
  await writeFile(globalBundlePath, GLOBAL_BUNDLE)
  process.env.TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH = globalBundlePath

  try {
    expect((await fetchDevAsset(tmpDir, "/standalone.min.js")).text).toBe(
      GLOBAL_BUNDLE,
    )
  } finally {
    process.env.TSCIRCUIT_GLOBAL_STANDALONE_FILE_PATH = undefined
  }
}, 30_000)

test("explicit standalone override does not build or replace the project runtime", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalTscircuit(tmpDir, LOCAL_BUNDLE)

  const explicitBundlePath = join(tmpDir, "explicit-standalone.min.js")
  await writeFile(explicitBundlePath, "EXPLICIT_STANDALONE_SENTINEL")
  process.env.RUNFRAME_STANDALONE_FILE_PATH = explicitBundlePath

  try {
    expect((await fetchDevAsset(tmpDir, "/standalone.min.js")).text).toBe(
      "EXPLICIT_STANDALONE_SENTINEL",
    )
    expect((await fetchDevAsset(tmpDir, "/eval-webworker.js")).status).toBe(
      404,
    )
  } finally {
    process.env.RUNFRAME_STANDALONE_FILE_PATH = undefined
  }
}, 30_000)

test("a broken detected project runtime fails startup with its missing package", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalTscircuit(tmpDir, LOCAL_BUNDLE)

  const devServer = new DevServer({
    port: await getPort(),
    componentFilePath: join(tmpDir, "index.tsx"),
    projectDir: tmpDir,
  })

  await expect(devServer.start()).rejects.toThrow(
    /Failed to build project browser runtime.*@tscircuit\/runframe\/standalone/s,
  )
})

test("an installed tscircuit with a broken browser export fails instead of falling back", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalTscircuit(tmpDir, LOCAL_BUNDLE)
  await writeFile(
    join(tmpDir, "node_modules", "tscircuit", "package.json"),
    JSON.stringify({
      name: "tscircuit",
      version: "0.0.999-local",
      exports: { ".": "./dist/index.js" },
    }),
  )

  const devServer = new DevServer({
    port: await getPort(),
    componentFilePath: join(tmpDir, "index.tsx"),
    projectDir: tmpDir,
  })

  await expect(devServer.start()).rejects.toThrow(/tscircuit\/browser/)
})

test("an unresolved project eval export fails instead of producing a stock-core fallback", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalBrowserRuntime(tmpDir)
  await writeFile(
    join(
      tmpDir,
      "node_modules",
      "tscircuit",
      "node_modules",
      "@tscircuit",
      "eval",
      "package.json",
    ),
    JSON.stringify({
      name: "@tscircuit/eval",
      version: "0.0.0-test",
      type: "module",
      exports: {},
    }),
  )

  const devServer = new DevServer({
    port: await getPort(),
    componentFilePath: join(tmpDir, "index.tsx"),
    projectDir: tmpDir,
  })

  await expect(devServer.start()).rejects.toThrow(/@tscircuit\/eval\/eval/)
})

test("an unresolved dynamic worker import fails instead of reaching the browser", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalBrowserRuntime(tmpDir)
  await writeFile(
    join(
      tmpDir,
      "node_modules",
      "tscircuit",
      "node_modules",
      "@tscircuit",
      "eval",
      "eval.js",
    ),
    `
      import { coreMarker } from "@tscircuit/core"
      export class CircuitRunner {
        constructor() {
          this.coreMarker = coreMarker
          this.loadMissingRuntime = () => import("missing-worker-runtime")
        }
        executeComponent(component) { return component }
      }
    `,
  )

  const devServer = new DevServer({
    port: await getPort(),
    componentFilePath: join(tmpDir, "index.tsx"),
    projectDir: tmpDir,
  })

  await expect(devServer.start()).rejects.toThrow(
    /unresolved dynamic imports: missing-worker-runtime/,
  )
})

test("RunFrame's cache API reads and writes the CLI project cache", async () => {
  const { tmpDir } = await getCliTestFixture()
  await writeProject(tmpDir)
  await installLocalBrowserRuntime(tmpDir)

  const port = await getPort()
  const devServer = new DevServer({
    port,
    componentFilePath: join(tmpDir, "index.tsx"),
    projectDir: tmpDir,
  })

  try {
    await devServer.start()
    const origin = `http://localhost:${port}`
    const cache = createLocalCacheEngine(join(tmpDir, ".tscircuit", "cache"))
    cache.setItem("written-by-cli", '{"source":"cli"}')

    const cliValue = await fetch(`${origin}/api/cache?key=written-by-cli`).then(
      (res) => res.text(),
    )
    expect(cliValue).toBe('{"source":"cli"}')

    await fetch(`${origin}/api/cache?key=written-by-runframe`, {
      method: "POST",
      body: '{"source":"runframe"}',
    })
    expect(cache.getItem("written-by-runframe")).toBe('{"source":"runframe"}')
  } finally {
    await devServer.stop()
  }
}, 30_000)
