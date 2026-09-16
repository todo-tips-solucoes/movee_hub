// hub-avisos (push-motorista, FASE 7 — tasks.md 7.1.3): 1 caso por código de
// erro mapeado por lib/hub/avisos-api.ts, com o payload exato que
// routes/hub-avisos.js emite para cada um (grounded no backend real, lido em
// app_homologacao/backend/routes/hub-avisos.js e
// app_homologacao/backend/lib/hub-avisos-dto.js — não em suposição).
//
// Mesmo molde de fetch stub de lib/hub/api.test.ts / lib/hub/performance-api.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispararAviso, listarAvisos, obterAlcance, obterAviso } from './avisos-api';

function respostaFake(body: unknown, status: number) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('avisos-api — 1 caso por código de erro mapeado', () => {
  // routes/hub-avisos.js:522-528 — GET /:id 404 quando inexistente/expurgado/fora do escopo
  it('AVISO_NAO_ENCONTRADO (404, GET /:id)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'AVISO_NAO_ENCONTRADO' }, 404)));
    await expect(obterAviso(999)).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 404,
      codigo: 'AVISO_NAO_ENCONTRADO',
      message: 'Aviso não encontrado.',
    });
  });

  // requireModuloAtivo (middleware/hub-require-modulo.js:34-40) — 403 sem entidade ativa/módulo desligado
  it('MODULO_DESABILITADO (403)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'MODULO_DESABILITADO' }, 403)));
    await expect(listarAvisos()).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 403,
      codigo: 'MODULO_DESABILITADO',
      message: 'O módulo de avisos está desabilitado para esta empresa.',
    });
  });

  // routes/hub-avisos.js:146-148 — resolverContextoAvisos, mesmoGrupoQue negativo
  it('FORA_DO_GRUPO_MOVEE (403)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'FORA_DO_GRUPO_MOVEE' }, 403)));
    await expect(listarAvisos()).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 403,
      codigo: 'FORA_DO_GRUPO_MOVEE',
      message: 'Este recurso é exclusivo do grupo Movee.',
    });
  });

  // routes/hub-avisos.js:275/280 (GET /alcance) e hub-avisos-dto.js#validarAviso (POST /) —
  // motivo acompanha o código (contracts/hub-avisos.md §POST /api/v1/avisos)
  it('DADOS_INVALIDOS (400, com motivo "modo")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'DADOS_INVALIDOS', motivo: 'modo' }, 400)));
    await expect(obterAlcance({ modo: 'individual' as never })).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 400,
      codigo: 'DADOS_INVALIDOS',
      motivo: 'modo',
      message: 'Selecione um modo de destinatários válido.',
    });
  });

  // hub-avisos-dto.js#validarAviso:100-111 — título/corpo fora de 1-60/1-180 chars
  it('CONTEUDO_EXCEDE_LIMITE (400, POST /)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'CONTEUDO_EXCEDE_LIMITE' }, 400)));
    await expect(
      dispararAviso({
        titulo: 'x'.repeat(61),
        corpo: 'y',
        modoDestinatarios: 'toda_base',
        destinatariosIds: [],
        chaveIdempotencia: '11111111-1111-1111-1111-111111111111',
      })
    ).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 400,
      codigo: 'CONTEUDO_EXCEDE_LIMITE',
      message: 'Título ou mensagem excede o limite de caracteres.',
    });
  });

  // routes/hub-avisos.js:301-304/461-464 — RPC hub_aviso_alcance/hub_aviso_criar recusam destino fora do escopo
  it('DESTINATARIOS_FORA_DO_ESCOPO (403)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'DESTINATARIOS_FORA_DO_ESCOPO' }, 403)));
    await expect(obterAlcance({ modo: 'empresa', ids: [1] })).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 403,
      codigo: 'DESTINATARIOS_FORA_DO_ESCOPO',
      message: 'Um ou mais destinatários estão fora do escopo permitido.',
    });
  });

  // routes/hub-avisos.js:458-459 — 0 inscrições ativas no momento do disparo
  it('SEM_INSCRICOES_ATIVAS (422, POST /)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'SEM_INSCRICOES_ATIVAS' }, 422)));
    await expect(
      dispararAviso({
        titulo: 'Aviso',
        corpo: 'Corpo',
        modoDestinatarios: 'toda_base',
        destinatariosIds: [],
        chaveIdempotencia: '11111111-1111-1111-1111-111111111111',
      })
    ).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 422,
      codigo: 'SEM_INSCRICOES_ATIVAS',
      message: 'Nenhum motorista está com notificações ativas no momento.',
    });
  });

  // disparoRateLimiter (30/15min) e consultaEnvioRateLimiter (120/15min) por usuário
  // (routes/hub-avisos.js) — os dois devolvem LIMITE_EXCEDIDO, por isso a mensagem cita os dois casos
  it('LIMITE_EXCEDIDO (429)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'LIMITE_EXCEDIDO' }, 429)));
    await expect(listarAvisos()).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 429,
      codigo: 'LIMITE_EXCEDIDO',
      message: 'Limite temporário atingido (disparos ou consultas de alcance). Tente novamente em alguns minutos.',
    });
  });

  // routes/hub-avisos.js:287-289/431-432 — getKeyAtual() lança (chave VAPID ausente/inválida)
  it('PUSH_INDISPONIVEL (503)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'PUSH_INDISPONIVEL' }, 503)));
    await expect(obterAlcance({ modo: 'toda_base' })).rejects.toMatchObject({
      name: 'AvisoApiError',
      status: 503,
      codigo: 'PUSH_INDISPONIVEL',
      message: 'Serviço de notificações indisponível no momento.',
    });
  });
});
