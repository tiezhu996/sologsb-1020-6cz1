import type { RecordGroup } from '../types';

export interface ParsedRow {
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
}

const splitList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value ?? '').split(/[，,、|]/).map((item) => item.trim()).filter(Boolean);

/** 解析导入内容：JSON 数组或制表符 / 竖线分隔文本。 */
export function parseImportRows(raw: string): ParsedRow[] {
  const text = raw.trim();
  if (!text) return [];
  let rows: Array<Partial<Record<string, unknown>>>;
  if (text.startsWith('[')) {
    rows = JSON.parse(text) as Array<Partial<Record<string, unknown>>>;
  } else {
    rows = text.split(/\r?\n/).filter(Boolean).map((line) => {
      const cells = line.split(/\t|\|/).map((cell) => cell.trim());
      return {
        title: cells[0], date: cells[1], people: cells[2], places: cells[3],
        identifier: cells[4], medium: cells[5], extent: cells[6], rights: cells[7], notes: cells[8]
      };
    });
  }
  return rows.map((row, index) => ({
    title: String(row.title ?? '').trim() || `未命名记录 ${index + 1}`,
    date: String(row.date ?? '').trim(),
    people: splitList(row.people),
    places: splitList(row.places),
    identifier: String(row.identifier ?? '').trim(),
    medium: String(row.medium ?? '').trim(),
    extent: String(row.extent ?? '').trim(),
    rights: String(row.rights ?? '').trim(),
    notes: String(row.notes ?? '').trim()
  }));
}

export interface ParsedOfflineFile {
  fileName: string;
  parsed: unknown;
}

export const parseDateLabel = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

export const groupText = (group: RecordGroup) => group === 'A' ? 'A · 口述史' : 'B · 手稿';
