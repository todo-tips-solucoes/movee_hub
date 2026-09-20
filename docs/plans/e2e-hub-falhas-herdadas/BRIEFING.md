# Briefing — falhas herdadas no E2E do hub (medidas em 2026-09-20)

> Estado: **4 identificadas, 3 resolvidas (§2.1, §2.2, §2.3), 1 aberta (§2.4).**

Prompt para sessão limpa. **Leia o `CLAUDE.md` antes de qualquer coisa**: o ambiente
chamado "homologação" É produção, o ciclo git é cláusula pétrea e **autorização é por
etapa**. Repositório é público — nenhum dado pessoal real em código, teste, log ou
documento.

Tudo aqui foi **medido em 5 execuções do E2E**, não suposto. Onde é hipótese, está dito
— e a §2.1 mostra o que acontece quando a hipótese está errada.

---

## 1. O problema, medido

`infra/hub/testes/hub-shell-e2e-browser.sh` fecha hoje com **138 passed / 1 failed**
(era 133/5 quando isto foi descoberto), restando só a §2.4. A última execução arquivada antes disso
(`docs/plans/hub-frota/evidencias/S3/fase6-browser-run-20260821T145301Z.log`,
**2026-08-21**) fechou **138 passed / 0 failed**.

Entre 21/08 e 20/09 entrou a feature de adiantamento inteira (PRs #182–#192) e **este
E2E não foi rodado**. As 4 falhas são regressões acumuladas que passaram despercebidas.

Foram descobertas de raspão, durante a verificação do PR #194 (bump do Next), e
**confirmadas como independentes da versão do Next**: aparecem igual com `16.2.3` e com
`16.3.5`.

| Execução | Placar |
|---|---|
| controle, next 16.2.3 | 133 / 5 |
| next 16.3.5 (1ª) | 132 / 6 |
| next 16.3.5 (2ª) | 133 / 5 |
| depois da correção de §2.1 (2 execuções) | 135 / 4 |
| depois das correções de §2.2 e §2.3 | **138 / 1** |

---

## 2. As falhas estáveis, com a causa medida

### 2.1 `sessao-expira.spec.ts:29` — ✅ RESOLVIDA (2026-09-20)

**A expulsão de sessão NUNCA esteve quebrada. Era o teste medindo o caminho errado.**

⚠️ **A hipótese que estava escrita aqui — "a renovação silenciosa pode estar engolindo o
token corrompido e renovando em vez de expulsar", sugerindo defeito de produto — foi
INVESTIGADA E É FALSA.** O produto está correto. Fica o registro para ninguém partir dela.

O mecanismo, medido:

1. o teste corrompia **só** o `hub_accessToken`;
2. `accessVenceEmBreve` (`lib/hub/sessao-proxy.ts:25`) cai no `catch` e devolve `true`
   para token indecifrável — trata como vencido;
3. o proxy então **renova antes de encaminhar**, usando o `hub_refreshToken`, que o teste
   não tocava e continuava válido;
4. a renovação dá certo, a resposta é 200, nunca há 401, nunca há logout.

Desde **2026-09-06** ([[plano-hub-sessao-inatividade]]), **access morto não é sessão
expirada — sessão expirada é REFRESH inválido.** Corromper só o access exercita hoje o
caminho de RENOVAÇÃO.

Corrigido corrompendo os **dois** cookies, mais uma contraprova nova (`access morto +
refresh válido RENOVA, não expulsa`). ⚠️ **Não corrigir isto no produto:** fazer o proxy
expulsar a cada access vencido "conserta" o teste e **quebra a inatividade deslizante de
6 h**, que é deliberada.

### 2.2 `impeccable-rodada10.spec.ts:19` — ✅ RESOLVIDA (PR #197)

Era **produto**: permissão chegava à tela em código cru, sem rótulo em português.

⚠️ **Eram TRÊS permissões, não a única que o teste acusava.** Consultando o banco
(`SELECT codigo FROM "Permissao"`) em vez de confiar na lista do teste: **49 permissões**,
enquanto a lista do unit estava parada em 2026-08-10 com 43. Sem rótulo:

- `motoristas.dados_sensiveis` (migration 0059)
- `motoristas.enriquecimento.consultar` (conta de serviço do robô EntreGô)
- `motoristas.enriquecimento.atualizar` (idem)

⚠️ **As duas do robô têm DOIS pontos no código**, e o regex do detector era
`/^[a-z_]+\.[a-z_]+$/` — exige UM ponto. **Passaram meses cruas sem este gate acusar.**
Regex corrigido para `/^[a-z_]+(\.[a-z_]+)+$/` no mesmo PR.

⚠️ **Causa raiz recorrente — lista fixa que sai de sincronia em silêncio**, a mesma classe
da contagem fixa de módulos do PR #193. Ao mexer em permissão, reconferir contra o banco.

### 2.3 `impeccable-rodada3.spec.ts:129` — ✅ RESOLVIDA (PR #197)

Era **produto**: o card do módulo **Avisos** aparecia sem o texto que diz *o que o módulo
faz*. O módulo nasceu na migration `0062` e nunca entrou no `DESCRICAO_MAP`
(`lib/hub/module-nav.ts`). Redação seguindo a regra do próprio arquivo — o que o operador
FAZ ali, não o que a tela é.

### 2.4 `impeccable-rodada3.spec.ts:51` — ⚠️ A ÚNICA AINDA ABERTA

```
Error: element(s) not found
  waiting for getByLabel('De (data de competência)', { exact: true })
  > await expect(campoDe).toHaveValue('');
```

O campo com rótulo exato `De (data de competência)` não é encontrado em
`/hub/dashboard/faturamento`. **Hipótese:** o rótulo mudou ou o campo foi reestruturado
por alguma entrega recente — confirmar lendo a tela antes de mexer no teste.

---

## 3. ⚠️ A causa RAIZ provável, e o que fazer com ela

O seed do driver ativa **todos os módulos do catálogo** para as entidades sintéticas:

```sql
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, e.empresa_id, true FROM "Modulo" m CROSS JOIN (VALUES (950101),(950102)) …
```

Ou seja: **todo módulo ou permissão novo entra automaticamente no E2E** e quebra se não
trouxer o acabamento de UI que os testes exigem (rótulo em português, ajuda contextual).
Foi o que aconteceu com `avisos` (0062) e `motoristas.dados_sensiveis`.

Isso é bom — o E2E é um detector honesto de "feature entregue sem acabamento". O defeito
é o E2E **não rodar no ciclo**: ficou 1 mês parado e acumulou 4 dívidas em silêncio.

**Consequência para o trabalho:** corrigir as falhas é metade. A outra metade é decidir como
esse E2E volta a rodar regularmente — hoje nada o obriga.

---

## 4. Como reproduzir, e os 4 enganos que custam tempo

```bash
infra/hub/testes/hub-shell-e2e-browser.sh
```

- ⚠️ **O driver NÃO builda o frontend.** Ele aponta para o projeto `hub-homolog` vivo.
  Se você mudou código do frontend e não rebuildou a imagem, **está testando o binário
  antigo** e o resultado não significa nada (teste oco). Rebuildar:
  `DOCKER_BUILDKIT=0 docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog
  --env-file /var/lib/hub_secrets/.env.hub.homolog build --memory=2g frontend` e
  `up -d frontend`. Confirmar dentro do container antes de rodar.
- ⚠️ **Cold start derruba o `global-setup`.** Logo após `up -d`, a primeira requisição do
  Next standalone é lenta e o `getByLabel('Email')` estoura os 30 s — a falha PARECE
  quebra de login e é só aquecimento. Bater um `curl -sk https://localhost:8443/hub/login`
  antes e só então rodar.
- ⚠️ **O container do Playwright REESCREVE `frontend_v2/package-lock.json`** (npm de outra
  versão, via bind mount). Em 2026-09-20 removeu 47 pacotes / 1027 linhas. **Conferir com
  `git diff --stat` e restaurar antes de commitar.** Ele também sobrescreve prints
  versionados em `evidencias/S3/`.
- ⚠️ **O E2E é flaky.** Além das estáveis, `rodada8:21` (skip link), `rodada10:58`,
  `rodada9:61` e `rodada9:32` falharam **uma vez cada**, em execuções diferentes e nos
  dois lados do controle. **Não trate uma falha isolada dessas como regressão sem repetir
  a execução.**

---

## 5. O que NÃO refazer

- **Não re-investigue se é o Next 16.3.5.** Já medido com controle em 3 execuções: não é.
- **Não "conserte" o teste mudando o esperado** sem antes olhar a tela. Em 2.2 e 2.3 o
  teste estava certo e **o produto é que estava incompleto** — a correção foi na UI, não
  na asserção. (Em 2.4 pode ser o inverso; por isso segue marcado como hipótese.)
- **Não re-investigue 2.1, 2.2 e 2.3** — resolvidas nos PRs #196 e #197, com controle
  negativo medido em cada uma.
- O baseline 138/0 de 21/08 está arquivado em `evidencias/S3/` — serve de referência do
  que já passou um dia.

---

## 6. Entregáveis sugeridos

1. ~~Corrigir **2.1**~~ — ✅ PR #196: era **teste**, não produto.
2. ~~Corrigir **2.2** e **2.3**~~ — ✅ PR #197: era **produto**, e eram 3 permissões, não 1.
3. **Investigar 2.4** e decidir se é teste ou produto — **o que sobrou**.
4. Decidir **como o E2E volta ao ciclo**, senão isto se repete na próxima feature.
   Das 4 falhas, 3 nasceram de feature entregue sem acabamento e 1 de premissa de teste
   que envelheceu; nenhuma teria durado um mês se o E2E rodasse no ciclo.

⚠️ **Duas lições que valem para a §2.4, a que sobrou:**

1. **Hipótese é hipótese.** A de §2.1 apontava defeito de produto e estava ERRADA. Medir o
   mecanismo antes de mexer — e desconfiar quando "corrigir o produto" significaria
   desfazer uma decisão deliberada.
2. **O que o teste acusa pode ser só a ponta.** Em §2.2 o teste nomeava 1 permissão e
   eram 3: as outras duas o próprio detector não enxergava. Conferir contra a fonte de
   verdade (o banco), não contra a lista que o teste carrega.

Relacionado: [[gotcha-suite-integracao-hub-2-falhas-herdadas]] (baselines dos drivers de
integração, zeradas no PR #193), [[plano-hub-sessao-inatividade]], [[gotchas-medicao-ui-hub]].
