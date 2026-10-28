// Text-Dekodierung mit Encoding-Erkennung (UTF-8 BOM → UTF-8 strikt → windows-1252)
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8-bom' };
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(u8), encoding: 'windows-1252' }; }
}

/** Trennzeichen erkennen anhand der ersten Zeilen */
export function sniffDelimiter(text) {
  // Gequotete Felder ignorieren (Kommas in Beträgen/Texten dürfen nicht zählen)
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 30).map(l => l.replace(/"[^"]*"/g, '""'));
  const cands = [';', ',', '\t', '|'];
  let best = ';', bestScore = -1;
  for (const c of cands) {
    const counts = lines.map(l => l.split(c).length - 1);
    const max = Math.max(...counts);
    const freq = counts.filter(x => x === max && x > 0).length;
    const score = max > 0 ? freq * 10 + max : -1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Einfacher, robuster CSV-Parser (Quotes, "" Escapes, Zeilenumbrüche in Quotes) */
export function parseCsv(text, delimiter) {
  const d = delimiter || sniffDelimiter(text);
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  // nachgestellte leere Spalten (comdirect "…;") entfernen
  return { rows: rows.map(r => { while (r.length > 1 && r[r.length - 1] === '') r.pop(); return r.map(c => c.trim()); }), delimiter: d };
}
