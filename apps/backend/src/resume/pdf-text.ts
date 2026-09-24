export interface PdfTextWord {
  readonly text: string;
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
  readonly blockIndex: number;
  readonly lineIndex: number;
}

export interface PdfTextPage {
  readonly width: number;
  readonly height: number;
  readonly words: readonly PdfTextWord[];
  readonly visibleLineCount: number;
}

const TSV_HEADER = "level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

// TSV carries the same layout hierarchy as -bbox-layout without rendering PDF
// metadata as HTML (which crashes Poppler 26.04 on empty document-info strings).
export function parsePdfTextTsv(value: string): readonly PdfTextPage[] | null {
  const rows = value.trimEnd().split(/\r?\n/);
  if (rows[0] !== TSV_HEADER) return null;
  const pages: { width: number; height: number; words: PdfTextWord[]; visibleLineCount: number }[] = [];
  let page: (typeof pages)[number] | undefined;
  let paragraph = -1;
  let block = -1;
  let blockIndex = -1;
  let lineIndex = -1;
  let nextWord = 0;
  for (let row = 1; row < rows.length; row++) {
    const fields = rows[row]!.split("\t");
    if (fields.length !== 12) return null;
    const numbers = fields.slice(0, 11).map((field) => /^-?\d+(?:\.\d+)?$/.test(field) ? Number(field) : NaN);
    if (numbers.some((number) => !Number.isFinite(number))) return null;
    const [level, pageNumber, par, blockNumber, line, word, left, top, width, height] = numbers as [number, number, number, number, number, number, number, number, number, number, number];
    if (numbers.slice(0, 6).some((number) => !Number.isSafeInteger(number) || number < 0)) return null;
    if (level === 1) {
      if (pageNumber !== pages.length + 1 || width <= 0 || height <= 0 || left !== 0 || top !== 0) return null;
      page = { width, height, words: [], visibleLineCount: 0 };
      pages.push(page);
      paragraph = block = blockIndex = lineIndex = -1;
      continue;
    }
    if (!page || pageNumber !== pages.length) return null;
    if (level === 3) {
      if (par < paragraph || (par === paragraph && blockNumber <= block)) return null;
      paragraph = par;
      block = blockNumber;
      blockIndex++;
      lineIndex = -1;
      continue;
    }
    if (blockIndex < 0 || par !== paragraph || blockNumber !== block) return null;
    if (level === 4) {
      if (line !== lineIndex + 1) return null;
      lineIndex = line;
      nextWord = 0;
      continue;
    }
    if (level !== 5 || lineIndex < 0 || line !== lineIndex || word !== nextWord++) return null;
    const text = fields[11]!.trim();
    if (!text) return null;
    if (word === 0) page.visibleLineCount++;
    page.words.push({ text, xMin: left, yMin: top, xMax: left + width, yMax: top + height, blockIndex, lineIndex });
  }
  return pages.length > 0 ? pages : null;
}
