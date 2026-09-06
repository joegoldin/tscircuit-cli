import * as fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { getProjectEvalWorkerBoundarySource } from "./project-eval-worker-boundary"

export const PROJECT_EVAL_WORKER_PATH = "/eval-webworker.js"

const RUNFRAME_WORKER_PLACEHOLDER =
  "<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"

interface AstNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string" &&
  "start" in value &&
  typeof value.start === "number" &&
  "end" in value &&
  typeof value.end === "number"

const isIdentifier = (node: unknown, name: string): boolean =>
  isAstNode(node) && node.type === "Identifier" && node.name === name

const isMemberExpression = (
  node: unknown,
  objectName: string,
  propertyName: string,
): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.object, objectName) &&
  isIdentifier(node.property, propertyName)

const isNodeEnvExpression = (node: AstNode): boolean =>
  node.type === "MemberExpression" &&
  node.computed === false &&
  isMemberExpression(node.object, "process", "env") &&
  isIdentifier(node.property, "NODE_ENV")

const findNodeEnvExpressionRanges = (
  root: AstNode,
): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = []
  const visited = new WeakSet<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || visited.has(value)) {
      return
    }
    visited.add(value)
    if (isAstNode(value) && isNodeEnvExpression(value)) {
      ranges.push({ start: value.start, end: value.end })
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item)
      } else {
        visit(child)
      }
    }
  }
  visit(root)
  return ranges
}

interface RollupChunk {
  type: "chunk"
  code: string
  imports: string[]
  dynamicImports: string[]
}

interface RollupBuild {
  generate(options: Record<string, unknown>): Promise<{
    output: Array<RollupChunk | { type: "asset" }>
  }>
  close(): Promise<void>
}

interface RollupModule {
  rollup(options: Record<string, unknown>): Promise<RollupBuild>
}

interface RollupPluginModule {
  default?: (...args: unknown[]) => unknown
}

export interface ProjectEvalWorkerRuntime {
  standaloneBundle: string
  workerBundle: string
}

const resolveProjectBrowserPath = (
  projectRequire: NodeJS.Require,
  projectDir: string,
): string | undefined => {
  try {
    return projectRequire.resolve("tscircuit/browser")
  } catch (browserError) {
    const tscircuitIsInstalled =
      projectRequire
        .resolve
        .paths("tscircuit")
        ?.some((nodeModulesPath) =>
          existsSync(path.join(nodeModulesPath, "tscircuit", "package.json")),
        ) ?? false
    if (!tscircuitIsInstalled) return undefined

    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": could not resolve "tscircuit/browser" from the installed project runtime`,
      { cause: browserError },
    )
  }
}

const resolveProjectPackage = (
  projectRequire: NodeJS.Require,
  packageName: string,
  projectDir: string,
): string => {
  try {
    return projectRequire.resolve(packageName)
  } catch (error) {
    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": could not resolve "${packageName}" from the project`,
      { cause: error },
    )
  }
}

const loadProjectPackage = <T>(
  projectRequire: NodeJS.Require,
  packageName: string,
  projectDir: string,
): T => {
  const resolvedPath = resolveProjectPackage(
    projectRequire,
    packageName,
    projectDir,
  )
  try {
    return projectRequire(resolvedPath) as T
  } catch (error) {
    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": could not load "${packageName}" from "${resolvedPath}"`,
      { cause: error },
    )
  }
}

const getDefaultExport = (
  pluginModule: RollupPluginModule | ((...args: unknown[]) => unknown),
  packageName: string,
  projectDir: string,
): ((...args: unknown[]) => unknown) => {
  const pluginFactory =
    typeof pluginModule === "function" ? pluginModule : pluginModule.default
  if (typeof pluginFactory !== "function") {
    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": "${packageName}" does not export a plugin factory`,
    )
  }
  return pluginFactory
}

const createWorkerEntrySource = (): string => `
import * as React from "react"
import { expose } from "comlink"
import { CircuitRunner } from "@tscircuit/eval/eval"

${getProjectEvalWorkerBoundarySource()}

globalThis.React = React
globalThis.global = globalThis.global || globalThis
installWorkerFetchProxy(globalThis)

class ProjectCircuitRunner extends CircuitRunner {
  async executeComponent(component, opts = {}) {
    return super.executeComponent(
      deserializeReactElement(component, React.createElement),
      opts,
    )
  }
}

expose(new ProjectCircuitRunner())
`

const browserEnvironmentPlugin = {
  name: "tscircuit-project-eval-worker-environment",
  transform(
    this: { parse(code: string): AstNode },
    code: string,
  ): { code: string; map: null } | null {
    const ranges = findNodeEnvExpressionRanges(this.parse(code)).sort(
      (a, b) => b.start - a.start,
    )
    if (ranges.length === 0) return null

    let browserCode = code
    for (const range of ranges) {
      browserCode = `${browserCode.slice(0, range.start)}"production"${browserCode.slice(range.end)}`
    }
    return { code: browserCode, map: null }
  },
}

export const buildProjectEvalWorker = async (
  projectDir: string,
): Promise<ProjectEvalWorkerRuntime | undefined> => {
  const projectRequire = createRequire(path.join(projectDir, "package.json"))
  const browserPath = resolveProjectBrowserPath(projectRequire, projectDir)
  if (!browserPath) return undefined
  const runtimeRequire = createRequire(browserPath)

  const standalonePath = resolveProjectPackage(
    runtimeRequire,
    "@tscircuit/runframe/standalone",
    projectDir,
  )
  const rollupModule = loadProjectPackage<RollupModule>(
    runtimeRequire,
    "rollup",
    projectDir,
  )
  const nodeResolveModule = loadProjectPackage<{
    nodeResolve: (...args: unknown[]) => unknown
  }>(runtimeRequire, "@rollup/plugin-node-resolve", projectDir)
  const commonjsModule = loadProjectPackage<RollupPluginModule>(
    runtimeRequire,
    "@rollup/plugin-commonjs",
    projectDir,
  )
  const jsonModule = loadProjectPackage<RollupPluginModule>(
    runtimeRequire,
    "@rollup/plugin-json",
    projectDir,
  )
  let standaloneBundle: string
  try {
    standaloneBundle = await fs.readFile(standalonePath, "utf8")
  } catch (error) {
    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": could not read "${standalonePath}"`,
      { cause: error },
    )
  }
  const placeholderCount = standaloneBundle.split(
    RUNFRAME_WORKER_PLACEHOLDER,
  ).length - 1
  if (placeholderCount !== 1) {
    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": expected one eval worker placeholder in "${standalonePath}", found ${placeholderCount}`,
    )
  }

  const workerEntryId = path.join(
    path.dirname(browserPath),
    "project-eval-worker-entry.js",
  )
  let build: RollupBuild | undefined
  try {
    build = await rollupModule.rollup({
      input: workerEntryId,
      plugins: [
        {
          name: "tscircuit-project-eval-worker-entry",
          resolveId(id: string) {
            return id === workerEntryId ? workerEntryId : null
          },
          load(id: string) {
            return id === workerEntryId ? createWorkerEntrySource() : null
          },
        },
        nodeResolveModule.nodeResolve({ browser: true }),
        getDefaultExport(
          commonjsModule,
          "@rollup/plugin-commonjs",
          projectDir,
        )(),
        getDefaultExport(jsonModule, "@rollup/plugin-json", projectDir)(),
        browserEnvironmentPlugin,
      ],
    })
    const generated = await build.generate({
      format: "es",
      inlineDynamicImports: true,
    })
    if (generated.output.length !== 1 || generated.output[0]?.type !== "chunk") {
      throw new Error(
        `expected one ESM worker chunk, received ${generated.output.length} outputs`,
      )
    }
    if (generated.output[0].imports.length > 0) {
      throw new Error(
        `worker bundle retained unresolved imports: ${generated.output[0].imports.join(", ")}`,
      )
    }
    const unsupportedDynamicImports = generated.output[0].dynamicImports.filter(
      (importPath) => importPath !== "node:module",
    )
    if (unsupportedDynamicImports.length > 0) {
      throw new Error(
        `worker bundle retained unresolved dynamic imports: ${unsupportedDynamicImports.join(", ")}`,
      )
    }

    return {
      standaloneBundle: standaloneBundle.replace(
        RUNFRAME_WORKER_PLACEHOLDER,
        PROJECT_EVAL_WORKER_PATH,
      ),
      workerBundle: generated.output[0].code,
    }
  } catch (error) {
    throw new Error(
      `Failed to build project browser runtime for "${projectDir}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  } finally {
    await build?.close()
  }
}
