import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { extract, isLikelyFinanceText, looksTabular } from '../src/lib/extract/index.js';
import { blocksToLines } from '../src/lib/extract/ocr.js';
import { decodeText, sniffDelimiter, parseCsv } from '../src/lib/extract/decode.js';

const SAMPLES = fileURLToPath(new URL('../samples/out/', import.meta.url));

function fileOf(rel) {
  const bytes = readFileSync(SAMPLES + rel);
  const name = rel.split('/').pop();
  const ext = name.split('.').pop().toLowerCase();
  return { meta: { name, path: rel, ext, mime: '', size: bytes.length }, blob: new Blob([bytes]) };
}

async function run(rel, opts = {}) {
  const { meta, blob } = fileOf(rel);
  return extract(meta, blob, opts);
}

describe('PDF (Text-Ebene)', () => {
  it('ING Kontoauszug: Text, Seiten und Zeilen', async () => {
    const r = await run('Banken/ING/ing_kontoauszug_2026-03.pdf');
    expect(r.kind).toBe('pdf');
    expect(r.meta.pageCount).toBe(2);
    expect(r.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(r.text).toContain('Alter Saldo');
    expect(r.text).toContain('\n\f\n');
    expect(r.ocr).toBe(false);
    expect(r.ocrConfidence).toBeNull();
    expect(r.thumbnail).toBeNull(); // Node: keine Vorschau
    expect(r.xml).toBeNull();
    const line = r.pages[0].lines.find((l) => l.text.includes('Alter Saldo'));
    expect(line).toBeTruthy();
    expect(line.items.length).toBeGreaterThan(0);
    expect(line.items[0]).toHaveProperty('x');
    // Zeilen von oben nach unten
    const ys = r.pages[0].lines.map((l) => l.y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
  });

  it('Rechnung und Lohnsteuerbescheinigung enthalten die erwarteten Werte', async () => {
    const amazon = await run('Belege/rechnung_amazon_monitor_2026-04.pdf');
    expect(amazon.text).toContain('RE-AMZ-2026-0407-7781');
    expect(amazon.text).toContain('07.04.2026');
    const lst = await run('Steuer/lohnsteuerbescheinigung_2025.pdf');
    expect(lst.text).toContain('60.000,00');
    expect(lst.text).toContain('Frigotechnik GmbH');
  });

  it('Abbruchsignal wirft AbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { meta, blob } = fileOf('Banken/ING/ing_kontoauszug_2026-03.pdf');
    await expect(extract(meta, blob, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('CSV / Tabellen', () => {
  it('ING CSV: cp1252 mit Umlauten, Semikolon, Preamble', async () => {
    const r = await run('Banken/ING/ing_girokonto_2026H1.csv');
    expect(r.kind).toBe('csv');
    expect(r.meta.encoding).toBe('windows-1252');
    expect(r.meta.delimiter).toBe(';');
    expect(r.rawText).toContain('Währung');
    expect(r.rawText).toContain('Wertstellungsdatum');
    expect(r.rawText).toContain('Gehalt 06/2026');
    const header = r.rows.find((row) => row.includes('Buchung'));
    expect(header).toEqual(['Buchung', 'Wertstellungsdatum', 'Auftraggeber/Empfänger', 'Buchungstext', 'Verwendungszweck', 'Saldo', 'Währung', 'Betrag', 'Währung']);
    const salary = r.rows.find((row) => row[2] === 'Frigotechnik GmbH');
    expect(salary[7]).toBe('3.290,98');
    expect(r.text).toBe(r.rawText);
  });

  it('comdirect Girokonto: Latin-1, Semikolon trotz Kommas in Beträgen', async () => {
    const r = await run('Banken/comdirect/comdirect_girokonto_2026H1.csv');
    expect(r.kind).toBe('csv');
    expect(r.meta.encoding).toBe('windows-1252');
    expect(r.meta.delimiter).toBe(';');
    const header = r.rows.find((row) => row.includes('Buchungstag'));
    expect(header).toEqual(['Buchungstag', 'Wertstellung (Valuta)', 'Vorgang', 'Buchungstext', 'Umsatz in EUR']);
    const transfer = r.rows.find((row) => row[2] === 'Überweisung');
    expect(transfer).toBeTruthy();
    expect(transfer[4]).toBe('300,00');
    expect(r.rawText).toContain('Ausführung');
  });

  it('comdirect Depot: Felder und Summenzeile', async () => {
    const r = await run('Banken/comdirect/comdirect_depot_2026-06-30.csv');
    expect(r.kind).toBe('csv');
    expect(r.meta.delimiter).toBe(';');
    expect(r.rows.some((row) => row[0] === 'Muster MSCI World UCITS ETF' && row[5] === '4.198,65')).toBe(true);
    expect(r.rows.some((row) => row[0] === 'Summe Depotwert' && row[5] === '7.352,51')).toBe(true);
  });

  it('PayPal: UTF-8 mit BOM, Komma-Trennzeichen, BOM entfernt', async () => {
    const r = await run('Banken/PayPal/paypal_aktivitaeten_2026H1.csv');
    expect(r.kind).toBe('csv');
    expect(r.meta.encoding).toBe('utf-8-bom');
    expect(r.meta.delimiter).toBe(',');
    expect(r.rawText.charCodeAt(0)).not.toBe(0xfeff);
    expect(r.rows[0][0]).toBe('Datum');
    expect(r.rows[0]).toContain('Währung');
    expect(r.rows[1][3]).toBe('ING Girokonto');
    expect(r.rows[1][7]).toBe('89,90');
  });

  it('Trennzeichen-Erkennung', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(sniffDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(sniffDelimiter('"x,y";"z"\n"1,5";"2"')).toBe(';');
  });

  it('parseCsv: Quotes, Zeilenumbrüche und nachgestellte Felder', () => {
    const { rows } = parseCsv('"a ""q""";"b\nc";\n1;2;');
    expect(rows[0]).toEqual(['a "q"', 'b\nc']);
    expect(rows[1]).toEqual(['1', '2']);
  });

  it('.txt mit Tabellenstruktur wird CSV, Fließtext bleibt Text', async () => {
    const tab = new Blob(['Datum;Betrag;Text\n01.02.2026;12,50;Bäcker\n02.02.2026;3,00;Kiosk\n03.02.2026;7,25;Café\n']);
    const r1 = await extract({ name: 'umsatz.txt', ext: 'txt' }, tab, {});
    expect(r1.kind).toBe('csv');
    expect(r1.rows[2]).toEqual(['02.02.2026', '3,00', 'Kiosk']);
    const prose = new Blob(['Ein Satz, der nicht tabellarisch ist.\nUnd noch einer, mit Komma.\n']);
    const r2 = await extract({ name: 'notiz.txt', ext: 'txt' }, prose, {});
    expect(r2.kind).toBe('text');
  });

  it('looksTabular', () => {
    expect(looksTabular('a;b\nc;d\ne;f')).toBe(true);
    expect(looksTabular('nur eine Zeile;')).toBe(false);
    expect(looksTabular('Milch\nBrot\nEier')).toBe(false);
  });

  it('xlsx: mehrere Blätter, Datum als dd.mm.yyyy, Text als Strings', async () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
      ['Datum', 'Betrag', 'Text'],
      [new Date(Date.UTC(2026, 2, 14)), -12.5, 'Bäckerei'],
      [new Date(Date.UTC(2026, 2, 15)), 3290.98, 'Gehalt'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws1, 'Umsätze');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summe', 3278.48]]), 'Summen');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([buf]);
    const r = await extract({ name: 'umsaetze.xlsx', ext: 'xlsx' }, blob, {});
    expect(r.kind).toBe('xlsx');
    expect(r.rows[0]).toEqual(['Datum', 'Betrag', 'Text']);
    expect(r.rows[1][0]).toBe('14.03.2026');
    expect(r.rows[1][2]).toBe('Bäckerei');
    expect(r.rows).toContainEqual([]); // Leerzeile zwischen Blättern
    expect(r.rows.at(-1)).toEqual(['Summe', '3278.48']);
    expect(r.text).toContain('Bäckerei');
  });
});

describe('XML und Text', () => {
  it('camt.053 XML: kind xml mit xml und rawText', async () => {
    const r = await run('Banken/ING/camt053_ing_2026-05.xml');
    expect(r.kind).toBe('xml');
    expect(r.xml).toContain('camt.053.001.08');
    expect(r.rawText).toBe(r.xml);
    expect(r.text).toBe(r.xml);
    expect(r.rows).toBeNull();
    expect(r.meta.encoding).toBe('utf-8');
  });

  it('einkaufszettel.txt: kind text, rows null', async () => {
    const r = await run('einkaufszettel_handschrift.txt');
    expect(r.kind).toBe('text');
    expect(r.rows).toBeNull();
    expect(r.rawText).toContain('Milch');
    expect(r.text).toBe(r.rawText);
  });

  it('Rezept (txt) ist kein Finanzdokument', async () => {
    const r = await run('Privat/irrelevant_rezept.txt');
    expect(r.kind).toBe('text');
    expect(isLikelyFinanceText(r.text)).toBe(0);
  });

  it('MT940-Endung ergibt kind text', async () => {
    const blob = new Blob([':20:STMT\n:25:DE12500105170000000001\n']);
    const r = await extract({ name: 'auszug.sta', ext: 'sta' }, blob, {});
    expect(r.kind).toBe('text');
    expect(r.rawText).toContain(':25:');
  });

  it('unbekannte Binärdatei ist unsupported', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 0, 255, 0])]);
    const r = await extract({ name: 'daten.bin', ext: 'bin' }, blob, {});
    expect(r.kind).toBe('unsupported');
    expect(r.text).toBe('');
  });
});

describe('Bilder', () => {
  it('Bild in Node: kind image, leerer Text, keine Vorschau', async () => {
    const r = await run('Belege/kassenbon_rewe_2026-04-12.png');
    expect(r.kind).toBe('image');
    expect(r.text).toBe('');
    expect(r.pages).toEqual([]);
    expect(r.ocr).toBe(false);
    expect(r.thumbnail).toBeNull();
    expect(r.meta.pageCount).toBe(1);
  });
});

describe('OCR-Zeilen (blocksToLines)', () => {
  const word = (text, x0, y0, x1, y1) => ({ text, bbox: { x0, y0, x1, y1 }, confidence: 95 });
  const blocks = [{
    paragraphs: [
      { lines: [ // zweite Zeile oben im Bild: kleine y-Werte = oben
        { bbox: { x0: 0, y0: 200, x1: 300, y1: 220 }, words: [word('Summe', 0, 200, 80, 220), word('47,38', 200, 200, 300, 220)] },
      ] },
      { lines: [
        { bbox: { x0: 0, y0: 100, x1: 400, y1: 120 }, words: [word('EDEKA', 0, 100, 90, 120), word('Markt', 100, 100, 180, 120), word('Hamburg', 300, 100, 400, 120)] },
      ] },
    ],
  }];

  it('sortiert top-to-bottom, Items in pt-Einheiten, Text mit Spalten-Abstand', () => {
    const lines = blocksToLines(blocks, { unit: 2, height: 400 });
    expect(lines.map((l) => l.text)).toEqual(['EDEKA Markt   Hamburg', 'Summe   47,38']);
    expect(lines[0].y).toBeGreaterThan(lines[1].y);
    expect(lines[1].items[1]).toEqual({ x: 100, w: 50, str: '47,38' });
  });

  it('leere Blöcke und Wörter ergeben keine Zeilen', () => {
    expect(blocksToLines(undefined)).toEqual([]);
    expect(blocksToLines([{ paragraphs: [{ lines: [{ words: [word(' ', 0, 0, 1, 1)] }] }] }])).toEqual([]);
  });
});

describe('isLikelyFinanceText', () => {
  it('erkennt Rechnungs-/Kontotexte', async () => {
    const r = await run('Belege/rechnung_elektro_meyer_2026-02.pdf');
    expect(isLikelyFinanceText(r.text)).toBeGreaterThanOrEqual(0.5);
    expect(isLikelyFinanceText('Milch, Brot, Eier')).toBe(0);
    expect(isLikelyFinanceText('')).toBe(0);
    expect(isLikelyFinanceText('Betrag 12,00 EUR, IBAN DE00')).toBe(1);
    const s = isLikelyFinanceText('Summe 12,50 €');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('decodeText', () => {
  it('UTF-8, UTF-8 mit BOM und Windows-1252 Fallback', () => {
    expect(decodeText(new TextEncoder().encode('Müller')).text).toBe('Müller');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).text).toBe('A');
    const r = decodeText(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]));
    expect(r.text).toBe('Müller');
    expect(r.encoding).toBe('windows-1252');
  });
});
