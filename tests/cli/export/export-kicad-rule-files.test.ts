import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { exportSnippet } from "../../../lib/shared/export-snippet"
import { generateKicadProject } from "../../../cli/build/generate-kicad-project"

const circuitJson = [{
  type: "pcb_board",
  pcb_board_id: "pcb_board_0",
  center: { x: 0, y: 0 },
  width: 10,
  height: 10,
  num_layers: 2,
  material: "fr4",
  thickness: 1.6,
  min_trace_width: 0.15,
  min_via_hole_diameter: 0.2,
  min_via_pad_diameter: 0.5,
  min_pad_edge_to_pad_edge_clearance: 0.127,
}]

test("standalone PCB export returns correctly named rule sidecars without writing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-rules-"))
  const filePath = path.join(directory, "input.circuit.json")
  await writeFile(filePath, JSON.stringify(circuitJson))
  let result: Record<string, unknown> | undefined
  const exits: number[] = []
  await exportSnippet({
    filePath,
    format: "kicad_pcb",
    outputPath: path.join(directory, "custom.kicad_pcb"),
    writeFile: false,
    onExit: (code) => { exits.push(code) },
    onError: (message) => { throw new Error(message) },
    onSuccess: (value) => { result = value },
  })
  expect(exits).toEqual([0])
  expect(await readdir(directory)).toEqual(["input.circuit.json"])
  expect(result?.additionalOutputs).toEqual([
    { outputDestination: path.join(directory, "custom.kicad_pro"), outputContent: expect.any(String) },
    { outputDestination: path.join(directory, "custom.kicad_dru"), outputContent: expect.stringContaining("0.127mm") },
  ])
})

test("KiCad ZIP carries native custom rules alongside its PCB", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-zip-rules-"))
  const filePath = path.join(directory, "input.circuit.json")
  await writeFile(filePath, JSON.stringify(circuitJson))
  let outputContent: string | Buffer = ""
  await exportSnippet({
    filePath,
    format: "kicad_zip",
    writeFile: false,
    onExit: (code) => { expect(code).toBe(0) },
    onError: (message) => { throw new Error(message) },
    onSuccess: (value) => { outputContent = value.outputContent },
  })
  const zip = await JSZip.loadAsync(outputContent)
  expect(zip.file("input.circuit.kicad_dru")).not.toBeNull()
  expect(await zip.file("input.circuit.kicad_dru")!.async("string")).toContain("0.127mm")
})

test("build project generation writes full project settings and native rules", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-build-rules-"))
  const result = await generateKicadProject({
    circuitJson,
    outputDir: directory,
    projectName: "board",
    writeFiles: true,
  })
  expect(JSON.parse(result.proContent).head.generator).toBe("circuit-json-to-kicad")
  expect(await readFile(path.join(directory, "board.kicad_dru"), "utf8")).toContain("0.127mm")
})

test("standalone PCB export writes matching sidecars and does not report success on a sidecar failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-write-rules-"))
  const filePath = path.join(directory, "input.circuit.json")
  await writeFile(filePath, JSON.stringify(circuitJson))
  const exits: number[] = []
  const errors: string[] = []
  let successes = 0
  const options = {
    filePath,
    format: "kicad_pcb" as const,
    onExit: (code: number) => { exits.push(code) },
    onError: (message: string) => { errors.push(message) },
    onSuccess: () => { successes++ },
  }
  await exportSnippet({ ...options, outputPath: "board.kicad_pcb" })
  expect(exits).toEqual([0])
  expect(successes).toBe(1)
  expect(errors).toEqual([])
  expect(await readFile(path.join(directory, "board.kicad_dru"), "utf8")).toContain("0.127mm")
  expect(JSON.parse(await readFile(path.join(directory, "board.kicad_pro"), "utf8")).head.project_name).toBe("board")

  await mkdir(path.join(directory, "blocked.kicad_dru"))
  await exportSnippet({ ...options, outputPath: "blocked.kicad_pcb" })
  expect(exits).toEqual([0, 1])
  expect(successes).toBe(1)
  expect(errors.length).toBe(1)
  expect((await readdir(directory)).includes("blocked.kicad_pcb")).toBe(false)
})

test("standalone PCB export rejects a sidecar extension before overwriting it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-extension-"))
  const filePath = path.join(directory, "input.circuit.json")
  await writeFile(filePath, JSON.stringify(circuitJson))
  const outputPath = path.join(directory, "board.kicad_pro")
  await writeFile(outputPath, "existing project")
  const exits: number[] = []
  const errors: string[] = []
  let successes = 0
  await exportSnippet({
    filePath, format: "kicad_pcb", outputPath,
    onExit: (code) => { exits.push(code) },
    onError: (message) => { errors.push(message) },
    onSuccess: () => { successes++ },
  })
  expect(exits).toEqual([1])
  expect(successes).toBe(0)
  expect(errors[0]).toContain("must end in .kicad_pcb")
  expect(await readFile(outputPath, "utf8")).toBe("existing project")
})
