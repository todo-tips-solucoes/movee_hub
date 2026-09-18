/**
 * adiantamento-regras.js — helpers PUROS (sem I/O) de janela, D-1 calendário,
 * próxima oportunidade e texto de regras vigentes do módulo Adiantamento
 * (tasks.md FASE 2, 2.1).
 *
 * Espelha EXATAMENTE `hub_adiantamento_janela` / `hub_adiantamento_corte_passou`
 * de `infra/hub/migrations/0067_adiantamento_funcoes.sql` — mesma aritmética de
 * fronteira (`abertura <= agora < corte`), mesmo D-1 puro (sem dia útil/feriado).
 * O container roda em UTC: NUNCA usar a hora local do processo — todo cálculo
 * de "agora" no fuso da configuração passa por `Intl.DateTimeFormat` com
 * `timeZone` explícito (stdlib, sem dependência nova).
 *
 * `config` é o shape snake_case de `"AdiantamentoConfiguracao"` (mesmos nomes
 * de coluna do banco/da função SQL — não passa pelo mapper camelCase de
 * `adiantamento-dto.js`, que é só para a borda da API).
 *
 * Ref: plan.md §Regras "Janela"/"D-1 calendário"; Spec §FR-002, §FR-003,
 * §FR-005, §FR-007, §FR-008; contracts/motorista-api.md.
 */

'use strict';

const crypto = require('node:crypto');

const NOMES_DIA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** Componentes de data/hora locais de `instante` (Date) no fuso `timezone`,
 * via Intl.DateTimeFormat (stdlib) — não depende do TZ do processo. */
function partesNoFuso(instante, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const partes = {};
  for (const { type, value } of fmt.formatToParts(instante)) {
    if (type !== 'literal') partes[type] = value;
  }
  return {
    ano: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    // bug conhecido de ICU: hourCycle:'h23' pode devolver "24" à meia-noite.
    hora: Number(partes.hour) % 24,
    minuto: Number(partes.minute),
    segundo: Number(partes.second),
  };
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function dataISO(ano, mes, dia) {
  return `${pad(ano, 4)}-${pad(mes, 2)}-${pad(dia, 2)}`;
}

/** Dia da semana (0=domingo..6=sábado) de uma data de calendário — propriedade
 * do calendário, independente de fuso, uma vez fixados ano/mês/dia. */
function diaSemana(ano, mes, dia) {
  return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
}

/** Soma (ou subtrai) `delta` dias de calendário a uma data ano/mês/dia. */
function somarDias(ano, mes, dia, delta) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + delta);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/** Parseia `time` do Postgres (`"09:00:00"` ou `"09:00"`) em segundos do dia. */
function segundosDoHorario(hhmmss) {
  const [h, m, s] = String(hhmmss).split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function segundosDoDia(hora, minuto, segundo) {
  return hora * 3600 + minuto * 60 + segundo;
}

/**
 * Espelha `hub_adiantamento_janela(p_config, p_instante)`: mesmas 5 colunas,
 * mesmos nomes (snake_case) — usado para comparar lado a lado com o SQL nos
 * testes de fronteira (2.1.5).
 */
function janela(config, instante) {
  instante = instante || new Date();
  const tz = config.timezone;
  const p = partesNoFuso(instante, tz);
  const producao = somarDias(p.ano, p.mes, p.dia, -1);
  const dow = diaSemana(p.ano, p.mes, p.dia);
  const diaHabilitado = Array.isArray(config.dias_habilitados) && config.dias_habilitados.includes(dow);
  const segundosAgora = segundosDoDia(p.hora, p.minuto, p.segundo);

  return {
    data_solicitacao: dataISO(p.ano, p.mes, p.dia),
    data_producao: dataISO(producao.ano, producao.mes, producao.dia),
    dia_habilitado: diaHabilitado,
    antes_abertura: segundosAgora < segundosDoHorario(config.horario_abertura),
    apos_corte: segundosAgora >= segundosDoHorario(config.horario_corte),
  };
}

/** Espelha `hub_adiantamento_corte_passou` — usa o DIA da solicitação, não a
 * hora do dia corrente (dec-047: solicitação de dia anterior parada em
 * AGUARDANDO_CORTE não deve esperar o corte do dia corrente). */
function cortePassou(dataSolicitacaoISO, horarioCorte, timezone, instante) {
  const [ano, mes, dia] = dataSolicitacaoISO.split('-').map(Number);
  const [h, m, s] = String(horarioCorte).split(':').map(Number);
  const alvo = zonedTimeToUtc(ano, mes, dia, h, m, s || 0, timezone);
  return instante.getTime() >= alvo.getTime();
}

/** Instante UTC (Date) correspondente ao horário local `y-m-d h:mi:s` no fuso
 * `timezone` — inverso de `partesNoFuso`, por aproximação de ponto fixo
 * (2 iterações bastam para fusos sem transição de DST no instante alvo;
 * `America/Sao_Paulo` não observa DST desde 2019). */
function zonedTimeToUtc(ano, mes, dia, hora, minuto, segundo, timezone) {
  const alvoComoUtc = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo);
  let guess = alvoComoUtc;
  for (let i = 0; i < 2; i += 1) {
    const p = partesNoFuso(new Date(guess), timezone);
    const guessComoLocal = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
    guess -= guessComoLocal - alvoComoUtc;
  }
  return new Date(guess);
}

function formatarOffset(offsetMinutos) {
  // offset zero é sempre "+00:00" (2.6.2) — nunca "-00:00".
  const sinal = offsetMinutos < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutos);
  return `${sinal}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

/** Nomes amigáveis de fuso para exibição ao motorista (2.6.2) — fuso
 * desconhecido cai no próprio identificador IANA. */
const FUSOS_AMIGAVEIS = { 'America/Sao_Paulo': 'horário de Brasília' };
function nomeAmigavelFuso(timezone) {
  return FUSOS_AMIGAVEIS[timezone] || timezone;
}

/** Percentual em pt-BR: vírgula decimal, sem zeros à direita supérfluos
 * (`60` -> "60", `62.5` -> "62,5") — 2.6.2. */
function formatarPercentual(percentual) {
  const semZerosFinais = Number(percentual).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return semZerosFinais.replace('.', ',');
}

/**
 * `podeSolicitar` — janela + veredito (`canRequest`/`reason`) na ordem de
 * avaliação do contrato (dia → horário): `DAY_NOT_ALLOWED`, `BEFORE_OPENING`,
 * `AFTER_CUTOFF`. Não cobre `ALREADY_REQUESTED`/conta/vínculo/módulo — esses
 * dependem de estado fora desta lib pura (rota decide).
 */
function podeSolicitar(config, instante) {
  instante = instante || new Date();
  const j = janela(config, instante);
  const canRequest = j.dia_habilitado && !j.antes_abertura && !j.apos_corte;
  let reason = null;
  if (!canRequest) {
    reason = !j.dia_habilitado ? 'DAY_NOT_ALLOWED' : j.antes_abertura ? 'BEFORE_OPENING' : 'AFTER_CUTOFF';
  }
  return { ...j, canRequest, reason };
}

/**
 * `nextAvailableAt` (2.1.3): próximo dia habilitado + abertura, com offset do
 * fuso (ex.: `"2026-09-18T09:00:00-03:00"`). Se hoje ainda está habilitado e
 * o horário atual é antes da abertura, a próxima oportunidade é HOJE às
 * `horario_abertura`; senão, procura o próximo dia habilitado a partir de
 * amanhã (cobre dia desabilitado, depois do corte e já solicitado hoje —
 * quem chama decide quando vale a pena calcular).
 */
function nextAvailableAt(config, instante) {
  instante = instante || new Date();
  const tz = config.timezone;
  const p = partesNoFuso(instante, tz);
  const dowHoje = diaSemana(p.ano, p.mes, p.dia);
  const segundosAgora = segundosDoDia(p.hora, p.minuto, p.segundo);
  const antesAberturaHoje = segundosAgora < segundosDoHorario(config.horario_abertura);

  let candidato = { ano: p.ano, mes: p.mes, dia: p.dia };
  if (!(config.dias_habilitados.includes(dowHoje) && antesAberturaHoje)) {
    candidato = somarDias(p.ano, p.mes, p.dia, 1);
    // busca o próximo dia habilitado (limite de 7 tentativas — uma semana)
    for (let tentativas = 0; tentativas < 7 && !config.dias_habilitados.includes(diaSemana(candidato.ano, candidato.mes, candidato.dia)); tentativas += 1) {
      candidato = somarDias(candidato.ano, candidato.mes, candidato.dia, 1);
    }
  }

  const [h, m, s] = String(config.horario_abertura).split(':').map(Number);
  const alvo = zonedTimeToUtc(candidato.ano, candidato.mes, candidato.dia, h, m, s || 0, tz);
  const partesAlvo = partesNoFuso(alvo, tz);
  const offsetMinutos = Math.round((Date.UTC(candidato.ano, candidato.mes - 1, candidato.dia, h, m, s || 0) - alvo.getTime()) / 60000);

  return `${dataISO(partesAlvo.ano, partesAlvo.mes, partesAlvo.dia)}T${pad(partesAlvo.hora, 2)}:${pad(partesAlvo.minuto, 2)}:${pad(partesAlvo.segundo, 2)}${formatarOffset(offsetMinutos)}`;
}

/** Texto legível dos dias habilitados (`config.dias_habilitados`), na ordem
 * domingo..sábado. Usado só para exibição (FR-007) — não é dado financeiro. */
function textoDiasHabilitados(diasHabilitados) {
  return [...diasHabilitados]
    .sort((a, b) => a - b)
    .map((d) => NOMES_DIA[d])
    .join(', ');
}

/**
 * Texto das regras vigentes + hash de aceite (2.1.4/2.6.1, FR-005/FR-007):
 * os 8 blocos do protótipo aprovado M15/M06 (produção considerada,
 * percentual, taxa, dias disponíveis, prazo, pagamento, limite e repasse
 * semanal — D-11, D-12, D-14), com todo valor SEMPRE vindo da configuração
 * recebida — nunca fixo no código (FR-007). `aceiteSha256` é o sha256
 * hexadecimal do `texto` — gravado com a solicitação como prova do que foi
 * aceito (FR-005) e cobre os 8 termos, não só os 3 originais.
 *
 * `configVersion` = `config.versao` (contador de exibição — o protótipo
 * M06/M15 mostra "versão 3" ao motorista) e `configuracaoId` = `config.id`
 * (o PK bigint de `"AdiantamentoConfiguracao"`, o identificador que
 * `POST /motorista/adiantamentos` ecoa como `configuracaoId` e vira
 * `p_configuracao_id`). 3.7.3 (revisão da sessão pai, dec-071) separou os
 * dois: até a onda anterior (dec-069) `configVersion` era `config.id`
 * (correção de fiação para não quebrar `VERSAO_DESATUALIZADA`), mas isso
 * conflitava com o contrato ("configVersion: versão usada...") e com o
 * protótipo. Fonte: data-model.md ("versão vigente" é o comentário da FK
 * `configuracao_id`) + contracts/sql-rpc.md (`hub_adiantamento_solicitar
 * (p_configuracao_id bigint, ...)` compara contra `AdiantamentoConfiguracao.id`).
 */
function textoRegras(config) {
  const abertura = String(config.horario_abertura).slice(0, 5);
  const corte = String(config.horario_corte).slice(0, 5);
  const percentual = formatarPercentual(config.percentual);
  const taxa = Number(config.taxa_fixa).toFixed(2).replace('.', ',');
  const fuso = nomeAmigavelFuso(config.timezone);

  const itens = [
    {
      titulo: 'Produção considerada',
      descricao: 'Sua solicitação de hoje usa a produção registrada ontem.',
    },
    {
      titulo: 'Percentual',
      descricao: `Você pode antecipar ${percentual}% da produção elegível.`,
    },
    {
      titulo: 'Taxa',
      descricao: `R$ ${taxa} por solicitação, descontados do valor transferido.`,
    },
    {
      titulo: 'Dias disponíveis',
      descricao: `Dias habilitados: ${textoDiasHabilitados(config.dias_habilitados)}.`,
    },
    {
      titulo: 'Prazo',
      descricao: `Faça sua solicitação das ${abertura} até ${corte} (${fuso}).`,
    },
    {
      titulo: 'Pagamento',
      descricao: String(config.previsao_pagamento_texto || ''),
    },
    {
      titulo: 'Limite',
      descricao: `Uma solicitação por dia. Dias sem solicitação não acumulam. Você pode cancelar até o corte (${corte}).`,
    },
    {
      titulo: 'Repasse semanal',
      descricao: 'O valor bruto adiantado é descontado do repasse do período da produção.',
    },
  ];

  const texto = itens.map((i) => `${i.titulo}: ${i.descricao}`).join('\n');
  const aceiteSha256 = crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

  return { configVersion: config.versao, configuracaoId: config.id, texto, itens, aceiteSha256 };
}

module.exports = {
  janela,
  podeSolicitar,
  nextAvailableAt,
  cortePassou,
  textoRegras,
  textoDiasHabilitados,
  formatarPercentual,
  nomeAmigavelFuso,
  // expostos para reuso/teste (ex.: adiantamento-remanescente também precisa
  // de aritmética de calendário sem dia útil/feriado)
  partesNoFuso,
  diaSemana,
  somarDias,
  dataISO,
  zonedTimeToUtc,
};
