/**
 * Shared CSV serialization for every export endpoint. Keeping the single
 * formula-injection guard here means a new export cannot accidentally ship
 * unguarded participant-authored text.
 */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function csvCell(value: string): string {
  // Guard against spreadsheet formula injection: participant-authored text
  // starting with = + - @ would execute when the CSV is opened in Excel.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (!/[",\n]/.test(guarded)) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}
