import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { getCliTestFixture } from "../../fixtures/get-cli-test-fixture"

test("build fails when generated JSON records an autorouting failure", async () => {
  const { tmpDir, runCommand } = await getCliTestFixture()
  const circuitJson = [
    { type: "pcb_autorouting_error", message: "Router exhausted its attempts" },
  ]
  await writeFile(
    path.join(tmpDir, "board.circuit.json"),
    JSON.stringify(circuitJson),
  )
  await writeFile(path.join(tmpDir, "package.json"), "{}")

  const { exitCode, stdout, stderr } = await runCommand(
    "tsci build board.circuit.json",
  )

  expect(exitCode).toBe(1)
  expect(stdout).toContain("0 passed 1 failed")
  expect(stderr).toContain("pcb_autorouting_error")
  expect(stderr).toContain("Router exhausted its attempts")
  const output = await readFile(
    path.join(tmpDir, "dist/board/circuit.json"),
    "utf-8",
  )
  expect(JSON.parse(output)).toEqual(circuitJson)
}, 30_000)
