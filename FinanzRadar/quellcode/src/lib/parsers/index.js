// Parser-Dispatcher: Detection → ParseResult (SPEC). Fehler führen nie zum Abbruch, sondern zu einem Prüf-Dokument.
import { parseStatement } from './docs/_statements.js';
import { parse as parseReceipt } from './docs/receipt.js';
import { parse as parseInvoice } from './docs/invoice.js';
import { parse as parsePayslip } from './docs/payslip.js';
import { parse as parseTaxcert } from './docs/taxcert.js';
import { parse as parseInsurance } from './docs/insurance.js';
import { parse as parseDonation } from './docs/donation.js';
import { parse as parseContract } from './docs/contract.js';
import { parse as parseShoppingList } from './docs/shoppinglist.js';
import { parse as parseGeneric } from './docs/generic.js';
import { baseDoc, baseResult } from './docs/util.js';
import { displayName, titleFor } from './naming.js';
import { extOf } from '../util/format.js';

const STATEMENT_TYPES = new Set(['kontoauszug', 'paypal', 'depot', 'kreditkarte']);

const DOC_PARSERS = {
  kassenbon: parseReceipt,
  rechnung: parseInvoice,
  lohn: parsePayslip,
  lohnsteuerbescheinigung: parseTaxcert,
  steuerbescheinigung: parseTaxcert,
  versicherung: parseInsurance,
  rente: parseInsurance,
  spende: parseDonation,
  vertrag: parseContract,
  einkaufszettel: parseShoppingList,
};

function finish(result, detection, fileMeta) {
  const doc = result.document;
  if (!doc.type) doc.type = detection?.type || 'finanz_sonstiges';
  if (doc.institution == null && detection?.institution) doc.institution = detection.institution;
  if (STATEMENT_TYPES.has(doc.type) && detection?.format) doc.fields = { format: detection.format, ...(doc.fields || {}) };
  if (!doc.title) doc.title = titleFor(doc);
  const ext = fileMeta?.ext || extOf(fileMeta?.name);
  doc.displayName = displayName(doc, ext);
  return result;
}

function failure(err, type, detection, fileMeta) {
  const doc = baseDoc(detection, {
    type: type && type !== 'irrelevant' ? type : 'finanz_sonstiges', title: fileMeta?.name || 'Dokument',
    needsReview: true, reviewReason: `Parser-Fehler: ${err?.message || err}`, confidence: 0.2,
  });
  return finish(baseResult(doc), detection, fileMeta);
}

/**
 * parse(detection, extracted, fileMeta) → ParseResult.
 * Dokument-Typen laufen synchron; Kontoumsatz-Typen liefern ein Promise (statements-Modul ist async).
 * Aufrufer sollten daher immer `await parse(...)` verwenden.
 */
export function parse(detection, extracted, fileMeta) {
  const type = detection?.type;
  try {
    if (STATEMENT_TYPES.has(type)) {
      return Promise.resolve(parseStatement(detection, extracted, fileMeta))
        .then((r) => finish(r, detection, fileMeta))
        .catch((err) => failure(err, type, detection, fileMeta));
    }
    const result = type === 'irrelevant'
      ? baseResult(baseDoc(detection, { type: 'irrelevant', title: fileMeta?.name || 'Nicht relevant' }))
      : (DOC_PARSERS[type] || parseGeneric)(extracted, fileMeta, detection);
    return finish(result, detection, fileMeta);
  } catch (err) {
    return failure(err, type, detection, fileMeta);
  }
}
