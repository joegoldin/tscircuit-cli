import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { exportSnippet } from "../../../lib/shared/export-snippet"

test("normal Gerber ZIP excludes DNP components from both assembly CSVs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-gerber-dnp-"))
  const filePath = path.join(directory, "assembly.circuit.json")
  const circuitJson = [
    { type: "pcb_board", pcb_board_id: "board", center: { x: 0, y: 0 },
      width: 10, height: 10, num_layers: 2, material: "fr4", thickness: 1.6 },
    ...[false, true].flatMap((doNotPlace, index) => [
      { type: "source_component", source_component_id: `source_${index}`,
        ftype: "simple_resistor", name: `R${index + 1}`, resistance: 1_000 },
      { type: "pcb_component", pcb_component_id: `component_${index}`,
        source_component_id: `source_${index}`, center: { x: index, y: 2 },
        width: 1, height: 0.5, layer: "top", rotation: 90,
        obstructs_within_bounds: true, do_not_place: doNotPlace,
        pin1_location: "leftside_top",
        supplier_pin1_location_map: { jlcpcb: "bottomside_left" } },
    ]),
  ]
  await writeFile(filePath, JSON.stringify(circuitJson))
  let outputContent: string | Buffer = ""
  await exportSnippet({
    filePath, format: "gerbers", writeFile: false,
    onExit: (code) => { expect(code).toBe(0) },
    onError: (message) => { throw new Error(message) },
    onSuccess: (value) => { outputContent = value.outputContent },
  })
  const zip = await JSZip.loadAsync(outputContent)
  const bom = await zip.file("bom.csv")!.async("string")
  const pnp = await zip.file("pick_and_place.csv")!.async("string")
  expect(bom.split(/\r?\n/).slice(1).map(row => row.split(",")[0])).toEqual(["R1"])
  expect(pnp).toBe("Designator,Mid X,Mid Y,Layer,Rotation\r\nR1,0.000,2.000,top,0")
})
