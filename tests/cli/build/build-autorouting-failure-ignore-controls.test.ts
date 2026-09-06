import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { getCliTestFixture } from "../../fixtures/get-cli-test-fixture"

test("ignore controls do not hide recorded fatal autorouting failure", async () => {
  const { tmpDir, runCommand } = await getCliTestFixture()
  await writeFile(
    path.join(tmpDir, "board.circuit.json"),
    JSON.stringify([
      {
        type: "pcb_autorouting_error",
        error_type: "pcb_autorouting_error",
        message: "Recorded routing failure",
      },
      { type: "pcb_port_not_connected_error", message: "Unconnected port" },
    ]),
  )
  await writeFile(path.join(tmpDir, "package.json"), "{}")

  for (const concurrency of [1, 2]) {
    for (const flag of [
      "--ignore-errors",
      "--ignore-routing-drc",
      "--routing-disabled",
    ]) {
      const { exitCode, stderr } = await runCommand(
        `tsci build board.circuit.json --concurrency ${concurrency} ${flag}`,
      )
      expect(exitCode).toBe(1)
      expect(stderr).toContain("pcb_autorouting_error")
      expect(stderr).toContain("Recorded routing failure")
    }
  }
}, 30_000)
