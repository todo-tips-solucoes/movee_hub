# Briefing S5 — Módulo Motoristas

**Fase:** S5 · **Branch:** `feat/hub-motoristas` · **Pré-requisito:** S3 (shell) e S4
(tabela `Entregador` populada por importações) mergeadas.

## Contexto mínimo (autossuficiente)

- Existem **duas populações** relacionadas mas distintas:
  1. **`Motorista`** (tabela existente, preservar): base de **login do app motorista**
     (PWA `app.motorista.moveelog.com.br`), chave `cnpj_prestador` UNIQUE, senha nullable
     (pré-cadastro), **exclusiva do grupo Movee** (empresa id=6 + filiais, via
     `mesmoGrupoQue` — NUNCA `id_empresa === 6` estrito). Populada pelo `/upload` do
     envio em massa. Já tem CRUD em `routes/admin-motorista.js` e tela
     `/dashboard/motoristas` com filtros client-side.
  2. **`Entregador`** (tabela nova da S4): dimensão dos CSVs de faturamento/performance —
     `id_externo` UUID + nome, por entidade. **Os CSVs não têm CNPJ**, então o vínculo
     Entregador↔Motorista **não é automático** (decisão D3 do plano técnico: manual +
     sugestão por nome; o operador pode fornecer de-para no futuro).
- ⚠️ Ambiente do VPSTodo É PRODUÇÃO — trabalho só no ambiente isolado.
- Referências: plano técnico §9.2 (`Entregador`), §13 (telas), §14 (APIs), D3 em §18;
  CLAUDE.md (regras de domínio da base `Motorista`).

## Objetivo

Tela e API unificadas de gestão de motoristas/entregadores no hub: listar, filtrar,
editar, ativar/desativar e **vincular** Entregador↔Motorista.

## Escopo

**Inclui**
1. Backend `/api/v1/motoristas*` (permissões `motoristas.*`): lista paginada de
   `Entregador` com filtros (nome, ativo, subpraça de atuação — derivada dos fatos —,
   com/sem vínculo), detalhe com últimos indicadores (contagens dos fatos), update
   (nome/ativo), vínculo/desvínculo `motorista_id` com validação (o `Motorista` alvo
   precisa pertencer ao escopo do grupo Movee quando aplicável — reusar `mesmoGrupoQue`).
2. **Sugestão de vínculo por nome**: endpoint que propõe candidatos `Motorista` por
   similaridade de nome normalizado (unaccent/lower); humano confirma na UI. Nunca
   auto-vincular.
3. Frontend `/motoristas` e `/motoristas/:id` no shell (design /ui-ux-pro-max; reusar
   `data-table`/`filters` e os padrões da tela existente `/dashboard/motoristas`).
4. Migration só se necessário (ajustes em `Entregador`; série 011+; expand-only).

**Não inclui:** qualquer mudança na tabela `Motorista`, no fluxo de login do app
motorista ou no `upsertMotoristasFromLote` do `/upload` legado; CRUD de veículos;
importação (S4 já fez).

## Ordem

API lista/detalhe → update/ativo → vínculo + sugestões → telas → E2E → evidências.

## Testes exigidos

- Unit: normalização de nome/similaridade; validação de vínculo (escopo/grupo).
- Integração: filtros com dados dos seeds; vínculo persiste e aparece no detalhe.
- E2E: buscar → abrir detalhe → vincular via sugestão → desvincular; usuário `leitura`
  não vê ações de edição (e recebe 403 se forçar).

## Evidências

E2E verde; prints da tela com contagens; demonstração da sugestão de vínculo.

## Critérios de aceite

1. Lista/filtros/edição/vínculo funcionando sobre os dados importados na S4; 2. tela
funciona com Entregador **sem** vínculo (maioria inicial); 3. zero mudanças na base
`Motorista` e no app motorista; 4. permissões aplicadas no backend; 5. PR + DIARIO.md.

## Gotchas

- Regra de domínio (CLAUDE.md): tudo que toca a base `Motorista` respeita o critério de
  grupo `mesmoGrupoQue(id, 6)`, nunca comparação estrita com 6.
- Filtros da tela atual de motoristas são client-side; os novos devem ser server-side
  (paginação real — volume de `Entregador` cresce com os CSVs).
- `Select` Base UI: `items` no Root. Comentário `{/* */}` após `return (` quebra build.
