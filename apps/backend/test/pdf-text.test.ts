import { describe, expect, test } from "bun:test";
import { parsePdfTextTsv } from "../src/resume/pdf-text.ts";

// Poppler's real TSV format: block numbers restart for each paragraph/flow,
// and word coordinates use left/top/width/height rather than opposite corners.
const OUTPUT = `level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0.000000\t0.000000\t612.000000\t792.000000\t-1\t###PAGE###
3\t1\t0\t0\t0\t0\t54.000000\t83.384000\t60.024000\t11.100000\t-1\t###FLOW###
4\t1\t0\t0\t0\t0\t54.000000\t83.384000\t60.024000\t11.100000\t-1\t###LINE###
5\t1\t0\t0\t0\t0\t54.00\t83.38\t60.02\t11.10\t100\tR&D
4\t1\t0\t0\t1\t0\t54.000000\t104.820000\t93.910000\t9.250000\t-1\t###LINE###
5\t1\t0\t0\t1\t0\t54.00\t104.82\t36.67\t9.25\t100\t<APIs>
3\t1\t1\t0\t0\t0\t54.000000\t153.384000\t53.364000\t11.100000\t-1\t###FLOW###
4\t1\t1\t0\t0\t0\t54.000000\t153.384000\t53.364000\t11.100000\t-1\t###LINE###
5\t1\t1\t0\t0\t0\t54.00\t153.38\t53.36\t11.10\t100\tÉducation
`;

describe("structured PDF text", () => {
  test("preserves literal text, geometry, and distinct blocks when paragraph counters restart", () => {
    const pages = parsePdfTextTsv(OUTPUT);
    expect(pages?.map(({ words, visibleLineCount }) => ({
      visibleLineCount,
      words: words.map(({ text, blockIndex, lineIndex }) => ({ text, blockIndex, lineIndex })),
    }))).toEqual([{
      visibleLineCount: 3,
      words: [
        { text: "R&D", blockIndex: 0, lineIndex: 0 },
        { text: "<APIs>", blockIndex: 0, lineIndex: 1 },
        { text: "Éducation", blockIndex: 1, lineIndex: 0 },
      ],
    }]);
    expect(pages?.[0]?.words[0]?.xMax).toBeCloseTo(114.02, 6);
    expect(pages?.[0]?.words[0]?.yMax).toBeCloseTo(94.48, 6);
  });

  test("rejects incomplete rows, invalid coordinates, and orphaned hierarchy instead of dropping them", () => {
    for (const malformed of [
      OUTPUT + "5\t1\t1",
      OUTPUT.replace("54.00\t83.38", "NaN\t83.38"),
      OUTPUT.replace("5\t1\t1\t0\t0\t0", "5\t2\t1\t0\t0\t0"),
      OUTPUT.replace("5\t1\t1\t0\t0\t0", "5\t1\t1\t0\t1\t0"),
      OUTPUT.replace("5\t1\t1\t0\t0\t0", "5\t1\t1\t0\t0\t2"),
    ]) {
      expect(parsePdfTextTsv(malformed)).toBeNull();
    }
  });
});
