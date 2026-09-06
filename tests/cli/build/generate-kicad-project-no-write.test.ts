import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { generateKicadProject } from "../../../cli/build/generate-kicad-project"

test("non-writing project generation returns fabrication floors without creating its output directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-kicad-project-content-"))
  const outputDir = path.join(directory, "not-written")
  const result = await generateKicadProject({
    circuitJson: [{
      type: "pcb_board", pcb_board_id: "board", center: { x: 0, y: 0 },
      width: 10, height: 10, num_layers: 2, material: "fr4", thickness: 1.6,
      min_trace_width: 0.15, min_via_hole_diameter: 0.2,
      min_via_pad_diameter: 0.5, min_board_edge_clearance: 0.5,
      min_pad_edge_to_pad_edge_clearance: 0.127,
    }],
    outputDir, projectName: "board", writeFiles: false,
  })
  expect(existsSync(outputDir)).toBe(false)
  expect(result.pcbContent).toContain("(kicad_pcb")
  expect(result.schContent).toContain("(kicad_sch")
  expect(result.druContent).toContain("0.127mm")
  expect(JSON.parse(result.proContent).board.design_settings.rules).toMatchObject({
    min_track_width: 0.15, min_via_diameter: 0.5,
    min_through_hole_diameter: 0.2, min_via_annular_width: 0.15,
    min_copper_edge_clearance: 0.5,
  })
})
