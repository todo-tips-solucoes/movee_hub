'use strict';
// Corte das "notas pendentes" do motorista: linha de AdiantamentoConfiguracao -> 'YYYY-MM-DD'
// (comparada com EnvioMassa.dt_inicial). Puro e testável; a leitura da config fica em routes/motorista.js.

const CORTE_PADRAO = '2026-07-20';

// Hoje no fuso do negócio (America/Sao_Paulo) menos `dias`, como 'YYYY-MM-DD'.
function hojeMenosDias(dias, agora = new Date()) {
  const hoje = agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  const d = new Date(`${hoje}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function calcularCorte(linha, agora = new Date()) {
  if (!linha) return CORTE_PADRAO;
  if (linha.notas_pendentes_corte_modo === 'dias') {
    const dias = Number(linha.notas_pendentes_corte_dias);
    return Number.isInteger(dias) && dias >= 1 ? hojeMenosDias(dias, agora) : CORTE_PADRAO;
  }
  const data = String(linha.notas_pendentes_corte_data || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : CORTE_PADRAO;
}

module.exports = { calcularCorte, hojeMenosDias, CORTE_PADRAO };
