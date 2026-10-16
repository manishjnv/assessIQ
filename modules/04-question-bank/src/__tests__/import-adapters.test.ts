/**
 * RW-59: GIFT / Aiken / QTI adapters and the QTI 3.0 export (no database).
 * Every produced row must pass the registry validation (validateRow) unchanged.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseGift } from "../import/adapters/gift.js";
import { parseAiken } from "../import/adapters/aiken.js";
import { buildQtiPackage, parseQtiPackage } from "../import/adapters/qti.js";
import { parseImportFile } from "../import/parse.js";
import { validateRow } from "../import/staging.js";

const accepted = (rows: { row: number; cells: Record<string, string> }[]): void => {
  for (const r of rows) expect(validateRow(r.row, r.cells).errors, `row ${r.row}`).toEqual([]);
};

describe("GIFT", () => {
  const GIFT = `// a comment
::Ports:: Which port is HTTPS? {
  ~80
  =443 #HTTPS uses 443
  ~22
}

Is a \\{brace\\} \\= equal? {~yes =no \\~ really ~maybe}

Capital of France? {=Paris}

::tf:: The sky is blue. {TRUE}
`;
  it("parses mcq items and reports unsupported ones as RowError", () => {
    const r = parseGift(GIFT);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({
      row: 1,
      cells: {
        type: "mcq", topic: "Ports", points: "1", level: "1", question: "Which port is HTTPS?",
        options: '["80","443","22"]', correct: "1", rationale: "HTTPS uses 443",
      },
    });
    expect(r.rows[1]!.row).toBe(2);
    expect(r.rows[1]!.cells["question"]).toBe("Is a {brace} = equal?");
    expect(r.rows[1]!.cells["options"]).toBe('["yes","no ~ really","maybe"]');
    expect(r.rows[1]!.cells["correct"]).toBe("1");
    expect(r.rows[1]!.cells["rationale"]).toBe("Imported from GIFT");
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(r.errors[0]!.message).toMatch(/short-answer/);
    expect(r.errors[1]!.message).toMatch(/TRUE\/FALSE/);
    accepted(r.rows);
  });
  it("two = answers is an error", () => {
    expect(parseGift("Q? {=a =b ~c}").errors[0]!.message).toMatch(/more than one/);
  });
});

describe("Aiken", () => {
  const AIKEN = `What is 2+2?
A. 3
B) 4
C. 5
ANSWER: B

Pick the odd one
A. x
B. y
ANSWER: A

No answer here
A. x
B. y
`;
  it("parses items and rejects a missing ANSWER", () => {
    const r = parseAiken(AIKEN);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.cells).toEqual({
      type: "mcq", topic: "What is 2+2?", points: "1", level: "1", question: "What is 2+2?",
      options: '["3","4","5"]', correct: "1", rationale: "Imported from Aiken",
    });
    expect(r.rows[1]!.cells["correct"]).toBe("0");
    expect(r.errors).toEqual([{ row: 3, column: "correct", message: expect.stringMatching(/ANSWER/) }]);
    accepted(r.rows);
  });
});

const ITEM21 = `<?xml version="1.0"?>
<assessmentItem xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="i1" title="Ports" adaptive="false" timeDependent="false">
  <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"><correctResponse><value>B</value></correctResponse></responseDeclaration>
  <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"><defaultValue><value>3</value></defaultValue></outcomeDeclaration>
  <itemBody><p>Which port is HTTPS?</p>
    <choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1">
      <simpleChoice identifier="A">80</simpleChoice><simpleChoice identifier="B">443</simpleChoice>
    </choiceInteraction></itemBody>
</assessmentItem>`;

const item30 = (body: string, decl: string): string =>
  `<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="x" title="T">${decl}<qti-item-body>${body}</qti-item-body></qti-assessment-item>`;

describe("QTI import", () => {
  it("reads a single 2.1 choiceInteraction file as mcq", async () => {
    const r = await parseQtiPackage(Buffer.from(ITEM21));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]!.cells).toEqual({
      type: "mcq", topic: "Ports", points: "3", level: "1", question: "Which port is HTTPS?",
      options: '["80","443"]', correct: "1", rationale: "Imported from QTI",
    });
    accepted(r.rows);
  });

  it("reads a 3.0 zip: multi choice, numeric, extended text, unsupported interaction", async () => {
    const zip = new JSZip();
    zip.file("items/a.xml", item30(
      `<qti-choice-interaction response-identifier="R" max-choices="3"><qti-prompt>Pick primes</qti-prompt><qti-simple-choice identifier="a">2</qti-simple-choice><qti-simple-choice identifier="b">4</qti-simple-choice><qti-simple-choice identifier="c">5</qti-simple-choice></qti-choice-interaction>`,
      `<qti-response-declaration identifier="R" cardinality="multiple" base-type="identifier"><qti-correct-response><qti-value>c</qti-value><qti-value>a</qti-value></qti-correct-response></qti-response-declaration>`));
    zip.file("items/b.xml", item30(
      `<p>Pi to 2 places?</p><qti-text-entry-interaction response-identifier="R"/>`,
      `<qti-response-declaration identifier="R" cardinality="single" base-type="float"><qti-correct-response><qti-value>3.14</qti-value></qti-correct-response></qti-response-declaration>`));
    zip.file("items/c.xml", item30(`<p>Explain TLS.</p><qti-extended-text-interaction response-identifier="R"/>`, ""));
    zip.file("items/d.xml", item30(`<qti-match-interaction response-identifier="R"/>`, ""));
    zip.file("imsmanifest.xml", `<manifest>${["a", "b", "c", "d"].map((n) => `<resource identifier="r${n}" type="imsqti_item_xmlv3p0" href="items/${n}.xml"/>`).join("")}<resource identifier="t" type="imsqti_test_xmlv3p0" href="t.xml"/></manifest>`);
    const r = await parseQtiPackage(await zip.generateAsync({ type: "nodebuffer" }));
    expect(r.rows.map((x) => x.cells["type"])).toEqual(["multi_select", "numeric", "subjective"]);
    expect(r.rows[0]!.cells).toMatchObject({ question: "Pick primes", options: '["2","4","5"]', correct: "[0,2]" });
    expect(r.rows[1]!.cells).toMatchObject({ question: "Pi to 2 places?", answer: "3.14" });
    expect(r.errors).toEqual([{ row: 4, column: "", message: "unsupported interaction 'qti-match-interaction'" }]);
    accepted(r.rows);
  });

  it("a non-numeric text-entry answer is a RowError", async () => {
    const r = await parseQtiPackage(Buffer.from(item30(
      `<p>Q</p><qti-text-entry-interaction response-identifier="R"/>`,
      `<qti-response-declaration identifier="R" cardinality="single" base-type="string"><qti-correct-response><qti-value>abc</qti-value></qti-correct-response></qti-response-declaration>`)));
    expect(r.rows).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/number/);
  });

  it("rejects garbage zip bytes at file level", async () => {
    await expect(parseQtiPackage(Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]))).rejects.toThrow(/zip/);
  });
});

describe("QTI export round trip", () => {
  it("mcq, multi_select, ordering, numeric and subjective survive build -> parse", async () => {
    const questions = [
      { id: "11111111-1111-1111-1111-111111111111", type: "mcq", topic: "A & B", points: 2, content: { question: "Q <1>?", options: ["x", "y & z", "w"], correct: 1, rationale: "r" } },
      { id: "22222222-2222-2222-2222-222222222222", type: "multi_select", topic: "M", points: 1, content: { question: "Pick", options: ["a", "b", "c"], correct: [0, 2] } },
      { id: "33333333-3333-3333-3333-333333333333", type: "ordering", topic: "O", points: 1, content: { question: "Order", items: ["one", "two", "three"], correct_order: [2, 0, 1] } },
      { id: "44444444-4444-4444-4444-444444444444", type: "numeric", topic: "N", points: 1, content: { question: "Pi?", answer: 3.14 } },
      { id: "55555555-5555-5555-5555-555555555555", type: "subjective", topic: "S", points: 1, content: { question: "Explain." } },
    ];
    const buf = await buildQtiPackage({ packName: "Pack <x>", questions });
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files)).toContain("imsmanifest.xml");
    expect(await zip.file("imsmanifest.xml")!.async("string")).toContain('type="imsqti_item_xmlv3p0"');
    const r = await parseImportFile("qti", buf);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.cells["type"])).toEqual(["mcq", "multi_select", "ordering", "numeric", "subjective"]);
    expect(r.rows[0]!.cells).toMatchObject({ topic: "A & B", points: "2", question: "Q <1>?", options: '["x","y & z","w"]', correct: "1" });
    expect(r.rows[1]!.cells).toMatchObject({ options: '["a","b","c"]', correct: "[0,2]" });
    expect(r.rows[2]!.cells).toMatchObject({ items: '["one","two","three"]', correct_order: "[2,0,1]" });
    expect(r.rows[3]!.cells["answer"]).toBe("3.14");
    accepted(r.rows);
  });
});

describe("QTI import hardening", () => {
  it("a zip entry that inflates past 4 MB is IMPORT_TOO_LARGE, not an OOM", async () => {
    const zip = new JSZip();
    zip.file("items/big.xml", Buffer.alloc(6 * 1024 * 1024), { compression: "DEFLATE", compressionOptions: { level: 9 } });
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    expect(buf.byteLength).toBeLessThan(4 * 1024 * 1024);
    await expect(parseQtiPackage(buf)).rejects.toMatchObject({ details: { code: "IMPORT_TOO_LARGE" } });
  });

  it("a deeply nested item is a row error", async () => {
    const deep = "<p>".repeat(100) + "x" + "</p>".repeat(100);
    const r = await parseQtiPackage(Buffer.from(item30(`${deep}<qti-extended-text-interaction response-identifier="R"/>`, "")));
    expect(r.rows).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/nested too deeply/);
  });

  it("the same manifest href listed three times gives one row", async () => {
    const zip = new JSZip();
    zip.file("items/a.xml", item30(`<p>Explain.</p><qti-extended-text-interaction response-identifier="R"/>`, ""));
    const res = `<resource identifier="r" type="imsqti_item_xmlv3p0" href="items/a.xml"/>`;
    zip.file("imsmanifest.xml", `<manifest>${res}${res}${res}</manifest>`);
    const r = await parseQtiPackage(await zip.generateAsync({ type: "nodebuffer" }));
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});
