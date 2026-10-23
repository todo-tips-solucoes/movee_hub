'use strict';
/**
 * Varredura de PII em fixture XLSX. Lê o FORMATO REAL das células pelo SheetJS
 * (inclui `t="str"><v>` e shared strings) — NUNCA procura tag `<t>` à mão, que num
 * XLSX gravado pelo SheetJS devolve "0 strings" num arquivo cheio de texto e faz
 * um "limpo" falso. Por isso `varrer` LANÇA se não inspecionou nenhuma célula
 * de texto (varredura oca) e o teste exige que ela reprove no controle negativo.
 */
const XLSX = require('xlsx');

const PREFIXO_CNPJ_SINTETICO = '900000000';
const NOME_SINTETICO = /^Motorista Teste \d{2,}$/;
// Observação sintética: valor FECHADO. Um prefixo livre (`^obs `) desarmava a varredura na única coluna
// de texto livre — exatamente onde o financeiro escreve nome de terceiro.
const OBS_SINTETICA = /^obs( sintetica)?$/i;
const ROTULOS = new Set(['CNPJ', 'Data do pagamento', 'Valor', 'Nome', 'Observação']);

function varrer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const achados = [];
  let inspecionadas = 0;
  for (const nome of wb.SheetNames) {
    const ws = wb.Sheets[nome];
    for (const ref of Object.keys(ws)) {
      if (ref[0] === '!') continue;
      const c = ws[ref];
      const v = String(c.v ?? '').trim();
      if (v === '') continue;
      inspecionadas += 1;
      if (ROTULOS.has(v)) continue;
      const digitos = v.replace(/\D/g, '');
      if (digitos.length >= 11 && !digitos.startsWith(PREFIXO_CNPJ_SINTETICO)) achados.push({ ref, tipo: 'documento' });
      else if (/\p{L}{2,}\s+\p{L}{2,}/u.test(v) && !NOME_SINTETICO.test(v) && !OBS_SINTETICA.test(v)) achados.push({ ref, tipo: 'nome' });
    }
  }
  if (inspecionadas === 0) throw new Error('varredura oca: nenhuma célula inspecionada');
  return { inspecionadas, achados };
}

module.exports = { varrer };
