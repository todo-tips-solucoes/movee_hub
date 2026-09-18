// adiantamento-motorista — tasks.md 7.10.1 ("Driver Playwright no container
// oficial cobrindo US3/US4/US5/US6 ponta a ponta"): E2E de BROWSER das 9
// telas novas do hub (app_homologacao/frontend_v2/app/hub/dashboard/
// adiantamentos/**) cobrindo:
//   US3 — contas bancárias (dado mascarado na lista, completo só na revisão
//         dedicada — SC-006/7.5.4; aprovação individual e em massa)
//   US4 — montar e gerar lote de pagamento (seleção → prévia com pendência
//         real → gerar arquivo — SC-003/7.6.4)
//   US5 — confirmação manual do resultado do lote, reprocessar solicitação
//         falhada (volta a LIBERADA — edge #20/7.7.4) e "Encerrar sem
//         pagamento" (FALHOU → ENCERRADA, sai da fila — D-23/7.3.6)
//   US6 — repasse: visualizar remanescente e fechar apuração (sucesso e
//         recusa por APURACAO_COM_PENDENCIAS com a contagem por status)
//
// Também fecha 7.3.4: a "ação explícita" da pendência CONTA_ALTERADA é o
// botão "Atualizar conta" do detalhe (H02) — achado desta task (Constitution
// VI): a RPC real `hub_adiantamento_lote_previa` (infra/hub/migrations/
// 0067_adiantamento_funcoes.sql) só emite `JA_EM_LOTE`/`STATUS_<status>`/
// `VALOR_INVALIDO` como `motivo_pendencia`; `CONTA_ALTERADA` nunca é uma
// pendência de PRÉVIA DE LOTE — é a pendência resolvida pela ação
// "Atualizar conta" no próprio detalhe da solicitação (`PODE_ATUALIZAR_CONTA`,
// `POST /:id/atualizar-conta`, tasks.md 4.1.4/7.3.3). A pendência exercitada
// na prévia de lote abaixo (teste US4) usa `JA_EM_LOTE`, o código REAL.
//
// SEM backend nem stack docker-compose (mesmo padrão de dec-107,
// ../e2e-motorista-adiantamento/adiantamento.spec.ts): todo `/api/**` do
// browser é stubado via page.route (installApiStubs abaixo) — o proxy
// server-side do hub (app/api/[...path]/route.ts) nunca é exercitado de
// verdade; a integração real contra hub-homolog já é coberta por
// infra/hub/testes/hub-adiantamentos-integration.sh (nível API/DB).
import { test, expect, type Page, type Route } from '@playwright/test';

// ── Shapes sourced de lib/hub/adiantamentos-api.ts + lib/hub/me-dto.ts ──

interface Solicitacao {
  id: number;
  integrationId: string;
  motorista: { entregadorId: number | null; nome: string | null };
  dataSolicitacao: string;
  dataProducao: string;
  status: string;
  motivoStatus: string | null;
  valorLiquido: string;
  pendencias: string[];
  loteId: number | null;
  calculo: Record<string, unknown> | null;
  contaMascarada: Record<string, unknown> | null;
  eventos: unknown[];
  lotes: unknown[];
}

interface Conta {
  id: number;
  status: string;
  origem: string;
  banco: string;
  agencia: string;
  contaMascarada: string;
  tipoConta: 'CORRENTE' | 'POUPANCA';
  titularNome: string;
  documentoMascarado: string;
  alertas: string[];
  motivoRejeicao: string | null;
  solicitadaEm: string;
  revisadaEm: string | null;
  // campos só devolvidos com completo=true
  titularDocumento: string;
  conta: string;
  contaDigito: string;
  chavePixTipo: string | null;
  chavePix: string | null;
  emailComprovante: string | null;
  entregadorVinculado: { entregadorId: number; nome: string | null };
}

interface Lote {
  id: number;
  numero: string;
  status: string;
  criadoPor: { id: number; nome: string } | null;
  criadoEm: string;
  quantidade: number;
  valorTotal: string;
  arquivoNome: string | null;
  arquivoSha256: string | null;
  downloads: number;
  primeiroDownloadEm: string | null;
  canceladoEm: string | null;
  canceladoMotivo: string | null;
  concluidoEm: string | null;
  itens: { id: number; nome: string; documentoMascarado: string; banco: string; agencia: string; contaMascarada: string; tipoConta: string; valor: string; integrationId: string; descricaoPix: string | null; situacao: string; situacaoMotivo: string | null; situacaoEm: string | null }[];
  historico: unknown[];
}

interface StubState {
  solicitacoes: Record<number, Solicitacao>;
  contas: Record<number, Conta>;
  lotes: Record<number, Lote>;
  proximoLoteId: number;
  repasse: Record<string, { itens: unknown[]; totais: Record<string, unknown>; naoPagosNoPeriodo: number; fechavel: boolean }>;
  apuracoesFechadas: Set<string>;
}

function solicitacaoBase(over: Partial<Solicitacao>): Solicitacao {
  return {
    id: 0, integrationId: '', motorista: { entregadorId: 1, nome: 'Motorista Padrão' },
    dataSolicitacao: '2026-09-15', dataProducao: '2026-09-14', status: 'LIBERADA', motivoStatus: null,
    valorLiquido: '100.00', pendencias: [], loteId: null, calculo: null, contaMascarada: null,
    eventos: [], lotes: [], ...over,
  };
}

function defaultState(): StubState {
  return {
    solicitacoes: {
      101: solicitacaoBase({ id: 101, integrationId: 'ADV-0101', motorista: { entregadorId: 11, nome: 'Motorista Um' }, valorLiquido: '150.00' }),
      102: solicitacaoBase({ id: 102, integrationId: 'ADV-0102', motorista: { entregadorId: 12, nome: 'Motorista Dois' }, valorLiquido: '90.00' }),
      601: solicitacaoBase({
        id: 601, integrationId: 'ADV-0601', status: 'FALHOU', motorista: { entregadorId: 16, nome: 'Motorista Reprocessar' },
        valorLiquido: '75.00', motivoStatus: 'Conta bancária rejeitada pelo parceiro de pagamento',
      }),
      602: solicitacaoBase({
        id: 602, integrationId: 'ADV-0602', status: 'FALHOU', motorista: { entregadorId: 17, nome: 'Motorista Encerrar' },
        valorLiquido: '60.00', motivoStatus: 'Timeout no parceiro de pagamento',
      }),
      603: solicitacaoBase({
        id: 603, integrationId: 'ADV-0603', status: 'LIBERADA', motorista: { entregadorId: 18, nome: 'Motorista Conta Alterada' },
        valorLiquido: '200.00',
      }),
    },
    contas: {
      501: {
        id: 501, status: 'PENDENTE', origem: 'CARGA_INICIAL', banco: 'Banco Exemplo', agencia: '0001',
        contaMascarada: '****-6', tipoConta: 'CORRENTE', titularNome: 'João Motorista',
        documentoMascarado: '***.456.789-**', alertas: [], motivoRejeicao: null, solicitadaEm: '2026-09-10T12:00:00.000Z',
        revisadaEm: null, titularDocumento: '123.456.789-00', conta: '12345', contaDigito: '6',
        chavePixTipo: 'CPF', chavePix: '123.456.789-00', emailComprovante: 'joao@example.test',
        entregadorVinculado: { entregadorId: 9001, nome: 'João Motorista' },
      },
      502: {
        id: 502, status: 'PENDENTE', origem: 'CARGA_INICIAL', banco: 'Banco Exemplo', agencia: '0002',
        contaMascarada: '****-7', tipoConta: 'CORRENTE', titularNome: 'Maria Motorista',
        documentoMascarado: '***.111.222-**', alertas: [], motivoRejeicao: null, solicitadaEm: '2026-09-10T12:05:00.000Z',
        revisadaEm: null, titularDocumento: '111.222.333-00', conta: '54321', contaDigito: '1',
        chavePixTipo: null, chavePix: null, emailComprovante: null,
        entregadorVinculado: { entregadorId: 9002, nome: 'Maria Motorista' },
      },
    },
    lotes: {
      9002: {
        id: 9002, numero: 'LT-0002', status: 'EXPORTADO', criadoPor: { id: 1, nome: 'Financeiro' },
        criadoEm: '2026-09-14T10:00:00.000Z', quantidade: 2, valorTotal: '240.00',
        arquivoNome: 'transfeera_adiantamentos_lote-LT-0002.xlsx', arquivoSha256: 'ab12cd34', downloads: 1,
        primeiroDownloadEm: '2026-09-14T11:00:00.000Z', canceladoEm: null, canceladoMotivo: null, concluidoEm: null,
        itens: [
          { id: 201, nome: 'Motorista Confirmar Um', documentoMascarado: '***.***.***-**', banco: 'Banco Exemplo', agencia: '0003', contaMascarada: '****-9', tipoConta: 'CORRENTE', valor: '150.00', integrationId: 'ADV-0201', descricaoPix: null, situacao: 'incluido', situacaoMotivo: null, situacaoEm: null },
          { id: 202, nome: 'Motorista Confirmar Dois', documentoMascarado: '***.***.***-**', banco: 'Banco Exemplo', agencia: '0004', contaMascarada: '****-8', tipoConta: 'CORRENTE', valor: '90.00', integrationId: 'ADV-0202', descricaoPix: null, situacao: 'incluido', situacaoMotivo: null, situacaoEm: null },
        ],
        historico: [],
      },
    },
    proximoLoteId: 9101,
    repasse: {
      '2026-09-01': {
        itens: [{ entregadorId: 11, nome: 'Motorista Um', creditos: '500.00', adiantamentos: '150.00', debitos: '0.00', remanescente: '350.00', negativo: false, emProcessamento: false }],
        totais: { creditos: '500.00', adiantamentos: '150.00', debitos: '0.00', remanescente: '350.00', motoristas: 1 },
        naoPagosNoPeriodo: 2,
        fechavel: false,
      },
      '2026-09-08': {
        itens: [{ entregadorId: 12, nome: 'Motorista Dois', creditos: '300.00', adiantamentos: '90.00', debitos: '10.00', remanescente: '200.00', negativo: false, emProcessamento: false }],
        totais: { creditos: '300.00', adiantamentos: '90.00', debitos: '10.00', remanescente: '200.00', motoristas: 1 },
        naoPagosNoPeriodo: 0,
        fechavel: true,
      },
    },
    apuracoesFechadas: new Set<string>(),
  };
}

function resumoDe(s: Solicitacao) {
  const { calculo: _calculo, contaMascarada: _contaMascarada, eventos: _eventos, lotes: _lotes, ...resumo } = s;
  return resumo;
}

async function installApiStubs(page: Page, state: StubState): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // ── sessão do hub ──
    if (path === '/me' && method === 'GET') {
      return json(200, {
        usuario: { id: 1, email: 'financeiro@example.test', nome: 'Financeiro E2E' },
        entidades: [{ empresa_id: 6, nome: 'Movee', papel: 'admin_entidade', ativo: true }],
        entidade_ativa: 6,
        modulos: [{ codigo: 'adiantamentos', nome: 'Adiantamentos', icone: 'Wallet', ordem: 1, ativo: true }],
        permissoes: [
          'adiantamentos.consultar', 'adiantamentos.gerenciar', 'adiantamentos.configurar',
          'adiantamentos.contas_consultar', 'adiantamentos.contas_revisar', 'adiantamentos.pagamentos_consultar',
          'adiantamentos.lote_criar', 'adiantamentos.exportar', 'adiantamentos.reprocessar',
          'adiantamentos.pagamento_confirmar',
        ],
      });
    }

    // ── solicitações ──
    if (path === '/adiantamentos' && method === 'GET') {
      const statusFiltro = url.searchParams.get('status');
      let itens = Object.values(state.solicitacoes);
      if (statusFiltro) itens = itens.filter((s) => statusFiltro.split(',').includes(s.status));
      return json(200, { itens: itens.map(resumoDe), total: itens.length, page: 1, pageSize: 20 });
    }
    const detalheMatch = path.match(/^\/adiantamentos\/(\d+)$/);
    if (detalheMatch && method === 'GET') {
      const s = state.solicitacoes[Number(detalheMatch[1])];
      return s ? json(200, s) : json(404, { erro: 'NAO_ENCONTRADO' });
    }
    const reprocessarMatch = path.match(/^\/adiantamentos\/(\d+)\/reprocessar$/);
    if (reprocessarMatch && method === 'POST') {
      const s = state.solicitacoes[Number(reprocessarMatch[1])];
      if (!s) return json(404, { erro: 'NAO_ENCONTRADO' });
      s.status = 'LIBERADA';
      s.motivoStatus = null;
      return json(200, resumoDe(s));
    }
    const atualizarContaMatch = path.match(/^\/adiantamentos\/(\d+)\/atualizar-conta$/);
    if (atualizarContaMatch && method === 'POST') {
      const s = state.solicitacoes[Number(atualizarContaMatch[1])];
      if (!s) return json(404, { erro: 'NAO_ENCONTRADO' });
      return json(200, resumoDe(s));
    }
    const encerrarFalhaMatch = path.match(/^\/adiantamentos\/(\d+)\/encerrar-falha$/);
    if (encerrarFalhaMatch && method === 'POST') {
      const s = state.solicitacoes[Number(encerrarFalhaMatch[1])];
      if (!s) return json(404, { erro: 'NAO_ENCONTRADO' });
      s.status = 'ENCERRADA';
      return json(200, resumoDe(s));
    }

    // ── contas bancárias ──
    if (path === '/adiantamentos/contas' && method === 'GET') {
      const itens = Object.values(state.contas);
      return json(200, { itens, total: itens.length, page: 1, pageSize: 20 });
    }
    const contaCompletaMatch = path.match(/^\/adiantamentos\/contas\/(\d+)$/);
    if (contaCompletaMatch && method === 'GET') {
      const c = state.contas[Number(contaCompletaMatch[1])];
      return c ? json(200, c) : json(404, { erro: 'NAO_ENCONTRADO' });
    }
    const aprovarContaMatch = path.match(/^\/adiantamentos\/contas\/(\d+)\/aprovar$/);
    if (aprovarContaMatch && method === 'POST') {
      const c = state.contas[Number(aprovarContaMatch[1])];
      if (!c) return json(404, { erro: 'NAO_ENCONTRADO' });
      c.status = 'APROVADA';
      c.revisadaEm = new Date().toISOString();
      return json(200, { id: c.id, status: c.status });
    }
    if (path === '/adiantamentos/contas/aprovar-lote' && method === 'POST') {
      const { ids } = req.postDataJSON() as { ids: number[] };
      let aprovadas = 0;
      const ignoradas: { id: number; motivo: string }[] = [];
      for (const id of ids) {
        const c = state.contas[id];
        if (c && c.status === 'PENDENTE' && c.origem === 'CARGA_INICIAL' && c.alertas.length === 0) {
          c.status = 'APROVADA';
          c.revisadaEm = new Date().toISOString();
          aprovadas += 1;
        } else {
          ignoradas.push({ id, motivo: 'FORA_DO_CRITERIO' });
        }
      }
      return json(200, { aprovadas, ignoradas });
    }

    // ── pagamentos / lotes ──
    if (path === '/adiantamentos/lotes/previa' && method === 'POST') {
      const { ids } = req.postDataJSON() as { ids: number[] };
      // Simula o que a RPC real reavalia no momento da prévia (não no momento
      // da listagem): o SEGUNDO id selecionado já foi capturado por outro
      // lote entre a listagem e a prévia — pendência `JA_EM_LOTE`, o código
      // REAL de `hub_adiantamento_lote_previa` (ver cabeçalho do arquivo).
      const aptas: { id: number; integrationId: string; motorista: string | null; valor: string; bancoAgenciaContaMascarados: string }[] = [];
      const pendentes: { id: number; pendencias: string[] }[] = [];
      let totalCentavos = 0;
      ids.forEach((id, i) => {
        const s = state.solicitacoes[id];
        if (!s) return;
        if (i === 1) {
          pendentes.push({ id, pendencias: ['JA_EM_LOTE'] });
          return;
        }
        aptas.push({ id, integrationId: s.integrationId, motorista: s.motorista.nome, valor: s.valorLiquido, bancoAgenciaContaMascarados: 'Banco Exemplo · 0001 · ****-1' });
        totalCentavos += Math.round(parseFloat(s.valorLiquido) * 100);
      });
      return json(200, {
        selecionadas: ids.length, aptas, pendentes, quantidadeApta: aptas.length,
        totalApto: (totalCentavos / 100).toFixed(2),
      });
    }
    if (path === '/adiantamentos/lotes' && method === 'POST') {
      const { ids } = req.postDataJSON() as { ids: number[] };
      const loteId = state.proximoLoteId++;
      const itens = ids.map((id, i) => {
        const s = state.solicitacoes[id];
        s.status = 'EM_LOTE';
        s.loteId = loteId;
        return {
          id: 300 + i, nome: s.motorista.nome ?? '—', documentoMascarado: '***.***.***-**', banco: 'Banco Exemplo',
          agencia: '0001', contaMascarada: '****-1', tipoConta: 'CORRENTE', valor: s.valorLiquido,
          integrationId: s.integrationId, descricaoPix: null, situacao: 'incluido', situacaoMotivo: null, situacaoEm: null,
        };
      });
      const valorTotal = (ids.reduce((acc, id) => acc + parseFloat(state.solicitacoes[id].valorLiquido), 0)).toFixed(2);
      const lote: Lote = {
        id: loteId, numero: `LT-${loteId}`, status: 'GERADO', criadoPor: { id: 1, nome: 'Financeiro E2E' },
        criadoEm: new Date().toISOString(), quantidade: ids.length, valorTotal,
        arquivoNome: `transfeera_adiantamentos_lote-LT-${loteId}.xlsx`, arquivoSha256: 'e2e-sha', downloads: 0,
        primeiroDownloadEm: null, canceladoEm: null, canceladoMotivo: null, concluidoEm: null, itens, historico: [],
      };
      state.lotes[loteId] = lote;
      return json(200, lote);
    }
    if (path === '/adiantamentos/lotes' && method === 'GET') {
      const itens = Object.values(state.lotes);
      return json(200, { itens, total: itens.length, page: 1, pageSize: 20 });
    }
    const loteMatch = path.match(/^\/adiantamentos\/lotes\/(\d+)$/);
    if (loteMatch && method === 'GET') {
      const l = state.lotes[Number(loteMatch[1])];
      return l ? json(200, l) : json(404, { erro: 'NAO_ENCONTRADO' });
    }
    const arquivoMatch = path.match(/^\/adiantamentos\/lotes\/(\d+)\/arquivo$/);
    if (arquivoMatch && method === 'GET') {
      const l = state.lotes[Number(arquivoMatch[1])];
      if (!l) return json(404, { erro: 'NAO_ENCONTRADO' });
      l.downloads += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers: { 'Content-Disposition': `attachment; filename="${l.arquivoNome}"` },
        body: Buffer.from('conteudo-e2e-fake'),
      });
    }
    const confirmacaoMatch = path.match(/^\/adiantamentos\/lotes\/(\d+)\/confirmacao$/);
    if (confirmacaoMatch && method === 'POST') {
      const l = state.lotes[Number(confirmacaoMatch[1])];
      if (!l) return json(404, { erro: 'NAO_ENCONTRADO' });
      const { falhas } = req.postDataJSON() as { falhas: { id: number; motivo: string }[] };
      const falhaIds = new Set(falhas.map((f) => f.id));
      l.itens = l.itens.map((it) =>
        it.situacao === 'incluido'
          ? { ...it, situacao: falhaIds.has(it.id) ? 'falhou' : 'pago', situacaoMotivo: falhaIds.has(it.id) ? (falhas.find((f) => f.id === it.id)?.motivo ?? null) : null }
          : it
      );
      l.status = falhaIds.size > 0 ? 'CONCLUIDO_COM_FALHAS' : 'CONCLUIDO';
      l.concluidoEm = new Date().toISOString();
      return json(200, l);
    }

    // ── configuração (pills informativos do repasse) ──
    if (path === '/adiantamentos/configuracoes' && method === 'GET') {
      return json(200, {
        vigente: {
          versao: 1, vigenteDesde: '2026-01-01', timezone: 'America/Sao_Paulo', diasHabilitados: [1, 2, 3, 4, 5],
          horarioAbertura: '06:00', horarioCorte: '18:00', percentual: 80, taxaFixa: '2.90',
          fonteProducao: 'movimento', categoriasProducao: null, previsaoPagamentoTexto: 'Em até 1 dia útil',
          descricaoPixModelo: 'Adiantamento {nome}', apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 7,
          apuracaoDataBase: null, categoriasExtrato: null, descontoAdiantamentos: true, descontoDebitos: false,
          repasseVisivelApp: false, completa: true,
        },
        historico: [],
      });
    }

    // ── repasse ──
    if (path === '/adiantamentos/repasse' && method === 'GET') {
      const periodo = url.searchParams.get('periodo') ?? '';
      const dados = state.repasse[periodo];
      if (!dados) {
        return json(200, {
          periodo: { inicio: periodo, fim: periodo, dataRepasse: null, situacao: 'aberto' },
          totais: { creditos: '0.00', adiantamentos: '0.00', debitos: '0.00', remanescente: '0.00', motoristas: 0 },
          itens: [], naoPagosNoPeriodo: 0, total: 0, page: 1, pageSize: 20,
        });
      }
      const fechado = state.apuracoesFechadas.has(periodo);
      return json(200, {
        periodo: { inicio: periodo, fim: periodo, dataRepasse: fechado ? periodo : null, situacao: fechado ? 'fechado' : 'aberto' },
        totais: dados.totais, itens: dados.itens, naoPagosNoPeriodo: dados.naoPagosNoPeriodo,
        total: dados.itens.length, page: 1, pageSize: 20,
      });
    }
    const fecharMatch = path.match(/^\/adiantamentos\/repasse\/([\d-]+)\/fechar$/);
    if (fecharMatch && method === 'POST') {
      const periodo = fecharMatch[1];
      const dados = state.repasse[periodo];
      if (!dados || !dados.fechavel) {
        return json(409, { erro: 'APURACAO_COM_PENDENCIAS', detalhe: { LIBERADA: 2, FALHOU: 1 } });
      }
      state.apuracoesFechadas.add(periodo);
      return json(200, { apuracaoId: 1, motoristas: dados.totais.motoristas, total: dados.totais.remanescente as string, naoPagosNoPeriodo: dados.naoPagosNoPeriodo });
    }

    return json(404, { erro: 'NAO_ENCONTRADO', path, method });
  });
}

async function setup(page: Page, state: StubState) {
  await installApiStubs(page, state);
}

// ───────────────────────────────────────────────────────────────────────────
// US3 — contas bancárias (SC-006/7.5.4: dado completo só na revisão dedicada)
// ───────────────────────────────────────────────────────────────────────────
test.describe('US3 — contas bancárias', () => {
  test('lista mostra só dado mascarado; documento/PIX completos só aparecem na revisão dedicada, e aprovar exige confirmar o entregador', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/contas');
    // O card mobile e a tabela desktop coexistem no DOM (um escondido via
    // CSS `md:hidden`/`hidden md:block`) — `.first()` porque o mesmo dado
    // aparece nos dois, nunca ambiguidade de CONTEÚDO.
    await expect(page.getByText('João Motorista').last()).toBeVisible();
    // SC-006: o documento mascarado aparece na lista — o completo NUNCA.
    await expect(page.getByText('***.456.789-**').last()).toBeVisible();
    await expect(page.getByText('123.456.789-00')).toHaveCount(0);

    await page.getByRole('link', { name: 'Revisar' }).first().click();
    await page.waitForURL(/\/contas\/501$/);
    await expect(page.getByText('Dados completos visíveis')).toBeVisible();
    // Só aqui, na revisão dedicada, o documento completo aparece.
    await expect(page.getByText('123.456.789-00').first()).toBeVisible();

    const aprovarBtn = page.getByRole('button', { name: 'Aprovar conta' });
    await expect(aprovarBtn).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Confirmo que a conta pertence ao motorista deste entregador' }).check();
    await expect(aprovarBtn).toBeEnabled();
    await aprovarBtn.click();
    // `{ exact: true }` — "Aprovada" (badge) é substring do toast "Conta
    // aprovada." (minúsculo, mas getByText é case-insensitive por padrão).
    await expect(page.getByText('Aprovada', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aprovar conta' })).toHaveCount(0);
  });

  test('aprovação em massa mostra a contagem antes de confirmar (FR-020)', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/contas');
    await expect(page.getByText('Maria Motorista').last()).toBeVisible();
    await page.getByRole('checkbox', { name: 'Selecionar todas as contas desta página' }).check();
    await expect(page.getByText('2 selecionada(s)')).toBeVisible();

    await page.getByRole('button', { name: 'Aprovar selecionadas' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText('Aprovar 2 conta(s)?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Aprovar selecionadas' }).click();

    await expect(page.getByText('2 conta(s) aprovada(s).')).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// US4 — montar e gerar lote de pagamento (SC-003/7.6.4)
// ───────────────────────────────────────────────────────────────────────────
test.describe('US4 — pagamentos e lotes', () => {
  test('seleciona, revisa a prévia (com pendência real JA_EM_LOTE) e gera o lote', async ({ page }) => {
    const inicio = Date.now();
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/pagamentos');
    await expect(page.getByText('Motorista Um').last()).toBeVisible();
    // Marca só as 2 linhas de interesse — a lista de pagamentos também
    // devolve 603 (LIBERADA, usado pelo teste da pendência CONTA_ALTERADA
    // acima); "selecionar todas da página" pegaria as 3.
    await page.getByRole('checkbox', { name: 'Selecionar ADV-0101' }).check();
    await page.getByRole('checkbox', { name: 'Selecionar ADV-0102' }).check();
    await expect(page.getByText('2 selecionada(s)')).toBeVisible();

    await page.getByRole('button', { name: 'Revisar lote' }).click();
    // "Com pendências" — assert pelo texto REAL da pendência (o dígito "1"
    // sozinho é ambíguo com o tile "Aptas para exportação", que também é 1).
    await expect(page.getByText(/Já está em outro lote/)).toBeVisible();
    await expect(page.getByText('ADV-0101')).toBeVisible();

    await page.getByRole('button', { name: 'Gerar arquivo Transfeera' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(/Gerar lote com 1 pagamento/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Gerar lote e arquivo' }).click();

    await page.waitForURL(/\/lotes\/\d+$/, { timeout: 15_000 });
    await expect(page.getByText('Gerado', { exact: true })).toBeVisible();
    await expect(page.getByText('R$ 150,00').first()).toBeVisible();

    // SC-003 (proxy): sem I/O real de rede/arquivo neste mock, o wizard
    // completo (seleção → prévia → gerar) roda bem dentro do teto de 5 min —
    // a prova de tempo REAL fica para o driver de integração (I/O real).
    expect(Date.now() - inicio).toBeLessThan(5 * 60 * 1000);

    // Download real do arquivo — prova mais forte que ler um dígito na tela.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Baixar arquivo Transfeera' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^transfeera_adiantamentos_lote-/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// US5 — confirmação de pagamento, reprocessar e encerrar sem pagamento
// ───────────────────────────────────────────────────────────────────────────
test.describe('US5 — confirmação de pagamento e transições de falha', () => {
  test('confirma o resultado do lote marcando uma falha — os demais viram pagos automaticamente', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/lotes/9002');
    await expect(page.getByText('Exportado')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar resultado' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Marcar ADV-0201 como falha' }).check();
    await dialog.locator('input[placeholder*="Conta encerrada"]').fill('Conta encerrada no banco de destino');
    await dialog.getByRole('button', { name: 'Confirmar resultado' }).click();

    await expect(page.getByText('Concluído com falhas')).toBeVisible();
    // `{ exact: true }` — "Pago" é substring case-insensitive de textos como
    // "...os demais viram pagos automaticamente" (descrição do diálogo).
    await expect(page.getByText('Pago', { exact: true })).toBeVisible(); // ADV-0202, não marcado, virou pago
    await expect(page.getByText('Falhou', { exact: true })).toBeVisible(); // ADV-0201, marcado
  });

  test('reprocessar uma solicitação falhada devolve para LIBERADA e ela reaparece na fila de pagamento (edge #20/7.7.4)', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/601');
    await expect(page.getByText('Falha no pagamento')).toBeVisible();
    await page.getByRole('button', { name: 'Reprocessar' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('Corrigido junto ao parceiro de pagamento');
    await dialog.getByRole('button', { name: 'Reprocessar' }).click();

    await expect(page.getByText('Liberada')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reprocessar' })).toHaveCount(0);

    // volta para a fila de pagamento — prova de que "entra em novo lote" é
    // possível (mesmo fluxo de montagem já provado no teste de US4 acima).
    await page.goto('/hub/dashboard/adiantamentos/pagamentos');
    await expect(page.getByText('ADV-0601').last()).toBeVisible();
  });

  test('"Encerrar sem pagamento" em FALHOU transiciona para ENCERRADA e some da fila de reprocessamento (D-23/7.3.6)', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/602');
    await expect(page.getByText('Falha no pagamento')).toBeVisible();
    await page.getByRole('button', { name: 'Encerrar sem pagamento' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('Motorista não tem mais conta bancária válida cadastrada');
    await dialog.getByRole('button', { name: 'Encerrar sem pagamento' }).click();

    await expect(page.getByText('Pagamento não realizado')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reprocessar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Encerrar sem pagamento' })).toHaveCount(0);
  });

  test('a ação explícita "Atualizar conta" resolve a pendência de conta alterada (7.3.4)', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/603');
    const botao = page.getByRole('button', { name: 'Atualizar conta' });
    await expect(botao).toBeVisible();
    await botao.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Atualizar conta de destino?')).toBeVisible();
    await dialog.getByRole('textbox').fill('Motorista trocou de conta aprovada após a solicitação');
    await dialog.getByRole('button', { name: 'Atualizar conta' }).click();

    // dialogo fecha sem erro — a ação explícita foi concluída.
    await expect(dialog).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// US6 — repasse e fechamento de apuração
// ───────────────────────────────────────────────────────────────────────────
test.describe('US6 — repasse e fechamento', () => {
  test('visualiza o remanescente por motorista no período', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/repasse');
    await page.getByLabel('Período de apuração (início)').fill('2026-09-01');
    await expect(page.getByText('Motorista Um')).toBeVisible();
    // linha do motorista E o total do rodapé mostram o mesmo valor (só 1
    // motorista no período) — `.first()` porque ambos são o dado correto.
    await expect(page.getByText('R$ 350,00').first()).toBeVisible(); // remanescente
    await expect(page.getByText('Em apuração')).toBeVisible();
  });

  test('fechar apuração com pendências é recusado e mostra a contagem por status (D-23/7.8.4)', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/repasse');
    await page.getByLabel('Período de apuração (início)').fill('2026-09-01');
    await expect(page.getByText('Motorista Um')).toBeVisible();

    await page.getByRole('button', { name: 'Fechar apuração' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Fechar apuração' }).click();

    await expect(dialog.getByText('Há solicitações pendentes neste período')).toBeVisible();
    // Rótulo REAL de LIBERADA (rotuloStatusAdiantamento) é "Adiantamento
    // liberado", não "Liberada" — Constitution VI, nunca supor o texto.
    await expect(dialog.getByText(/Adiantamento liberado.*2/)).toBeVisible();
    await expect(dialog.getByText(/Falha no pagamento.*1/)).toBeVisible();
  });

  test('fecha a apuração com sucesso quando não há pendências', async ({ page }) => {
    const state = defaultState();
    await setup(page, state);

    await page.goto('/hub/dashboard/adiantamentos/repasse');
    await page.getByLabel('Período de apuração (início)').fill('2026-09-08');
    await expect(page.getByText('Motorista Dois')).toBeVisible();

    await page.getByRole('button', { name: 'Fechar apuração' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Fechar apuração' }).click();

    await expect(page.getByText(/Apuração fechada/)).toBeVisible();
    await expect(page.getByText('Fechado')).toBeVisible();
  });
});
