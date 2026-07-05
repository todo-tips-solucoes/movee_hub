# Prompt B — Banco, autenticação e fundações (Sessão S2)

> Colar num Claude Code fresco na raiz de `/var/lib/envioMassa_homologacao`.
> **Depende explicitamente da aprovação do Prompt A (gate G2: 20/20 testes de isolamento
> aprovados pelo operador). Não executar antes disso.**

```text
Use /context-mode:context-mode durante toda a sessão. Rode
/feature-00c docs/plans/hub-frota/briefings/s2-fundacoes.md

PRÉ-CONDIÇÃO OBRIGATÓRIA: G2 aprovado (evidências 20/20 de isolamento do PR da S1
mergeadas). Se não conseguir confirmar o G2 (PR da S1 mergeado + aprovação registrada no
DIARIO.md), PARE e pergunte ao operador. Este prompt depende da aprovação do Prompt A.

CONTEXTO. Ambiente isolado validado na S1 (VPS Hub, compose hub-homolog, banco hub_homolog,
mocks). O "homologação" antigo no VPSTodo É PRODUÇÃO — intocável. Todo o trabalho desta
sessão ocorre SOMENTE no ambiente isolado.

ESCOPO (fundações — plano técnico §9, §11):
- Migrations 011+ na série única app_homologacao/backend/db/ (docs/sql/ está congelada):
  Usuario, UsuarioEntidade, Papel, Permissao, PapelPermissao, Modulo, ModuloEntidade,
  Auditoria, SessaoRefresh, SchemaMigration + seeds de papéis/permissões/módulos +
  migração de dados Empresa.pass → Usuario (§11.5, expand-only; hash bcrypt copiado).
- Auth /api/v1: login/refresh/logout/recuperar/redefinir sobre Usuario; SessaoRefresh com
  revogação; controle de tentativas + bloqueado_ate; auditoria de login.
- RBAC: requirePermission('modulo.acao') + GET /me (módulos+permissões) + troca de
  entidade ativa; cache TTL 60s.
- RLS no Postgres como reforço (claims via PostgREST) + testes de acesso cruzado.
- Backend do hub em Node 20 (Dockerfile.hub — decisão D2; o legado node:14 não muda).

PROIBIDO: qualquer escrita no ambiente vivo do cliente (VPSTodo/chatmasterveloz);
alterar endpoints legados (/login, /upload, /envio-massa...); mudanças de UI além do
mínimo para exercitar auth (telas completas são S3+); DDL destrutiva em tabelas
existentes (Empresa, Motorista, EnvioMassa — expand-only); commitar segredos ou dados
pessoais; tocar docs/sql/ (série congelada).

ORDEM: migrations → migração de login → auth → RBAC/me → RLS → testes → evidências.

TESTES EXIGIDOS: unit (auth, RBAC, escopo) + integração de banco (migrations em banco
vazio E com seeds) + E2E (login, troca de senha revoga sessões, troca de entidade,
acesso cruzado negado por RLS). Todos os arquivos de teste no script npm test.

EVIDÊNCIAS (anexar ao PR): suíte verde completa; SELECT de SchemaMigration; RLS negando
acesso cruzado (query com claim de outra entidade → 0 linhas); auditoria de login
demonstrada; migração de login validada (login legado continua funcionando no ambiente
isolado com o MESMO hash).

CRITÉRIOS DE ACEITE: migrations idempotentes (rodar 2× = no-op); nenhum endpoint novo sem
requirePermission; usuário legado autentica no hub sem trocar senha; plano técnico §15
linha S2.

INTERRUPÇÃO SEGURA: qualquer suspeita de que um comando possa alcançar produção → parar e
devolver ao operador. Contexto >70% → fechar onda, salvar estado e retomar com
/feature-00c-resume em sessão fresca.

FECHAMENTO: DIARIO.md + PR draft (branch feat/hub-fundacoes) com evidências.
```
