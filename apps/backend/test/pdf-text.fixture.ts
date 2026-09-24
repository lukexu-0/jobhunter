export type TextWordFixture = readonly [text: string, left: number, top: number, width: number, height: number];
export interface TextPageFixture {
  readonly width?: number;
  readonly height?: number;
  readonly blocks: readonly (readonly (readonly TextWordFixture[])[])[];
}

export function textTsv(pages: readonly TextPageFixture[]): string {
  const rows = ["level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"];
  for (const [pageIndex, page] of pages.entries()) {
    const pageNumber = pageIndex + 1;
    rows.push([1, pageNumber, 0, 0, 0, 0, 0, 0, page.width ?? 612, page.height ?? 792, -1, "###PAGE###"].join("\t"));
    for (const [block, lines] of page.blocks.entries()) {
      rows.push([3, pageNumber, 0, block, 0, 0, 0, 0, 612, 792, -1, "###FLOW###"].join("\t"));
      for (const [line, words] of lines.entries()) {
        rows.push([4, pageNumber, 0, block, line, 0, 0, 0, 612, 12, -1, "###LINE###"].join("\t"));
        for (const [word, [text, left, top, width, height]] of words.entries()) {
          rows.push([5, pageNumber, 0, block, line, word, left, top, width, height, 100, text].join("\t"));
        }
      }
    }
  }
  return rows.join("\n") + "\n";
}

export function textPage(...lines: readonly string[]): TextPageFixture {
  return { blocks: [lines.map((text, index) => [[text, 72, 72 + index * 24, 148, 12]])] };
}
