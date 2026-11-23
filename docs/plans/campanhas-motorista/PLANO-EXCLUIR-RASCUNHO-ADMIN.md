# Campanhas: excluir rascunho + admin da plataforma no módulo (plano fechado, 2026-11-23)

Pedido do operador (23/11): (1) poder excluir rascunho — o smoke funcional deixaria um
"TESTE — não lançar" na lista para sempre; (2) admin da plataforma com acesso ao módulo Campanhas.

## Medido antes de decidir

- **Admin da plataforma**: o papel `admin_plataforma` recebeu "todas as permissões" só no seed 0007; cada
  permissão nova é concedida a ele EXPLICITAMENTE (0016, 0026, 0029, 0032, e os módulos 0062 avisos e 0070
  adiantamentos). A 0127 não o incluiu — é a lacuna. A checagem das RPCs (`hub_campanha_autoriza`: escopo +
  `empresa_ativa` + `hub_adiantamento_tem_permissao`) já atende o admin da plataforma pela própria linha de
  `UsuarioEntidade` na entidade ativa (mesmo modelo de auditoria/adiantamentos). **Basta o grant.**
- **Excluir**: o gatilho de imutabilidade (0127) só recusa DELETE de campanha LANÇADA; `CampanhaPremio` e
  `CampanhaRanking` têm `ON DELETE CASCADE`; `CampanhaVencedor` não tem cascade, mas rascunho nunca tem vencedor.
  `authenticated` não tem DELETE direto — precisa de RPC.

## Decisões (orquestrador, declaradas ao operador)

- D1 Exclusão é física (DELETE), só de **rascunho**; lançada/cancelada/encerrada → `CAMPANHA_IMUTAVEL` (409).
  A auditoria guarda quem excluiu, quando, id e nome.
- D2 `admin_plataforma` recebe `campanhas.consultar`, `campanhas.gerir`, `campanhas.entregar`.
- D3 Sem exclusão em lote, sem lixeira/restauração (YAGNI; rascunho não tem efeito fora do hub).

## Entrega (uma onda, executor Sonnet)

1. **Migration `0128_campanhas_excluir_admin.sql`** (aditiva, idempotente, cabeçalho no padrão):
   - `INSERT INTO "PapelPermissao"` para `admin_plataforma` × as 3 permissões (padrão 0126, `ON CONFLICT DO NOTHING`).
   - `hub_campanha_excluir(p_id int) RETURNS jsonb {id, nome}`: SECURITY DEFINER, `search_path` fixo;
     `hub_campanha_carregar(p_id, 'campanhas.gerir', true)` (404 fora do escopo, trava a linha); se
     `lancada_em IS NOT NULL` → `RAISE 'CAMPANHA_IMUTAVEL'` (ERRCODE 55000); senão `DELETE` e devolve id+nome.
     REVOKE PUBLIC / GRANT EXECUTE authenticated.
2. **Backend** `routes/hub-campanhas.js`: `DELETE /:id` — `requireModuloAtivo('campanhas')` +
   `requirePermission('campanhas.gerir')`, mesmo rate limit de escrita, auditoria `campanha.excluida` com
   `{id, nome}`, `204`. Tokens via o mapa existente de `lib/campanha-dto.js` (404/409).
3. **Hub**: botão "Excluir rascunho" (destrutivo) na tela de edição do rascunho e na linha da lista quando
   `situacao === 'rascunho'` e `campanhas.gerir`; diálogo de confirmação com o nome da campanha ("A exclusão
   não pode ser desfeita"), reaproveitando o padrão de `campanha-cancelar-dialog.tsx`; após excluir, toast e volta
   para a lista. `excluirCampanha(id)` em `lib/hub/campanhas-api.ts`.
4. **Provas**:
   - `infra/hub/testes/hub-campanhas-db.sh`: rascunho excluído some (e prêmios/ranking em cascata); lançada →
     `CAMPANHA_IMUTAVEL` e continua lá; entidade B → `CAMPANHA_NAO_ENCONTRADA`; usuário sem `gerir` → negado;
     `admin_plataforma` tem as 3 permissões e consegue listar/criar numa entidade onde tem vínculo.
     Controle negativo: sem a checagem de `lancada_em` na RPC, o teste da lançada FALHA (guarda anti-oco).
   - backend unit (rota: 204, 403, 404/409 mapeados, auditoria) e frontend vitest (botão só em rascunho+gerir,
     confirmação obrigatória, chamada DELETE).
   - E2E `hub-campanhas`: na spec 01, criar um 2º rascunho e excluí-lo pela UI (some da lista e do banco).
5. Gates: backend `npm test`; frontend_v2 tsc + vitest + lint (baseline 28); `next build` e driver E2E rodados pelo
   orquestrador. Sem mudança no app do motorista.
