import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exportSnippet } from "../../../lib/shared/export-snippet"

test("normal KiCad export preserves explicit solder-paste apertures", async (): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-paste-"))
  const filePath = path.join(directory, "paste.circuit.json")
  await writeFile(
    filePath,
    JSON.stringify([
      {
        type: "pcb_board",
        pcb_board_id: "board",
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        num_layers: 2,
        material: "fr4",
        thickness: 1.6,
      },
      {
        type: "source_component",
        source_component_id: "source_u1",
        ftype: "simple_chip",
        name: "U1",
      },
      {
        type: "pcb_component",
        pcb_component_id: "component_u1",
        source_component_id: "source_u1",
        center: { x: 0, y: 0 },
        width: 4,
        height: 4,
        layer: "top",
        rotation: 0,
        obstructs_within_bounds: true,
      },
      {
        type: "pcb_smtpad",
        pcb_smtpad_id: "pad_u1_1",
        pcb_component_id: "component_u1",
        shape: "rect",
        x: 0,
        y: 0,
        width: 2,
        height: 1,
        layer: "top",
        port_hints: ["1"],
      },
      {
        type: "pcb_solder_paste",
        pcb_solder_paste_id: "paste_u1_1",
        pcb_smtpad_id: "pad_u1_1",
        pcb_component_id: "component_u1",
        shape: "rect",
        x: 0.4,
        y: -0.2,
        width: 0.7,
        height: 0.3,
        layer: "top",
      },
    ]),
  )

  let outputContent = ""
  await exportSnippet({
    filePath,
    format: "kicad_pcb",
    writeFile: false,
    onExit: (code) => {
      expect(code).toBe(0)
    },
    onError: (message) => {
      throw new Error(message)
    },
    onSuccess: (value) => {
      outputContent = String(value.outputContent)
    },
  })

  expect(outputContent).toMatch(
    /\(pad "1" smd rect[\s\S]*?\(size 2 1\)[\s\S]*?\(layers F\.Cu F\.Mask\)/,
  )
  expect(outputContent).toMatch(
    /\(pad "" smd rect[\s\S]*?\(at 0\.4 0\.2 0\)[\s\S]*?\(size 0\.7 0\.3\)[\s\S]*?\(layers F\.Paste\)/,
  )
})
