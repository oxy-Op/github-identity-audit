export interface ExtractionInput { path: string; bytes: Uint8Array; }
export interface ExtractionResult {
  status: "extracted" | "disabled" | "unsupported" | "failed";
  text?: string;
  extractor?: string;
  mediaType?: string;
  warning?: string;
}
export interface BinaryTextExtractor { readonly name: string; supports(path: string, bytes: Uint8Array): boolean; extract(input: ExtractionInput): Promise<ExtractionResult>; }
export interface OcrProvider { readonly name: string; recognize(bytes: Uint8Array, mediaType: string): Promise<string>; }
export interface DocumentTextProvider { readonly name: string; extractPdf(bytes: Uint8Array): Promise<string>; }
export interface RuleEntity { kind: "person" | "organization" | "location" | "social_handle" | "first_person" | "attribution"; value: string; normalized: string; confidence: number; }
export interface RuleLink { url: string; domain: string; }

export function extractRuleSignals(text: string, known: { names?: string[]; organizations?: string[]; locations?: string[] } = {}) {
  const entities: RuleEntity[] = [], links: RuleLink[] = [];
  for (const name of known.names ?? []) for (const match of text.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\b`, "giu"))) entities.push({ kind: "person", value: match[0], normalized: match[0].normalize("NFKC").toLowerCase(), confidence: 1 });
  for (const organization of known.organizations ?? []) if (new RegExp(`\\b${escapeRegExp(organization)}\\b`, "iu").test(text)) entities.push({ kind: "organization", value: organization, normalized: organization.normalize("NFKC").toLowerCase(), confidence: 1 });
  for (const location of known.locations ?? []) if (new RegExp(`\\b${escapeRegExp(location)}\\b`, "iu").test(text)) entities.push({ kind: "location", value: location, normalized: location.normalize("NFKC").toLowerCase(), confidence: 1 });
  for (const match of text.matchAll(/(?<![\w@])@[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?/giu)) entities.push({ kind: "social_handle", value: match[0], normalized: match[0].toLowerCase(), confidence: 0.8 });
  for (const match of text.matchAll(/\b(?:I am|I'm|I work at|I live in|I joined|my name is)\b[^.!?\n]{0,160}/giu)) entities.push({ kind: "first_person", value: match[0], normalized: match[0].normalize("NFKC").toLowerCase(), confidence: 0.75 });
  for (const match of text.matchAll(/\b(?:built|created|developed|maintained|authored)\s+by\b[^.!?\n]{0,120}/giu)) entities.push({ kind: "attribution", value: match[0], normalized: match[0].normalize("NFKC").toLowerCase(), confidence: 0.85 });
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\[\]{}"']+/giu)) { try { const url = new URL(match[0].replace(/[.,;:!?]+$/, "")); links.push({ url: url.href, domain: url.hostname.toLowerCase() }); } catch {} }
  return { entities, links };
}

export class PdfExtractor implements BinaryTextExtractor {
  readonly name: string;
  readonly #provider?: DocumentTextProvider;
  constructor(provider?: DocumentTextProvider) { this.#provider = provider; this.name = provider ? `pdf:${provider.name}` : "pdf:disabled"; }
  supports(path: string, bytes: Uint8Array) { return path.toLowerCase().endsWith(".pdf") || startsWith(bytes, "%PDF-"); }
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (!this.#provider) return { status: "disabled", extractor: this.name, mediaType: "application/pdf", warning: "PDF extraction is disabled because no document provider is configured." };
    try {
      const text = (await this.#provider.extractPdf(input.bytes)).trim();
      return text ? { status: "extracted", text, extractor: this.name, mediaType: "application/pdf" } : { status: "failed", extractor: this.name, mediaType: "application/pdf", warning: "PDF extraction returned no text." };
    } catch (error) { return { status: "failed", extractor: this.name, mediaType: "application/pdf", warning: error instanceof Error ? error.message : String(error) }; }
  }
}

export class ImageOcrExtractor implements BinaryTextExtractor {
  readonly name: string;
  readonly #provider?: OcrProvider;
  constructor(provider?: OcrProvider) { this.#provider = provider; this.name = provider ? `ocr:${provider.name}` : "ocr:disabled"; }
  supports(path: string, bytes: Uint8Array) { return /\.(png|jpe?g|webp|gif|tiff?)$/i.test(path) || isKnownImage(bytes); }
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const mediaType = imageMediaType(input.path, input.bytes);
    if (!this.#provider) return { status: "disabled", extractor: this.name, mediaType, warning: "Image OCR is disabled because no OCR provider is configured." };
    try {
      const text = (await this.#provider.recognize(input.bytes, mediaType)).trim();
      return text ? { status: "extracted", text, extractor: this.name, mediaType } : { status: "failed", extractor: this.name, mediaType, warning: "OCR returned no text." };
    } catch (error) { return { status: "failed", extractor: this.name, mediaType, warning: error instanceof Error ? error.message : String(error) }; }
  }
}

export class CompositeBinaryExtractor {
  readonly #extractors: BinaryTextExtractor[];
  constructor(extractors: BinaryTextExtractor[]) { this.#extractors = extractors; }
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const extractor = this.#extractors.find((candidate) => candidate.supports(input.path, input.bytes));
    return extractor ? extractor.extract(input) : { status: "unsupported", warning: `No binary extractor supports ${input.path || "this artifact"}.` };
  }
}

function startsWith(bytes: Uint8Array, value: string) { return Buffer.from(bytes.subarray(0, value.length)).toString("ascii") === value; }
function isPng(bytes: Uint8Array) { return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47; }
function isKnownImage(bytes: Uint8Array) { return isPng(bytes) || startsWith(bytes, "GIF8") || (bytes[0] === 0xff && bytes[1] === 0xd8); }
function imageMediaType(path: string, bytes: Uint8Array) {
  if (isPng(bytes) || path.toLowerCase().endsWith(".png")) return "image/png";
  if (startsWith(bytes, "GIF8") || path.toLowerCase().endsWith(".gif")) return "image/gif";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/jpeg";
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
