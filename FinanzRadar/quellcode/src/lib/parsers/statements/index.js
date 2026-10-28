// Kontoumsätze: Formaterkennung + Parser. Öffentliche API:
//   detectStatementFormat(extracted, fileMeta) → null | { type, format, institution, confidence, signals }
//   parseStatement(detection, extracted, fileMeta) → ParseResult (bei mehreren Konten/Abschnitten: `.additional` = weitere ParseResults)
//   parseStatementAll(detection, extracted, fileMeta) → ParseResult[]
import { buildContext } from './common.js';
import { detectCamt, parseCamt } from './camt.js';
import { detectMt940, parseMt940 } from './mt940.js';
import { detectIngCsv, parseIngCsv } from './csv-ing.js';
import { detectComdirectCsv, detectComdirectDepot, parseComdirectCsv, parseComdirectDepot } from './csv-comdirect.js';
import { detectPaypalCsv, parsePaypalCsv } from './csv-paypal.js';
import { detectGenericCsv, parseGenericCsv, guessCsvMapping, parseCsvWithMapping } from './csv-generic.js';
import { detectPdfStatement, parsePdfStatement } from './pdf-statement.js';

export { guessCsvMapping, parseCsvWithMapping };
export { parseSepaTokens, normalizeBookingText } from './common.js';

const DETECTORS = [detectCamt, detectMt940, detectIngCsv, detectComdirectDepot, detectComdirectCsv, detectPaypalCsv, detectGenericCsv, detectPdfStatement];

export function detectStatementFormat(extracted, fileMeta) {
  if (!extracted) return null;
  const ctx = buildContext(extracted, fileMeta);
  for (const d of DETECTORS) {
    let r = null;
    try { r = d(ctx); } catch { r = null; }
    if (r) return r;
  }
  return null;
}

export async function parseStatementAll(detection, extracted, fileMeta) {
  const det = detection || detectStatementFormat(extracted, fileMeta);
  if (!det) throw new Error('Kein Kontoumsatz-Format erkannt');
  const ctx = buildContext(extracted, fileMeta);
  let out;
  switch (det.format) {
    case 'camt053': case 'camt052': out = parseCamt(det, ctx); break;
    case 'mt940': out = parseMt940(det, ctx); break;
    case 'ing_csv': out = parseIngCsv(det, ctx); break;
    case 'comdirect_csv': out = parseComdirectCsv(det, ctx); break;
    case 'comdirect_depot_csv': out = parseComdirectDepot(det, ctx); break;
    case 'paypal_csv': out = parsePaypalCsv(det, ctx); break;
    case 'generic_csv': out = parseGenericCsv(det, ctx); break;
    case 'pdf_statement': out = parsePdfStatement(det, ctx); break;
    default: throw new Error(`Unbekanntes Format: ${det.format}`);
  }
  return Array.isArray(out) ? out : [out];
}

export async function parseStatement(detection, extracted, fileMeta) {
  const all = await parseStatementAll(detection, extracted, fileMeta);
  const [first, ...rest] = all;
  if (!first) throw new Error('Keine Umsätze gefunden');
  if (rest.length) first.additional = rest;
  return first;
}
