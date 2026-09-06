import type { CircuitJsonIssue } from "lib/shared/circuit-json-diagnostics"

export const getFatalAutoroutingError = (
  errors: CircuitJsonIssue[],
): { errorType: string; message: string } | undefined => {
  const error = errors.find(
    (issue) =>
      issue.type === "pcb_autorouting_error" ||
      issue.error_type === "pcb_autorouting_error",
  )
  if (!error) return undefined

  return {
    errorType: "pcb_autorouting_error",
    message: error.message || JSON.stringify(error),
  }
}
