/**
 * CSV writer for admin exports. Mirrors the in-page exporter in
 * utils/workshopClient.ts — keep the two in step.
 */

/** How a stored value reads in a cell: objects as JSON, null/undefined blank. */
export function cellText(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/**
 * Quote per RFC 4180, and neutralise spreadsheet formulas: a cell a user typed
 * as `=HYPERLINK(...)` must open in Excel as text, not run. Numbers keep their
 * leading minus sign.
 */
export function csvField(text: string): string {
    let t = text;
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
    return /[",\r\n]|^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/** BOM-prefixed so Excel reads it as UTF-8. */
export function toCsv(keys: string[], rows: Record<string, unknown>[]): string {
    const lines = [keys.map(csvField).join(',')];
    for (const row of rows) lines.push(keys.map((k) => csvField(cellText(row[k]))).join(','));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
