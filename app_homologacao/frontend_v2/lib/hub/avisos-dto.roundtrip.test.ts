// hub-avisos (push-motorista, tasks.md 9.6.2 — Scenario 20 do quickstart):
// roundtrip end-to-end obrigatório. Os corpos abaixo NÃO são fixture
// inventada — são a captura REAL de um hub-test efêmero (100+ inscrições,
// disparo toda_base real, sem mock do lado do backend), salva em
// __fixtures__/roundtrip-cenario20-bodies.json por
// infra/hub/testes/hub-avisos-carga-roundtrip-integration.sh (tasks.md 9.5).
// As 3 rotas do frontend_motorista (chave-publica/inscricao/avisos/:id) não
// têm parser dedicado aqui — cobertas pelo E2E Playwright do cenário 1/12/13
// (hub-motorista-push-e2e-browser.sh, já verde).
import { describe, expect, it } from 'vitest';
import {
  contagensBatem,
  parseAvisoAlcance,
  parseAvisoCriado,
  parseAvisoDetalhe,
  parseAvisosCobertura,
} from './avisos-dto';
import corpos from './__fixtures__/roundtrip-cenario20-bodies.json';

describe('Scenario 20 (roundtrip real) — corpos capturados batem com os parsers', () => {
  it('POST /avisos: parseAvisoCriado aceita o corpo real sem lançar', () => {
    const r = parseAvisoCriado(corpos.disparo_body);
    expect(r).toEqual({ id: 1, status: 'na_fila', visados: 101 });
  });

  it('GET /avisos/:id: parseAvisoDetalhe aceita o corpo real sem lançar e contagens batem (SC-006)', () => {
    const r = parseAvisoDetalhe(corpos.aviso_detalhe);
    expect(r.status).toBe('concluido');
    expect(r.modoDestinatarios).toBe('toda_base');
    expect(contagensBatem(r)).toBe(true);
    // 100 aceitos + 1 falha (endpoint sem porta, não entregável de propósito
    // — ver comentário no driver) + 0 mortas = 101 visados.
    expect(r.contagens).toEqual({ visados: 101, pendentes: 0, processando: 0, aceitos: 100, falhas: 1, mortas: 0 });
  });

  it('GET /avisos/alcance: parseAvisoAlcance aceita o corpo real sem lançar', () => {
    expect(parseAvisoAlcance(corpos.alcance_body)).toEqual({ motoristas: 101, inscricoes: 101 });
  });

  it('GET /avisos/cobertura: parseAvisosCobertura aceita o corpo real sem lançar', () => {
    const r = parseAvisosCobertura(corpos.cobertura_body);
    expect(r.ativos.android).toBe(1);
    expect(r.naoAtivadas).toBe(0);
  });
});
