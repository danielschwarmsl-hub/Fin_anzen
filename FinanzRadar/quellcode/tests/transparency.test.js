// Transparenz: Begründung der Typerkennung, anonymisierter Erkennungsbericht, Importfehler in Klartext
import { describe, it, expect } from 'vitest';
import { explainDetection } from '../src/lib/detect/index.js';
import { anonymizeText, keepWord, clipText, detectionReport } from '../src/lib/util/anonymize.js';
import { friendlyError } from '../src/lib/util/errors.js';

const LABELS = { kontoauszug: 'Kontoauszug', steuerbescheinigung: 'Steuerbescheinigung', wertpapier: 'Wertpapier / Depot', lohn: 'Lohnabrechnung' };

// Kontoauszug als reiner Text (so liegt er im Dokument-Datensatz): Spaltenkopf, 54 Datumszeilen, Gehalts-Stichwörter
function dkbText() {
  const rows = [];
  for (let i = 0; i < 54; i++) {
    const d = String((i % 28) + 1).padStart(2, '0');
    rows.push(`${d}.08.2026   ${i % 9 === 0 ? 'Gutschrift   Arbeitgeber GmbH LOHN/GEHALT Netto' : 'Lastschrift   Stadtwerke Musterstadt Abschlag'}   ${i % 9 === 0 ? '' : '-'}${(i + 1) * 3},50`);
  }
  return ['Deutsche Kreditbank AG', 'Kontoauszug 8/2026', 'Max Mustermann', 'IBAN DE02 1203 0000 0000 2020 51',
    'Kontostand am 31.07.2026   1.234,56', 'Datum   Erläuterung   Betrag EUR', ...rows, 'Kontostand am 31.08.2026   999,99'].join('\n');
}

describe('explainDetection', () => {
  it('Kontoauszug: Spaltenkopf und Datumszeilen als Begründung', () => {
    const ex = explainDetection({ text: dkbText() }, { name: 'auszug.pdf', ext: 'pdf' }, { labels: LABELS });
    expect(ex.type).toBe('kontoauszug');
    expect(ex.statement?.won).toBe(true);
    expect(ex.statement.header).toBe('Datum Erläuterung Betrag EUR');
    expect(ex.statement.dateLines).toBe(54);
    expect(ex.lines[0]).toMatch(/^Kontoauszug – erkannt an: Spaltenkopf ‚Datum Erläuterung Betrag EUR‘, 54 Datumszeilen/);
  });

  it('Stichwort-Typen: beste drei mit Punkten und auslösenden Wörtern', () => {
    const text = 'Jahressteuerbescheinigung 2025\nKapitalertragsteuer 12,00\nFreistellungsauftrag erteilt\nSolidaritätszuschlag';
    const ex = explainDetection({ text }, { name: 'bescheinigung.pdf' }, { labels: LABELS });
    expect(ex.type).toBe('steuerbescheinigung');
    expect(ex.statement).toBeNull();
    expect(ex.ranked[0].type).toBe('steuerbescheinigung');
    expect(ex.ranked[0].points).toBeGreaterThan(4);
    expect(ex.ranked.length).toBeLessThanOrEqual(3);
    expect(ex.lines[0]).toMatch(/^Steuerbescheinigung \([\d,]+ Punkte\): .*Kapitalertragsteuer.*Freistellungsauftrag/);
  });

  it('akzeptiert reinen Text und Seiten mit Seitenvorschub', () => {
    const ex = explainDetection('Gehaltsabrechnung\nBrutto 3.000,00\nNetto 2.000,00\nSteuerklasse 1\n\f\nSeite 2', { name: 'x.pdf' }, { labels: LABELS });
    expect(ex.type).toBe('lohn');
    expect(ex.lines[0]).toMatch(/^Lohnabrechnung \(/);
  });

  it('mask: Spaltenkopf und Daten in Signalen werden für den Bericht anonymisiert', () => {
    const ex = explainDetection({ text: dkbText().replace('Datum   Erläuterung', 'Datum   Mustermann') }, { name: 'a.pdf' }, { mask: anonymizeText, labels: LABELS });
    expect(ex.lines[0]).toContain('‚Datum Xxxxxxxxxx Betrag EUR‘');
    expect(ex.lines[0]).toContain('54 Datumszeilen');
  });

  it('ohne Treffer: verständlicher Hinweis', () => {
    const ex = explainDetection({ text: 'Urlaubsgrüße vom Strand, das Wetter ist schön und wir baden viel.' }, { name: 'karte.pdf' });
    expect(ex.type).toBe('irrelevant');
    expect(ex.lines.join(' ')).toMatch(/Keine Finanzbegriffe/);
  });
});

describe('anonymizeText', () => {
  it('Beträge und Datum: Ziffern → 0, Format bleibt', () => {
    expect(anonymizeText('Betrag 1.077,30 EUR')).toBe('Betrag 0.000,00 EUR');
    expect(anonymizeText('Valuta 19.08.2026')).toBe('Valuta 00.00.0000');
    expect(anonymizeText('-75.00')).toBe('-00.00');
  });

  it('IBAN, BIC, E-Mail, Telefon und URL ersetzt', () => {
    const out = anonymizeText('IBAN DE89 3704 0044 0532 0130 00 BIC: COBADEFFXXX\nmax.mustermann@gmx.de Tel. 0171 1234567\nhttps://meinedomain.de/u/max www.comdirect.de/konto');
    expect(out).toContain('IBAN DE00 0000 0000 0000 0000 00');
    expect(out).toContain('BIC: XXXXXXXXXXX');
    expect(out).not.toMatch(/mustermann|gmx/i);
    expect(out).toContain('Tel. 0000 0000000');
    expect(out).not.toContain('meinedomain');
    expect(out).toContain('www.comdirect.de/…');
    expect(out).not.toMatch(/[1-9]/);
  });

  it('Namen und Adressen ausgeblendet (gleiche Länge), auch am Zeilenanfang', () => {
    const out = anonymizeText('Herrn Max Mustermann\nMusterstraße 12\n12345 Musterstadt\nKontoinhaber: Erika MUSTERFRAU');
    expect(out).toBe('Herrn Xxx Xxxxxxxxxx\nXxxxxxxxxxxx 00\n00000 Xxxxxxxxxxx\nKontoinhaber: Xxxxx XXXXXXXXXX');
  });

  it('Fachbegriffe, Spaltenköpfe, Buchungsarten und Banknamen bleiben lesbar', () => {
    const src = 'Datum   Erläuterung   Betrag Soll EUR   Betrag Haben EUR\nSEPA-Lastschrift   Kartenzahlung   Dauerauftrag   Gutschrift\n'
      + 'comdirect   DKB   MLP Vermögensdepot   PayPal   Commerzbank\nGeschäftsabrechnung Wertpapierkauf Kurswert Handelsplatz Xetra Zu Ihren Lasten\n'
      + 'Kapitalertragsteuer Solidaritätszuschlag Kontoführungsentgelt Sammelüberweisung Buchungen Abschlussposten';
    expect(anonymizeText(src)).toBe(src);
  });

  it('Zeilenstruktur und Abstände bleiben erhalten', () => {
    const src = 'Datum      Betrag\n\n01.02.2026   Mustermann   -12,50\f\nSeite 2';
    const out = anonymizeText(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').map((l) => l.length)).toEqual(src.split('\n').map((l) => l.length));
  });

  it('keepWord: Satzanfang und Komposita', () => {
    expect(keepWord('Bitte')).toBe(true);
    expect(keepWord('Die')).toBe(true);
    expect(keepWord('Depotübersicht')).toBe(true);
    expect(keepWord('Schneider')).toBe(false);
    expect(keepWord('Kaufmann')).toBe(false);
  });

  it('clipText kürzt an einer Zeilengrenze mit Hinweis', () => {
    const t = Array.from({ length: 2000 }, (_, i) => `Zeile ${i}`).join('\n');
    const c = clipText(t, 1000);
    expect(c.length).toBeLessThan(1100);
    expect(c).toMatch(/gekürzt, insgesamt/);
  });
});

describe('detectionReport', () => {
  it('enthält Metadaten, Begründung, Diagnose und den anonymisierten Text', () => {
    const rep = detectionReport({
      appVersion: '1.0.0', parserVersion: 4, fileExt: 'pdf', pages: 6, ocr: true, ocrConfidence: 81, type: 'kontoauszug', typeName: 'Kontoauszug',
      confidence: 0.9, explanation: ['Kontoauszug – erkannt an: 54 Datumszeilen'], problems: ['Laut Auszug 54 Transaktionen, gelesen 51.', '3 Datumszeilen ohne Betrag (Seite 2) – z. B. „01.08.2026 Max Mustermann Miete 1.200,00“.', 'Saldo geht nicht auf: Anfang 1.234,56 €'],
      text: dkbText(),
    });
    expect(rep).toContain('App 1.0.0 · Parser-Version 4');
    expect(rep).toContain('Seiten: 6 · OCR: ja, Sicherheit 81 %');
    expect(rep).toContain('Erkannt: Kontoauszug · Sicherheit 90 %');
    expect(rep).toContain('- Kontoauszug – erkannt an: 54 Datumszeilen');
    expect(rep).toContain('Diagnose beim Einlesen:');
    expect(rep).toContain('- Laut Auszug 54 Transaktionen, gelesen 51.');
    expect(rep).toContain('(Seite 2) – z. B. „00.00.0000 Xxx Xxxxxxxxxx Miete 0.000,00“');
    expect(rep).toContain('Anfang 0.000,00 €');
    expect(rep).not.toMatch(/Mustermann|DE02 1203/);
    expect(rep).toContain('Datum   Erläuterung   Betrag EUR');
    expect(rep).toContain('IBAN DE00 0000 0000 0000 0000 00');
  });
});

describe('friendlyError', () => {
  it('übersetzt bekannte technische Meldungen', () => {
    expect(friendlyError('Setting up fake worker failed: "Cannot load script".').text).toBe('PDF-Leser ist abgestürzt – Datei bitte erneut einlesen');
    expect(friendlyError('Worker was destroyed').text).toBe('PDF-Leser ist abgestürzt – Datei bitte erneut einlesen');
    expect(friendlyError('Invalid PDF structure.').text).toBe('Datei ist keine gültige PDF');
    expect(friendlyError('No password given').text).toBe('PDF ist passwortgeschützt');
    expect(friendlyError('PDF ist passwortgeschützt')).toEqual({ text: 'PDF ist passwortgeschützt', detail: null, retry: false });
    expect(friendlyError('Abgebrochen').retry).toBe(true);
  });

  it('Unbekanntes: allgemeiner Satz plus Originaltext', () => {
    const f = friendlyError(new Error('TypeError: x is undefined'));
    expect(f.text).toBe('Datei konnte nicht gelesen werden');
    expect(f.detail).toBe('TypeError: x is undefined');
    expect(f.retry).toBe(true);
    expect(friendlyError(null).detail).toBeNull();
  });
});
