import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { exportSnippet } from "../../../lib/shared/export-snippet"

test("normal Gerber ZIP preserves the nine rounded-square QFN stencil windows", async (): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-gerber-paste-"))
  const filePath = path.join(directory, "paste.circuit.json")
  const offsets = [-1.4, 0, 1.4]
  await writeFile(filePath, JSON.stringify([
    { type: "pcb_board", pcb_board_id: "board", center: { x: 0, y: 0 },
      width: 10, height: 10, num_layers: 2, material: "fr4", thickness: 1.6 },
    ...offsets.flatMap((x, i) => offsets.map((y, j) => ({
      type: "pcb_solder_paste", pcb_solder_paste_id: `paste_${i}_${j}`,
      shape: "pill", x, y, width: 1.13, height: 1.13, radius: 0.25, layer: "top",
    }))),
  ]))
  let outputContent: string | Buffer = ""
  await exportSnippet({
    filePath, format: "gerbers", writeFile: false,
    onExit: (code) => { expect(code).toBe(0) },
    onError: (message) => { throw new Error(message) },
    onSuccess: (value) => { outputContent = value.outputContent },
  })
  const zip = await JSZip.loadAsync(outputContent)
  const paste = await zip.file("F_Paste.gbr")!.async("string")
  const aperture = paste.match(/%ADD(\d+)ROUNDRECT,0\.250000X-0\.315000X0\.315000/)
  expect(aperture).not.toBeNull()
  expect(paste).toContain(`D${aperture![1]}*`)
  expect(paste.match(/X-?\d+Y-?\d+D03\*/g)).toHaveLength(9)
})
