'use strict';

/**
 * Núcleo de leitura de XLSX compartilhado pelos importadores de planilha
 * (retorno da Transfeera e lançamento externo). Transporta, SEM alteração, as
 * opções de leitura e as defesas do leitor do retorno (FR-052): teto de ZIP
 * conferido ANTES do SheetJS, `sheetRows`, `!fullref`, cabeçalho antes das linhas.
 *
 * A interpretação de cada coluna e os motivos de recusa NÃO moram aqui: ficam
 * duplicados de propósito em cada importador (FR-050). Os erros nascem da
 * fábrica `erro(motivo, mensagem)` injetada, para cada importador manter a sua
 * própria classe (`instanceof` na rota).
 */
const XLSX = require('xlsx');

/** Tetos do ZIP, conferidos no diretório central ANTES de o SheetJS tocar nos
 * bytes: deflate chega a ~1000:1, então 10 MB comprimidos podem ser GB. 32 MiB
 * = 4x o pior caso legítimo (10.000 linhas sem compressão ≈ 8,2 MB). */
const MAX_BYTES_DESCOMPRIMIDOS = 32 * 1024 * 1024;
const MAX_ENTRADAS_ZIP = 100;

/** Só abaixo disto a releitura sem `sheetRows` (dimensão declarada inflada) é permitida: uma planilha de verdade com
 * mais de `maxLinhas` linhas ocupa MB de XML; a que só tem a `<dimension>` inflada ocupa KB. */
const MAX_BYTES_RELEITURA = 2 * 1024 * 1024;

/** Reescreve `!ref` para a área onde há célula de fato e recusa área acima do teto — o custo do `sheet_to_json` é
 * proporcional à ÁREA, não ao tamanho do arquivo (2 células, A1 e XFD1048576, num arquivo de 5,7 KB custavam >90 s de
 * CPU com o backend inteiro parado; Node é single-thread). Reescrever também cura a `<dimension>` declarada MENOR que
 * o real: o SheetJS guarda as células de fora mas o `sheet_to_json` só lê o `!ref`, e metade do arquivo era importada
 * calada. LINHAS seguem a área real; COLUNAS ficam travadas em `maxColunas` (largura do cabeçalho esperado + 1
 * sentinela, que ainda faz coluna a mais com texto no cabeçalho ser recusada): alargar colunas não serve a nada e era a
 * origem do custo (184x) e da recusa por célula solta. O teto de células é, portanto, o de uma planilha de
 * `maxLinhas` linhas com folga de 2x para linhas em branco. */
function limitarArea(ws, erro, maxLinhas, maxColunas) {
  let r = -1;
  let c = -1;
  for (const k of Object.keys(ws)) {
    if (k[0] === '!') continue;
    const a = XLSX.utils.decode_cell(k);
    if (a.r > r) r = a.r;
    if (a.c > c) c = a.c;
  }
  if (r < 0) return;
  c = Math.min(c, maxColunas - 1);
  if ((r + 1) * (c + 1) > 2 * (maxLinhas + 2) * maxColunas) throw erro('ARQUIVO_MUITO_GRANDE', 'Área da planilha acima do teto');
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c } });
}

/** Confere o diretório central do ZIP (EOCD nos últimos 65.557 bytes) SEM
 * descomprimir nada: soma os tamanhos *declarados* e recusa bomba de
 * descompressão antes de o SheetJS tocar nos bytes. ZIP64 e EOCD ausente são
 * `FORMATO_INVALIDO` (um arquivo de ~1 MB nunca precisa de ZIP64). */
function conferirTetoZip(buf, erro) {
  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const inicio = Math.max(0, buf.length - 65557);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < inicio || eocd + 22 > buf.length || buf.readUInt32LE(eocd) !== SIG_EOCD) {
    throw erro('FORMATO_INVALIDO', 'ZIP sem diretório central');
  }
  const entradas = buf.readUInt16LE(eocd + 10);
  const tamanhoDir = buf.readUInt32LE(eocd + 12);
  const offsetDir = buf.readUInt32LE(eocd + 16);
  if (entradas === 0xffff || tamanhoDir === 0xffffffff || offsetDir === 0xffffffff) {
    throw erro('FORMATO_INVALIDO', 'ZIP64 não suportado');
  }
  if (entradas > MAX_ENTRADAS_ZIP) throw erro('ARQUIVO_MUITO_GRANDE', 'Entradas demais no ZIP');
  if (offsetDir + tamanhoDir > eocd) throw erro('FORMATO_INVALIDO', 'Diretório central fora do arquivo');

  let pos = offsetDir;
  let total = 0;
  for (let i = 0; i < entradas; i += 1) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw erro('FORMATO_INVALIDO', 'Entrada de ZIP corrompida');
    }
    const tamanho = buf.readUInt32LE(pos + 24);
    if (tamanho === 0xffffffff) throw erro('FORMATO_INVALIDO', 'ZIP64 não suportado');
    total += tamanho;
    if (total > MAX_BYTES_DESCOMPRIMIDOS) throw erro('ARQUIVO_MUITO_GRANDE', 'Conteúdo descomprimido acima do teto');
    pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return total;
}

/** Lê a primeira aba e devolve `{ linhas, numeros, date1904 }`: `linhas` = linhas de
 * dados (arrays, SEM o cabeçalho), `numeros` = o número de cada uma na planilha (1 = cabeçalho), `date1904` = a época do livro (necessária
 * para datas nativas). `bookProps:false` é o que vale hoje e NÃO deve ser
 * ligado. Ordem barato -> caro: só um ZIP dentro dos tetos chega ao
 * `XLSX.read`. Nada é executado: sem fórmula, sem HTML, sem estilos. */
function lerPlanilha(buffer, { cabecalhoEsperado, maxLinhas, erro, cabecalhoTolerante = false, areaReal = false }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw erro('FORMATO_INVALIDO', 'Corpo vazio');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw erro('FORMATO_INVALIDO', 'Não é um ZIP');
  const bytesDescomprimidos = conferirTetoZip(buffer, erro);

  const ler = (sheetRows) => {
    try {
      return XLSX.read(buffer, {
        type: 'buffer', ...(sheetRows ? { sheetRows } : {}), cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false, bookDeps: false, bookProps: false,
      });
    } catch {
      // A mensagem do SheetJS pode ecoar conteúdo de terceiro: nunca propagar.
      throw erro('FORMATO_INVALIDO', 'Planilha ilegível');
    }
  };
  let wb = ler(maxLinhas + 2);
  let ws = wb.SheetNames && wb.SheetNames.length ? wb.Sheets[wb.SheetNames[0]] : null;
  if (!ws) throw erro('FORMATO_INVALIDO', 'Planilha sem aba');

  const ref = ws['!fullref'] || ws['!ref'];
  let linhas = [];
  let numeros = null;

  if (!areaReal) {
    // Comportamento HISTÓRICO, idêntico ao do leitor do retorno da Transfeera em produção desde 30/09 (provado
    // contra o HEAD): confia na `<dimension>` do arquivo — declarada inflada recusa, declarada menor lê só ela.
    // `sheetRows` corta a leitura; `!fullref` guarda o tamanho REAL (cobre linhas em branco além do corte).
    if (ref && XLSX.utils.decode_range(ref).e.r > maxLinhas) {
      throw erro('ARQUIVO_MUITO_GRANDE', `Arquivo com mais de ${maxLinhas} linhas`);
    }
    // `blankrows:false` não descarta linha de células "" (o `defval` as conta como preenchidas): filtra depois.
    linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false })
      .filter((l) => l.some((c) => String(c).trim() !== ''));
  } else {
    // A `<dimension>` declarada pode estar INFLADA (o Excel a deixa assim ao apagar linhas: 1 linha de dados e
    // `A1:E20000`) ou MENOR que o real. Sendo a planilha pequena (KB), relê SEM corte e usa a área REAL; sendo grande
    // (MB de XML), a declaração vale e a recusa continua.
    const maxColunas = cabecalhoEsperado.length + 1;
    let cortada = true; // true = ainda é a leitura com `sheetRows` (pode ter descartado linhas além do teto)
    const declaradaGrande = ref && XLSX.utils.decode_range(ref).e.r > maxLinhas;
    if (bytesDescomprimidos <= MAX_BYTES_RELEITURA) {
      // Planilha pequena: relê SEM corte SEMPRE (não só quando a dimensão é inflada) — a `<dimension>` declarada
      // como "dentro do teto" não prova nada, e o corte do primeiro `ler` descartava o resto calado (rodada 5b, A2).
      wb = ler(0);
      ws = wb.SheetNames && wb.SheetNames.length ? wb.Sheets[wb.SheetNames[0]] : null;
      if (!ws) throw erro('FORMATO_INVALIDO', 'Planilha sem aba');
      cortada = false;
    } else if (declaradaGrande) {
      throw erro('ARQUIVO_MUITO_GRANDE', `Arquivo com mais de ${maxLinhas} linhas`);
    }
    limitarArea(ws, erro, maxLinhas, maxColunas);

    // `blankrows:true` preserva o índice: `!ref` começa em A1, então índice + 1 = número da linha na planilha —
    // o que o operador procura no Excel (rodada 4, M1).
    numeros = [];
    XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true }).forEach((l, r) => {
      if (l.some((c) => String(c).trim() !== '')) { linhas.push(l); numeros.push(r + 1); }
    });
    // Releitura SEM corte: a contagem de linhas não-vazias é a verdade (dado real depois de milhares de brancos é lido).
    // Leitura COM corte (XML > 2 MiB, dimensão declarada dentro do teto): o clamp do `sheetRows` garante enxergar uma
    // linha além do teto, e a rede é sobre o NÚMERO DA ÚLTIMA LINHA FÍSICA lida — não sobre a contagem de não-vazias,
    // que linha em branco dentro do corte reduz (rodada 5b, A2: 10.002 físicas passavam como se coubessem).
    const excede = cortada ? numeros.length && numeros[numeros.length - 1] > maxLinhas + 1 : linhas.length > maxLinhas + 1;
    if (excede) throw erro('ARQUIVO_MUITO_GRANDE', `Arquivo com mais de ${maxLinhas} linhas`);
  }
  if (!linhas.length) throw erro('ARQUIVO_VAZIO', 'Planilha vazia');

  let cabecalho = linhas[0].map((c) => String(c).trim());
  let esperado = cabecalhoEsperado;
  if (cabecalhoTolerante) {
    // Planilha feita À MÃO (não de máquina): tolera CAIXA, ACENTO e células VAZIAS sobrando à direita — nada além
    // disso. Coluna a mais com texto, a menos, ou em outra ordem continuam recusadas (as colunas não correspondem).
    while (cabecalho.length && cabecalho[cabecalho.length - 1] === '') cabecalho = cabecalho.slice(0, -1);
    const norm = (c) => String(c).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    cabecalho = cabecalho.map(norm);
    esperado = cabecalhoEsperado.map(norm);
  }
  if (JSON.stringify(cabecalho) !== JSON.stringify(esperado)) {
    throw erro('CABECALHO_INVALIDO', 'Cabeçalho não confere com o contrato observado');
  }
  if (linhas.length === 1) throw erro('ARQUIVO_VAZIO', 'Planilha só com cabeçalho');

  // `null` = epoch ilegível (campo ausente é anômalo: XLSX real sempre o popula, inclusive `false`).
  // Medido (rodada 1 do code review, P17): mesmo com `<workbookPr>` REMOVIDO do workbook.xml o SheetJS
  // devolve `date1904:false` (default dele) — então export de Sheets/LibreOffice sem o atributo é lido em 1900.
  const flag = wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904;
  const date1904 = typeof flag === 'boolean' ? flag : null;
  return { linhas: linhas.slice(1), numeros: numeros ? numeros.slice(1) : null, date1904 };
}

module.exports = { lerPlanilha, conferirTetoZip, MAX_BYTES_DESCOMPRIMIDOS, MAX_ENTRADAS_ZIP };
