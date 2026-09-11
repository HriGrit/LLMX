import type { Exporter } from "../types.js";
export function consoleExporter(
  write: (line: string) => void = console.log,
): Exporter {
  return {
    export(events) {
      for (const event of events) write(JSON.stringify(event));
    },
  };
}
