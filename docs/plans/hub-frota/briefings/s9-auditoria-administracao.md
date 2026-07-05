# Briefing S9 — Auditoria + Administração

**Fase:** S9 · **Branch:** `feat/hub-auditoria-admin` · **Pré-requisito:** S2 mergeada
(tabela `Auditoria` + RBAC); S3 (shell). Idealmente após S4–S8 (mais eventos na trilha).

## Contexto mínimo (autossuficiente)

- A S2 criou `Auditoria(id_empresa NULL, usuario_id NULL, acao, recurso, recurso_id,
  detalhes jsonb SEM dados sensíveis, ip, criado_em)` (append-only) e as fases S2–S8
  registram eventos: `login.sucesso/falha`, `usuario.criado/editado`, `papel.alterado`,
  `importacao.criada/concluida/falha`, `motorista.editado/vinculado`,
  `envio.bloqueado_allowlist`, etc. Também existem `Modulo`/`ModuloEntidade` (shell
  data-driven) e papéis/permissões.
- ⚠️ O ambiente VIVO do cliente no VPSTodo É PRODUÇÃO — trabalho só nos recursos `hub-*`
  do ambiente isolado (rodam no próprio VPSTodo; exceção escopada do G1 — DIARIO.md).
- Referências: plano técnico §9.2 (`Auditoria`, `Modulo*`), §13 (telas), §14 (APIs).

## Objetivo

Tela de auditoria consultável + administração da plataforma (módulos por entidade,
gestão de usuários/papéis já da S2 ganham telas completas).

## Escopo

**Inclui**
1. **Backend:** `GET /api/v1/auditoria` (filtros: ação, usuário, recurso, range de data;
   paginação; permissão `auditoria.list`; escopo: admin_entidade vê a própria entidade;
   `admin_plataforma` vê tudo). Garantir cobertura de eventos: varrer os endpoints das
   fases anteriores e preencher lacunas de `auditar()` (lista no plano §9.2).
2. **Administração:** `GET/PUT /api/v1/admin/modulos` e
   `/api/v1/admin/entidades/:id/modulos` (habilitar módulo por entidade; permissão
   `admin.manage`; refletido no ModuleNav imediatamente).
3. **Frontend:** `/auditoria` (tabela filtrável, detalhes em drawer, sem edição — trilha
   é imutável), `/usuarios` (CRUD + vínculos + papéis — telas completas sobre os
   endpoints da S2), `/papeis` (matriz papel×permissão com checkboxes),
   `/configuracoes/modulos` (módulos por entidade). Design /ui-ux-pro-max.

**Não inclui:** retenção/expurgo automático de auditoria (política é decisão D5 do
operador — deixar preparado por data, não implementar expurgo); alertas; export de
auditoria (futuro se pedido).

## Ordem

lacunas de auditar() → endpoint auditoria → admin módulos → telas (auditoria → usuários →
papéis → módulos) → E2E → evidências.

## Testes exigidos

- Unit: filtro/escopo da auditoria (entidade vs global); mascaramento de `detalhes`.
- Integração: evento gerado por ação real aparece na consulta; módulo desabilitado some
  do `GET /me` da entidade.
- E2E: admin_entidade vê só a própria trilha; alterar papel de um usuário reflete nas
  permissões **imediatamente** (invalidação síncrona no update — o TTL de 60 s do cache
  é apenas fallback, não o mecanismo); desabilitar módulo esconde item do menu e
  bloqueia endpoint (403).

## Evidências

Trilha com eventos reais das fases anteriores (print); E2E verde; demonstração do
módulo on/off.

## Critérios de aceite

1. Toda ação de escrita das fases S2–S8 gera evento de auditoria (checklist por endpoint
no PR); 2. trilha imutável (sem UPDATE/DELETE — negar por RLS/GRANT); 3. telas de
usuários/papéis/módulos completas e protegidas; 4. `detalhes` sem dados sensíveis
(verificação automatizada por grep de padrões: CPF/CNPJ/senha/nome completo); 5. PR +
DIARIO.md.

## Gotchas

- `Auditoria.detalhes` NUNCA guarda senha/hash/token nem linha bruta de CSV; diffs de
  edição entram mascarados.
- GRANT: negar UPDATE/DELETE em `Auditoria` para o role do PostgREST (append-only por
  permissão, não só por convenção).
- Cache de permissões (S2): a invalidação é **síncrona** no update de papel; o TTL 60 s
  é só fallback — não tratar a troca de papel como assíncrona nem confiar apenas no TTL.
