import test from "node:test";
import assert from "node:assert/strict";
import { CompositeBinaryExtractor, ImageOcrExtractor, PdfExtractor } from "./index.ts";

test("extracts PDFs through a configured boundary", async () => {
  const extractor = new PdfExtractor({ name: "fixture", extractPdf: async () => "My name is Sasha" });
  const result = await extractor.extract({ path: "bio.pdf", bytes: Buffer.from("%PDF-fixture") });
  assert.equal(result.status, "extracted");
  assert.equal(result.text, "My name is Sasha");
});

test("reports disabled OCR and unsupported binaries explicitly", async () => {
  const extractor = new CompositeBinaryExtractor([new PdfExtractor(), new ImageOcrExtractor()]);
  assert.equal((await extractor.extract({ path: "photo.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })).status, "disabled");
  assert.equal((await extractor.extract({ path: "archive.zip", bytes: Buffer.from("PK") })).status, "unsupported");
});
