# Plano — Validação de XML em lote sem substituir nota já validada

> Briefing para rodar via `/feature-00c` (ou pipeline SDD manual) em **sessão fresca** (cstk).
> Mesmo padrão dos planos em `docs/plans/`. Base de código mapeada por subagente Explore +
> leitura direta na `main` (arquivo:linha conferidos). Decisões de produto já tomadas com o
> operador (ver §0).

## 0. Decisões já tomadas com o operador (não reabrir sem motivo)

1. **Persistência:** o lote de XML passa a **casar cada XML com o movimento aberto correspondente
   em `EnvioMassa` e gravar o resultado** (`nota_ok`/`erro_validacao`) — **MAS pula** quem já está
   validado. (Hoje o lote é efêmero: só confere e devolve na tela.)
2. **Critério de "já validada" (protegida contra substituição):** **apenas APROVADAS** —
   `nota_ok` preenchido **E** `erro_validacao` vazio/nulo. **Notas reprovadas** (têm `nota_ok` mas
   `erro_validacao` com mensagem) **podem** ser revalidadas/substituídas por um XML novo.
3. **Identidade XML ↔ nota existente:** **chave de acesso da NFS-e/NFe quando disponível**, com
   **fallback** para `cnpj_prestador + numnota + data_emissao`.

## 1. Objetivo

Tornar a **importação/validação de XML de NFS-e em lote** do painel (`app.moveelog.com.br`)
**idempotente e segura**: ao reenviar um lote, uma nota que **já foi validada com sucesso não pode
ser sobrescrita** por outro XML. O lote deve detectar a nota correspondente já existente, **preservar
a validação aprovada** e reportar isso claramente, persistindo apenas o que for novo ou ainda não
aprovado.

Problema de negócio: hoje não há proteção — reenviar XMLs pode (a) gerar revalidação/sobrescrita
indevida e (b) nem sequer persiste o resultado do lote, divergindo do fluxo de 1-nota do app
motorista, que **já** protege nota aprovada.

## 2. Stack e contexto técnico (preservar)

- **Backend**: Node `node:14` + Express, `app_homologacao/backend/server.js`. PostgREST sobre o banco
  `chatmasterveloz` (container `pgadmin_db`). Parsing XML via `xml2js`. Upload via `multer`.
- **Frontend**: Next.js 16 / React 19 em `app_homologacao/frontend_v2` (design system EntreGô 2.0 —
  **não** re-skin). Tela em `app/dashboard/validacao-xml/`.
- **Roteamento de validação por grupo** (REGRA DE DOMÍNIO — `CLAUDE.md`): grupo Movee
  (`mesmoGrupoQue(empresaId, 6, cache)`) → FastAPI **não-nexus** (`fastapihomologacao/validade_nfse`,
  `id_empresa=6`); demais empresas → endpoint **nexus** (`fastapihomologacaonexus`, `nexus=true`).
  **Manter** — o `/validate-xml-batch` já faz isso (server.js:1944-1958). Não regredir.
- **Erros do serviço de validação** (`CLAUDE.md`): distinguir **negócio** (4xx com `detail` →
  propagar mensagem real) de **infra** (timeout/5xx/sem resposta → 502 "indisponível"). Não mascarar.

## 3. Estado atual (mapeado na `main`) — arquivo:linha

### 3.1 Validação em lote (efêmera, NÃO persiste) — onde a feature entra
- **`POST /validate-xml-batch`** — `app_homologacao/backend/server.js:1903`.
  - `authenticateToken, upload.array('xmlFiles', 100)` — até 100 XMLs.
  - Loop por arquivo (1916): `xml2js.parseStringPromise` → `extractNfseFields` → monta `xml_input`
    → escolhe endpoint por `mesmoGrupoQue(empresaId, 6)` (1944) → `axios.post` na FastAPI (1960).
  - Monta `row` com flags (`valid`, `valid_cnpj_prestador`, `valid_valor`, ...) e
    **só faz `results.push(row)`** (1990). **Nenhuma escrita no banco.**
  - Rate-limit de 2 s entre arquivos (1993-1995). Resposta `{ stats, results }` (2001-2008).
- **`extractNfseFields`** — `server.js:1868`. Extrai **apenas** `cnpj_prestador` (CNPJ de
  `emit`/`prest`), `razao_social` (`xNome`), `data_emissao` (`dhEmi`/`dhProc`), `valor_nota`
  (`vLiq`/`vServ`). **NÃO** extrai chave de acesso nem `numnota`. → **precisa evoluir** (ver §5).

### 3.2 Reuso disponível para o casamento
- **`getNFeKeyFromNotaOk(notaOkRaw)`** — `server.js:1705`. Deriva a **chave NFe** do `nota_ok`
  (basename da URL/caminho do XML, ex.: `https://.../3548...971.xml` → `3548...971`). **Reusar** para
  obter a chave do **movimento já existente** e comparar com a chave do XML do lote.

### 3.3 Schema `EnvioMassa` (PostgREST) — colunas relevantes (server.js:1649)
`id, created_at, number, nome, cnpj_prestador, valor, mensagem1, mensagem2, enviado,
retorno_envio_msg_1, retorno_envio_msg_2, tribnac, cnpj_tomador, dCompet, numnota, nota_ok,
data_emissao, erro_validacao, dataEnvio, id_empresa, uuid, mov_fechado, dt_inicial, dt_final`.
- **Status de validação**: `nota_ok` (URL/string do XML) + `erro_validacao` (mensagem; vazio = OK).
- **NÃO existe** coluna de chave de acesso → casamento por chave é **derivado em runtime**
  (de `nota_ok` via `getNFeKeyFromNotaOk`), **sem DDL**. (Ver §7 — DDL opcional só se decidirem
  persistir a chave para performance/robustez.)
- **Escopo/tenant**: filtrar sempre por `id_empresa` (do token / `resolveEmpresaAlvo`) e, para
  movimento corrente, `mov_fechado=eq.false`. Respeitar movimento-por-filial (empresa alvo).

### 3.4 Como o fluxo de 1-nota JÁ protege (referência a replicar)
- **`POST /motorista/validar-nota`** — `routes/motorista.js`. Antes de chamar a FastAPI, checa
  `jaAprovada = temNotaOk && !erro_validacao.trim()` e, se aprovada, **retorna sem regravar**. O
  backend lê de volta (`select=nota_ok,erro_validacao`) em vez de sobrescrever. **Mesma regra** deve
  valer no lote.

### 3.5 Persistência paralela (não confundir)
- **`POST /upload`** (XLSX) — `server.js:1157`, grava em `EnvioMassa` (1531-1534) e chama
  `upsertMotoristasFromLote` (1598, def. 1220). **Fora do escopo** desta feature (o foco é o lote de
  **XML**), mas vale conferir se o mesmo princípio "não sobrescrever aprovada" deveria valer lá
  também — registrar como item de acompanhamento, não implementar aqui salvo decisão explícita.

### 3.6 Frontend do lote
- **`app/dashboard/validacao-xml/page.tsx`** → `components/xml-validation-card.tsx`
  (`<input multiple accept=".xml">`, drag&drop) → `hooks/use-xml-validation.ts` (`validateBatch`,
  `FormData` com `xmlFiles`, POST `/api/validate-xml-batch`). Resposta tipada `ValidationRow[]`.
  Precisa exibir os **novos status** por linha (ver §5).

## 4. Regra de negócio (especificação precisa)

Para cada XML do lote, na empresa/filial em escopo (movimento aberto `mov_fechado=false`):

1. **Identificar** a nota correspondente em `EnvioMassa`:
   - **Primário:** comparar a **chave de acesso** extraída do XML novo com a chave derivada de
     `getNFeKeyFromNotaOk(item.nota_ok)` dos movimentos existentes.
   - **Fallback:** casar por `cnpj_prestador + numnota + data_emissao` (normalizar CNPJ só-dígitos;
     `data_emissao` por dia; `numnota` quando disponível).
2. **Decidir** com base no estado da nota encontrada:
   - **Encontrada e APROVADA** (`nota_ok` cheio + `erro_validacao` vazio) → **NÃO valida, NÃO grava**.
     Resultado da linha: `status = "ja_validada"` (ignorada/preservada).
   - **Encontrada e REPROVADA** (`nota_ok` cheio + `erro_validacao` com mensagem) → **revalida** via
     FastAPI e **atualiza** (`PATCH`) a nota existente com o novo resultado. `status = "revalidada"`.
   - **Encontrada e SEM validação** (`nota_ok` vazio) → valida e **grava** no registro existente.
     `status = "validada"`.
   - **Não encontrada** → comportamento a definir no `/clarify` (ver §8, P3): criar novo registro de
     movimento, ou apenas reportar como "sem movimento correspondente" sem inserir.
3. **Idempotência intra-lote:** se o mesmo XML (mesma chave) aparecer 2× no lote, validar **uma vez**;
   as repetições viram `status = "duplicada_no_lote"`.
4. **Roteamento FastAPI por grupo** e **classificação de erro negócio×infra**: manter exatamente como
   hoje (não regredir as regras de `CLAUDE.md`).

> "Não substituir nota validada" = nunca regravar `nota_ok`/`erro_validacao`/`valor` de uma nota
> **APROVADA**. Demais estados podem ser escritos.

## 5. Escopo de implementação — por fase

> **Só lote de XML** (`/validate-xml-batch` + tela `validacao-xml`). Não tocar lógica não relacionada.
> Preservar design system EntreGô 2.0 e responsividade já entregues.

### Fase 1 — Backend: extração + casamento + persistência idempotente
1. **Evoluir `extractNfseFields`** (server.js:1868) para também extrair, do XML:
   - **chave de acesso** (ex.: atributo `Id` de `infNFe`/`infNfse` → tirar prefixo `NFe`; ou `chNFe`;
     ou, na ausência, derivar do `filename` como o `getNFeKeyFromNotaOk` faz com o basename);
   - **número da nota** (`nNF`/`numero`/`NumeroNfse` conforme o layout) → para o fallback.
   - ⚠️ NFS-e municipais variam de layout; tratar ausência graciosamente (campo `null`, cair no
     fallback). Confirmar layouts reais no `/clarify` com XMLs de exemplo.
2. **Helper de casamento** `findMovimentoParaXml(movimentosAbertos, fields)`:
   - índice por chave (via `getNFeKeyFromNotaOk` dos existentes) + índice por
     `cnpj+numnota+data_emissao`; retorna `{ movimento, criterio }` ou `null`.
3. **Reescrever o handler `/validate-xml-batch`** para, por arquivo:
   - carregar **uma vez** os movimentos abertos da empresa/filial em escopo (mesma query do
     `select` da 1649, filtrando `mov_fechado=eq.false` + `id_empresa`);
   - aplicar a **árvore de decisão da §4** (já_validada → skip; reprovada → revalida+PATCH;
     sem validação → valida+PATCH; não encontrada → conforme §8 P3);
   - **PATCH** no PostgREST do registro existente (`EnvioMassa?id=eq.<id>`), gravando `nota_ok`/
     `erro_validacao` (e `valor`/`data_emissao` se aplicável) **somente quando permitido**;
   - dedup intra-lote por chave; manter rate-limit de 2 s **apenas quando houver chamada à FastAPI**
     (pular a espera quando a linha for skip/duplicada → lote fica mais rápido);
   - **nunca** sobrescrever nota aprovada (gate central).
4. **Resposta** enriquecida: cada `row` ganha `status` (`ja_validada` | `validada` | `revalidada` |
   `duplicada_no_lote` | `sem_movimento` | `erro`) + `match_criterio` (`chave` | `fallback` | `none`)
   + `movimento_id` quando casado. `stats` ganha contadores por status.
5. **Segurança/tenant**: garantir que o casamento só ocorre dentro do `id_empresa`/escopo do usuário
   (não vazar movimentos de outro tenant). Reusar `resolveEmpresaAlvo`/`mesmoGrupoQue` como nos
   demais handlers.

### Fase 2 — Frontend: refletir os novos status
6. **`hooks/use-xml-validation.ts`**: estender o tipo `ValidationRow` com `status`, `match_criterio`,
   `movimento_id`; mapear os novos `stats`.
7. **`components/xml-validation-card.tsx`**: na tabela de resultados, mostrar **badge por status**
   (ex.: "Já validada — preservada", "Validada", "Revalidada", "Duplicada no lote", "Sem movimento",
   "Erro") com cor + ícone + texto (a11y `color-not-only`, alinhado ao ciclo UI/UX recém-entregue).
   Resumo no topo (X validadas, Y preservadas, Z erros). Sem novas dependências.
8. **Mensageria de erro**: erro de negócio mostra o `detail` real; infra mostra "serviço de validação
   indisponível" (espelhar a regra do backend).

### Fase 3 — Testes e validação (sem deploy)
9. **Cenários E2E** (com XMLs reais de NFS-e do operador):
   - lote com nota **nunca validada** → grava, `status=validada`;
   - **reenviar o mesmo lote** → todas `ja_validada`, **nada alterado no banco** (conferir que
     `nota_ok`/`erro_validacao` não mudaram — diff via `select`);
   - nota **reprovada** + XML novo → `revalidada` e atualizada;
   - **mesmo XML 2×** no lote → 1 validada + 1 `duplicada_no_lote`;
   - XML **sem movimento** correspondente → conforme decisão §8 P3;
   - **tenant errado**: XML cujo movimento é de outra empresa → não casa (não vaza).
10. **Não regressão**: roteamento Movee×nexus correto; classificação negócio×infra; tela mantém
    responsividade + a11y; `next build` passa.

## 6. Restrições (não-fazer)

- **Não sobrescrever nota APROVADA** em hipótese alguma (gate central da feature).
- **Não regredir** a regra de domínio do `CLAUDE.md` (roteamento por grupo Movee×nexus; base
  `Motorista` só curada para grupo Movee; negócio×infra).
- **Não adicionar dependências** no frontend; reusar Tailwind v4/shadcn/framer-motion/sonner.
- **Não re-skin**; preservar EntreGô 2.0 e responsividade.
- **Não tocar** `/upload` (XLSX), contexts/hooks de auth, white-label — fora do escopo (só registrar
  acompanhamento da §3.5).
- **Sem DDL** por padrão (casamento por chave derivada em runtime). DDL só se §8 P2 decidir persistir
  `chave_nfse` — e, se for, **aditiva/idempotente** (rito de produção).

## 7. Critérios de aceite

- Reenviar um lote idêntico **não altera** nenhuma nota aprovada (verificável por diff de `select`
  antes/depois). Cada linha reenviada vem como `ja_validada`.
- Notas sem validação ou reprovadas são (re)validadas e **persistidas** no registro **existente**
  (PATCH por `id`), sem criar duplicatas.
- Casamento por **chave** quando disponível; fallback `cnpj+numnota+data_emissao` quando não.
- Dedup intra-lote funciona; rate-limit só conta para linhas que chamam a FastAPI.
- Roteamento Movee×nexus e negócio×infra **inalterados**; nenhum vazamento entre tenants.
- Frontend mostra status por linha (a11y, dark/light) e resumo; `next build` passa; sem deps novas.

## 8. Perguntas em aberto (resolver no `/clarify`)

- **P1 — Layouts de XML:** quais layouts de NFS-e municipais o cliente envia? De onde sai a **chave**
  e o **número** em cada um? (Pedir 2–3 XMLs reais de exemplo p/ ancorar `extractNfseFields`.)
- **P2 — Persistir a chave?** Vale adicionar coluna `chave_nfse` em `EnvioMassa` (DDL aditiva +
  índice) para casamento robusto/rápido, ou manter derivação em runtime de `nota_ok`? (Default: sem
  DDL.)
- **P3 — XML sem movimento correspondente:** criar um novo registro de movimento, ou apenas reportar
  `sem_movimento` sem inserir? (Default sugerido: **reportar**, não inserir — evita poluir a base; o
  fluxo de criação de movimento é o `/upload`.)
- **P4 — Reprovada → revalidar automático?** Confirmar que reprovada pode ser sobrescrita por XML
  novo no lote (assumido sim em §0.2), ou também exige ação explícita do usuário.
- **P5 — Valor/gorjeta:** ao (re)validar, atualizar `valor` a partir do XML, ou só `nota_ok`/
  `erro_validacao`? (O fluxo de 1-nota não regrava — confirmar paridade.)

## 9. Deploy (rito de produção — operador; NÃO executar sem autorização)

Host `VPSTodo` = **produção**. Mudança em **backend** (`server.js`) e **frontend_v2**. Serviços
Swarm `envio-massa-homologacao_backend_homologacao` e `envio-massa-homologacao_frontend_v2_homologacao`;
registries `registry.todo-tips.com/envio-massa-backend` e `.../envio-massa-frontend-v2`. Rito completo
(`docs/RITO-PRODUCAO.md` + `CLAUDE.md`): autorização explícita → janela → rollback à mão (imagem
anterior via `docker service inspect/ls`) → `docker build` (frontend: **swap 4G + `DOCKER_BUILDKIT=0
docker build --memory=2g`** por causa da starvation; conferir `ENV BACKEND_URL` antes) → `docker push`
→ `docker service update --with-registry-auth --image …` (**nunca** `docker stack deploy`) → smoke
`app.moveelog.com.br/login` = 200 + E2E funcional. **Sem DDL** (salvo decisão P2). `swapoff` ao final.

## 10. Como rodar (sessão fresca)

`cwd` na raiz do repo (`/var/lib/envioMassa_homologacao`), branch `main`. Confirme as skills do cstk
(`/feature-00c`, `specify`, `plan`). Rode o prompt da §11. Pré-requisito do `/feature-00c`:
`constitution` já ratificada (está em `docs/constitution.md`).

## 11. Prompt para sessão fresca

```
/feature-00c "Validação de XML em lote idempotente: ao reenviar XMLs no lote do painel
(app.moveelog.com.br), casar cada XML com o movimento aberto correspondente em EnvioMassa e gravar
nota_ok/erro_validacao, MAS nunca sobrescrever uma nota já APROVADA (nota_ok preenchido +
erro_validacao vazio). Siga o plano em docs/plans/validacao-xml-lote-sem-substituir-validada.md."
validacao-xml-lote

CONTEXTO E REGRAS DURAS (do plano):
- HOJE /validate-xml-batch (app_homologacao/backend/server.js:1903) é EFÊMERO: valida cada XML na
  FastAPI e só retorna {stats,results}; NÃO persiste. A feature passa a PERSISTIR (PATCH no registro
  existente da EnvioMassa por id), de forma idempotente.
- Identidade XML↔nota: chave de acesso (extrair do XML; reusar getNFeKeyFromNotaOk em server.js:1705
  para a chave do movimento existente) com fallback cnpj_prestador+numnota+data_emissao.
- "Já validada" = APROVADA (nota_ok cheio + erro_validacao vazio) → NÃO valida, NÃO grava
  (status=ja_validada). Reprovada → revalida e atualiza. Sem validação → valida e grava. Mesma chave
  2x no lote → duplicada_no_lote (valida 1x).
- evoluir extractNfseFields (server.js:1868) p/ extrair chave + numnota (tratar layouts variados).
- PRESERVAR regras de domínio do CLAUDE.md: roteamento FastAPI por grupo Movee (mesmoGrupoQue(_,6) →
  fastapihomologacao não-nexus; demais → nexus); negócio(4xx detail)×infra(5xx/timeout→502). Escopo
  por id_empresa/filial (resolveEmpresaAlvo) — sem vazar entre tenants.
- Frontend (app/dashboard/validacao-xml + components/xml-validation-card.tsx +
  hooks/use-xml-validation.ts): refletir status por linha com badge (cor+ícone+texto, a11y), sem deps
  novas, preservando EntreGô 2.0 e responsividade.
- SEM DDL por padrão (chave derivada em runtime). NÃO tocar /upload XLSX, auth, white-label.
- NÃO buildar/deployar: ao final entregue PR e peça o deploy ao operador (rito docs/RITO-PRODUCAO.md;
  produção = VPSTodo).

No /clarify, RESOLVA as Perguntas em Aberto (§8 do plano) comigo — em especial P1 (peça 2-3 XMLs reais
de NFS-e p/ ancorar a extração de chave/numnota) e P3 (XML sem movimento correspondente: reportar vs
inserir). Confirme a abordagem antes de codar.
```

---

## 12. Clarify RESOLVIDO — sessão 2026-06-14 (decisões fixadas com o operador)

> As Perguntas em Aberto da §8 foram resolvidas com o operador nesta sessão. **Não reabrir** no
> clarify do `/feature-00c` — usar as decisões abaixo como dadas.

| # | Pergunta | **Decisão** |
|---|----------|-------------|
| **P1** | Layouts de XML / origem da chave e número | **XMLs reais fornecidos** (3, em `docs/nota_entrego/`). Layout = **padrão NACIONAL NFS-e** (`<NFSe versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse">`). Mapa de extração fixado em §12.1 abaixo. |
| **P2** | Persistir chave (DDL) | **NÃO** — chave **derivada em runtime** (`getNFeKeyFromNotaOk`). **Sem DDL.** |
| **P3** | XML sem movimento correspondente | **Reportar** `status=sem_movimento`, **NÃO inserir** registro novo. Criação de movimento continua sendo o `/upload`. |
| **P4** | Reprovada → revalidar automático | **Sim** — nota reprovada (`nota_ok` cheio + `erro_validacao` com mensagem) **pode** ser revalidada/sobrescrita por XML novo no lote, **sem** ação extra do usuário. |
| **P5** | Atualizar `valor` ao (re)validar | **NÃO** — gravar **apenas** `nota_ok`/`erro_validacao` (paridade com `/motorista/validar-nota`, que não regrava `valor`). |

### 12.1 Mapa de extração — padrão NACIONAL NFS-e (ancorado nos 3 XMLs reais)

Os 3 XMLs de `docs/nota_entrego/` são todos do **padrão nacional** (não ABRASF municipal). Estrutura
confirmada (arquivo:campo):

| Campo a extrair | Caminho no XML | Observação |
|---|---|---|
| **chave de acesso** (50 dígitos) | atributo `Id` de `<infNFSe>` → **remover prefixo `NFS`** | Ex.: `Id="NFS35503082243568174000168000000000009826065650835650"` → chave `355030822435681740001680000000000098260656508356 50`. **O nome do arquivo é exatamente a chave** (50 díg., sem prefixo) → casa direto com `getNFeKeyFromNotaOk` (basename do `nota_ok`). |
| **numnota** | `<nNFSe>` | Ex.: `98`, `146`, `114`. **NÃO** usar `<nDPS>` (nº do DPS) nem `<nDFSe>`. |
| **cnpj_prestador** | `<emit><CNPJ>` (= `<prest><CNPJ>` no `infDPS`) | Ex.: `43568174000168`, `44890502000100`, `55330677000180`. |
| **data_emissao** | `<dhEmi>` (em `infDPS`) ou `<dhProc>` (em `infNFSe`) | ISO com timezone; normalizar por dia para o fallback. |
| **valor** | `<vLiq>` (em `infNFSe`) ou `<vServ>` (em `vServPrest`) | Apenas leitura/validação — **não regravar** (P5). |
| tomador | `<toma><CNPJ>` | Nos 3 XMLs = `48904673000100` (**MOVEE**) → grupo Movee → FastAPI **não-nexus**. |

**Pontos-chave para a Fase 1 (`extractNfseFields`):**
1. A chave NFS-e nacional tem **50 dígitos** (≠ 44 da NFe modelo 55) e vem com prefixo **`NFS`** no
   atributo `Id` de `<infNFSe>`. Extração: `Id.replace(/^NFS/, '')`; **fallback** = basename do
   `filename` (que já é a chave pura), reusando a lógica de `getNFeKeyFromNotaOk`.
2. `numnota` = `<nNFSe>`. **Nunca** confundir com `<nDPS>`/`<nDFSe>`.
3. Tratar ausência graciosamente (campo `null` → cair no fallback `cnpj+numnota+data_emissao`),
   pois layouts ABRASF municipais (`<Nfse>`/`<infNfse>`/`<ChaveAcesso>`/`<Numero>`) podem aparecer no
   futuro — manter a extração defensiva e multi-layout, mas **ancorada** no padrão nacional acima.
4. **Verificar ao codar**: como `getNFeKeyFromNotaOk` (server.js:1705) normaliza o basename (tira
   extensão `.xml`, query string etc.) — garantir que a chave extraída do XML novo (50 díg., sem
   `NFS`) e a derivada do `nota_ok` existente fiquem no **mesmo formato** antes de comparar.

### 12.2 Fixtures

Os 3 XMLs reais estão em `docs/nota_entrego/` (copiados para uso na ancoragem da extração e nos
cenários E2E da Fase 3). ⚠️ Contêm CNPJs reais e certificado/assinatura — avaliar no PR se vão
versionados como fixtures de teste ou se entram no `.gitignore` (decisão do operador no review).
