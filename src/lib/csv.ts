import { parse as parseCsv } from "csv-parse/sync";
import { ValidationError } from "./errors";

export const MAX_IMPORT_ROWS = 5000;

export function readCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  let records: Record<string, string>[];
  try {
    records = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (err) {
    throw new ValidationError(`Could not parse CSV: ${(err as Error).message}`);
  }
  if (!records.length) throw new ValidationError("CSV file has no data rows");
  if (records.length > MAX_IMPORT_ROWS) throw new ValidationError(`CSV is limited to ${MAX_IMPORT_ROWS} rows per import`);
  return { headers: Object.keys(records[0]), rows: records };
}

function escapeCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(","))].join("\n");
}
