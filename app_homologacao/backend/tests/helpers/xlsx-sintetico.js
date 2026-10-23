'use strict';
/**
 * Fixtures XLSX SINTÉTICAS, geradas em memória pelo próprio SheetJS (FR-043/FR-051).
 * Nada aqui vem de planilha real: CNPJ = 90000000000000 + id; nomes fictícios.
 */
const XLSX = require('xlsx');

const CABECALHO = ['CNPJ', 'Data do pagamento', 'Valor', 'Nome', 'Observação'];
// 90000000000001 tem DV VÁLIDO (parece CNPJ real): o id 1 é a fixture mais usada, então sai da
// faixa e vai para 90000000001001. Os demais ids (2..99) têm DV inválido por construção.
const cnpjSintetico = (id) => String(id === 1 ? 90000000001001 : 90000000000000 + id);
const nomeSintetico = (id) => `Motorista Teste ${String(id).padStart(2, '0')}`;

/** Serial do Excel para y/m/d no epoch pedido (1900: Excel conta 1900-02-29 inexistente). */
function serial(y, m, d, date1904 = false) {
  const dias = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  return date1904 ? dias - 1462 : dias;
}

/** aoa -> XLSX (Buffer). `cellDates` controla como Date-objetos são gravados; `date1904` o epoch do livro. */
function xlsxDeAoa(aoa, { date1904 = false, cellDates = false, bookProps = true } = {}) {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Planilha1');
  if (bookProps) wb.Workbook = { WBProps: { date1904 } };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates });
}

const comCabecalho = (...linhas) => [CABECALHO, ...linhas];

// --- XLSX escrito À MÃO (ZIP "stored" + XML mínimo): o SheetJS recalcula `<dimension>` a partir da área e, para
// declarar 'A1:XFD1048576', o próprio `XLSX.write` leva 16 s. Aqui a dimensão é a que o teste mandar, e o custo é zero.
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (b) => { let c = -1; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();

function zipStored(arquivos) {
  const locais = [];
  const centrais = [];
  let off = 0;
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const n = Buffer.from(nome);
    const d = Buffer.from(conteudo);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(CRC(d), 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(CRC(d), 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locais.push(l, n, d); centrais.push(c, n);
    off += 30 + n.length + d.length;
  }
  const dir = Buffer.concat(centrais);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrais.length / 2, 8); e.writeUInt16LE(centrais.length / 2, 10); e.writeUInt32LE(dir.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locais, dir, e]);
}

/** XLSX com `<dimension>` ARBITRÁRIA. `linhas`: arrays (string vira inlineStr, número vira <v>); `extra` = XML de <row> cru apendado. */
function xlsxComDimensao(linhas, dimensao, extra = '') {
  const col = (i) => { let n = i + 1; let s = ''; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
  const xmlLinhas = linhas.map((l, r) => `<row r="${r + 1}">${l.map((v, i) => (v === '' ? '' : typeof v === 'number'
    ? `<c r="${col(i)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(i)}${r + 1}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`)).join('')}</row>`).join('');
  return zipStored({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Planilha1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimensao === null ? '' : `<dimension ref="${dimensao}"/>`}<sheetData>${xmlLinhas}${extra}</sheetData></worksheet>`,
  });
}

module.exports = { xlsxComDimensao, CABECALHO, cnpjSintetico, nomeSintetico, serial, xlsxDeAoa, comCabecalho };
