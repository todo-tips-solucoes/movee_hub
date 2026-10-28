# Contrato de UI — `<GerarDoRepasseButton>`: um componente, três telas (duas montagens em código)

**Feature**: `repasse-gera-movimento` · **Data**: 2026-10-28
**Requisitos**: D4, D8, D9 · FR-013, FR-014, FR-015, FR-016

> **[VIGENTE]** = lido do código. **[PROPOSTA]** = desenho novo desta frente.

---

## O componente

**[PROPOSTA]** `app_homologacao/frontend_v2/components/hub/gerar-do-repasse-button.tsx`

Mora em `components/hub/` porque consome `lib/hub/*` e o contexto de autenticação do hub. O import cruzado legado→hub **já tem precedente** nesta base **[VIGENTE]**: `components/data-table.tsx:8` importa `@/components/hub/cabecalho-ordenavel`, e `app/layout.tsx:9` importa `@/components/hub/env-badge`.

### Props

| Prop | Tipo | Significado |
|---|---|---|
| `periodo` | `string \| undefined` | Semana a processar, `'YYYY-MM-DD'`. **Definida** ⇒ o componente usa essa semana e **não** mostra seletor (a tela manda — D9). **`undefined`** ⇒ o componente mostra o próprio seletor |
| `onSucesso` | `() => void \| Promise<void>` (opcional) | Chamado depois de uma geração bem-sucedida. Na tela de Repasse recebe o `refetch` da listagem |

**Uma única prop decide a diferença entre as duas montagens em código** (Repasse e `action-bar.tsx`; esta última aparece em **duas telas**, ver Montagem 2). Não há `variant`, `modo`, nem flag de tela — toda a lógica de geração, recusa e exibição é compartilhada byte a byte (FR-015).

### Responsabilidades

1. Renderiza **nada** quando `permissoes` não inclui `adiantamentos.pagamento_confirmar` (FR-016).
2. Seletor de semana **só** quando `periodo` é `undefined`: `<input type="date">`, ⚠️ **default = a semana IMEDIATAMENTE ANTERIOR à corrente**, i.e. `inicioDaSemanaApuracao(new Date(), apuracaoDiaInicio)` menos 7 dias (P8). O default da tela de Repasse (`lib/hub/periodo.ts:46`) é a semana **corrente**, que por `MIG/0067:1899` **sempre** recusa `PERIODO_EM_ABERTO` — copiá-lo faria o botão nascer recusando. Mesmo com o default correto a recusa pelo corte D-1 ainda pode ocorrer (segunda-feira cedo): ela continua explicada na tela. O valor enviado é **sempre ISO** `'YYYY-MM-DD'` (`<input type="date">`), com `apuracaoDiaInicio` de `obterConfiguracoes()`.
3. Chama `gerarMovimentos(periodo)` de `lib/hub/adiantamentos-api` **[VIGENTE]** — **uma** função, **uma** rota.
4. Sucesso: toast com `"N movimento(s) gerado(s)"` + `"N sem telefone"` + `"N não gerado(s)"`, com `description: resumirRecusas(r.recusados)` de `lib/hub/adiantamento-recusas` **[VIGENTE]**. `gerados === 0 && recusados.length === 0` ⇒ toast informativo.
5. Recusa `409 ADIANTAMENTOS_PENDENTES`: **abre diálogo com a lista** (abaixo), não um toast.
6. Outros 409 do fechamento: mensagem própria por código (tabela abaixo).
7. `disabled` enquanto a chamada está em voo (`gerando`) **[VIGENTE]**.

### Estado que **não** é do componente

A semana da tela de Repasse (estado `periodo` de `useRepasseLista`) **[VIGENTE]** continua pertencendo à página. O componente a recebe por prop e nunca a escreve — D9 diz *"gera exatamente os números que o financeiro está vendo"*, e um segundo lugar que pudesse mudar a semana violaria isso.

---

## Montagem 1 — tela de Repasse

`app_homologacao/frontend_v2/app/hub/dashboard/adiantamentos/repasse/page.tsx`

### Sai **[PROPOSTA]**

| O que | Onde hoje **[VIGENTE]** | Por quê |
|---|---|---|
| Botão **"Fechar apuração"** | JSX ~`:232`–`:243`, `disabled={!h.dados \|\| !periodoAberto}`, handler `fecharDialog.abrir` | D4 — *"Sai da tela"* |
| `<FecharApuracaoDialog d={fecharDialog} />` | ~`:397` | consequência do acima |
| `useFecharApuracaoDialog(...)` | import de `components/hub/adiantamento-fechar-apuracao-dialog` | idem |
| Botão inline **"Gerar notas da semana"** | JSX ~`:245`–`:259` | substituído pelo componente |

⚠️ A **lógica de exibição de pendências** do diálogo aposentado (o tratamento de `APURACAO_COM_PENDENCIAS` que guarda `e.detalhe` em `pendencias`) **não** é descartada: ela migra para o diálogo de recusa do novo componente. Deleção líquida — a lógica sobrevive onde passou a ser necessária, em vez de nascer uma segunda.
⚠️ **Além da exibição de pendências, o diálogo carrega a confirmação de remanescente negativo e o `AvisoLancamentoExterno`** (`adiantamento-fechar-apuracao-dialog.tsx:54`–`:56`, `:93`–`:135`). Essa confirmação é **"informado, não bloqueado"** (comentário do próprio código: *"fechar é irreversível e a operação fecha na segunda — recusar o fechamento travaria o repasse"*): exigida, **nunca** impeditiva. **Migra com a semântica idêntica** — rotulá-la "fail-closed" e migrá-la como bloqueio mudaria comportamento de dinheiro em produção. A migração (com os 5 testes) vem **antes** de remover o diálogo.

⚠️ `fecharRepasse()` no client `lib/hub/adiantamentos-api.ts:737`–`:750` e a rota `POST /repasse/:periodo/fechar` no backend **PERMANECEM**. FR-013 é literal: *"a capacidade de fechar a apuração MUST permanecer no sistema, acionada apenas pela geração"*. D4 remove o **botão**, não a função.

### Entra **[PROPOSTA]**

```tsx
{/* a semana vem da tela (D9); sem seletor próprio */}
<GerarDoRepasseButton periodo={h.periodo} onSucesso={h.refetch} />
```

### Muda de condição **[PROPOSTA]**

`periodoAberto` **[VIGENTE]** é `h.dados?.periodo.situacao === 'aberto'` (~`:184`), e `situacao` vem do backend como `apuracao ? 'fechado' : 'aberto'` (`routes/hub-adiantamentos.js:1962`). ⚠️ **"Aberto" significa "sem apuração fechada"** — não tem nada a ver com o corte D-1.

Logo o `disabled={... || periodoAberto}` e o `title="Feche a apuração antes de gerar as notas."` **[VIGENTE]** deixam de fazer sentido: eram exatamente o travamento nº 2 do BRIEFING §3. **O botão passa a ficar habilitado com a semana aberta** (FR-013), e o que antes era bloqueio de UI vira **recusa explicada do servidor** quando for o caso.

`periodoAberto` **continua existindo** para informar o estado da semana na tela (é dado útil), só não gateia mais o botão.

---

## Montagem 2 — telas de Envio em Massa (legada **e** hub: `action-bar.tsx` é compartilhado)

`app_homologacao/frontend_v2/components/action-bar.tsx`, ao lado do `<ImportButton>` (`:109`) **[VIGENTE]**.

```tsx
{/* sem `periodo`: aqui NÃO existe semana na tela, o componente oferece a sua */}
<GerarDoRepasseButton />
```

### Por que o componente traz o próprio seletor aqui

**[VIGENTE]** A tela de Envio em Massa é `app/dashboard/page.tsx` (painel **legado**). O período (`dt_inicial`/`dt_final`) é estado **local do `ImportButton`** (`:65`–`:66`), digitado pelo usuário dentro do diálogo de upload, **depois** de escolher o arquivo. **O dashboard não tem noção de semana** — não há o que passar por prop.

Essa é a **única** diferença de uso entre as duas montagens, e ela é obrigatória, não acidental.

⚠️ **`action-bar.tsx` é COMPARTILHADO** (auditoria, `dec-025`): `app/hub/dashboard/envio_massa/page.tsx:49` também o monta, dentro de `HubAuthProvider` + `HubSessionGuard`. Montar o botão ali o faz aparecer em **duas telas** (legada e hub), com **um** ponto de montagem no código. A prop `periodo` que o `action-bar` já recebe (`:30`) é, na tela do hub, **texto** `'DD/MM/AAAA a DD/MM/AAAA'` (`envio_massa/page.tsx:214`–`:221`), **não** ISO — **decisão (a mais conservadora)**: o `action-bar` **não repassa** essa prop ao `<GerarDoRepasseButton>`; o botão usa **sempre o seu próprio seletor** ISO nas telas de Envio em Massa. Nenhuma normalização de formato é feita (restringir, não generalizar).

### Permissão no painel legado (FR-016)

**[PROPOSTA]** Montar `HubAuthProvider` em `app/dashboard/layout.tsx`, **sem** o `HubSessionGuard`.

**[VIGENTE]** O que torna isso seguro: `HubAuthProvider` é montado hoje só em `app/hub/layout.tsx:42` e `app/selecionar-entidade/layout.tsx:21`; o painel legado usa o `AuthProvider` legado (`app/layout.tsx:47`). **O provider em si não redireciona** — o redirect vive no `HubSessionGuard`, componente **irmão** (`app/hub/layout.tsx:44`).

Resultado: sem sessão de hub, `permissoes` vem `[]` e **o botão simplesmente não renderiza** — FR-016 satisfeito nas duas telas com **zero mecanismo novo**, sem redirect, sem tocar na autenticação legada.

⚠️ **Custo honesto**: o provider faz um `GET /me` no mount, então o dashboard legado passa a fazer essa chamada. É a **mesma** chamada que o hub já faz, pelo mesmo proxy `app/api/[...path]`. O que **não** se faz é mexer em cookie ou em fluxo de login — a colisão de cookie hub↔legado é incidente conhecido desta base (PR #87) e fica fora do caminho.

⚠️ **Verificar na implementação**: `app/dashboard/layout.tsx` existe **[VIGENTE]** e é onde o provider entra. Confirmar que nenhuma página sob `app/dashboard/**` já chama `useHubAuth()` por outro caminho (hoje não chama — `app/dashboard/**` não importa de `components/hub` nem de `lib/hub`).

---

## Diálogo de recusa por adiantamento pendente

**[PROPOSTA]** — consome o `409 ADIANTAMENTOS_PENDENTES` de `contracts/hub-repasse-gerar-movimentos.md`.

```
┌──────────────────────────────────────────────────────┐
│ Não é possível gerar esta semana                     │
│                                                      │
│ 116 adiantamentos ainda pendentes:                   │
│   • LIBERADA   50                                    │
│   • EXPORTADA  66                                    │
│                                                      │
│ Motoristas que travam (20 de 116):                   │
│   Fulano de Tal ................... LIBERADA         │
│   …                                                  │
│   + 96 não listados                                  │
│                                                      │
│ Resolva os adiantamentos e tente de novo.            │
│                                            [Fechar] │
└──────────────────────────────────────────────────────┘
```

| Regra | Por quê |
|---|---|
| **Lista renderizada de verdade**, não só toast | FR-009 exige nomear. Hoje o resultado da geração é **só** toast **[VIGENTE]** — e a frente de 23/09 custou caro por propor rótulo sem abrir a tela: aqui o dado novo (nomes) precisa de lugar onde se leia |
| Exibe `motoristasOmitidos` quando > 0 | Com 116 pendentes, esconder o resto faria o financeiro achar que resolveu ao tratar 20 |
| **Sem CNPJ, telefone, conta ou valor** | Gate de privacidade de 01/10. Nome + status + id bastam |
| Reusa a estrutura de exibição de `pendencias` do diálogo aposentado | Deleção líquida; não nasce um segundo componente de pendência |

---

## Mensagens das outras recusas

**[PROPOSTA]** — texto; os códigos são **[VIGENTE]** (`routes/hub-adiantamentos.js:2110`–`:2135`).

| Código | O que a tela diz |
|---|---|
| `PERIODO_EM_ABERTO` | ⚠️ A semana ainda pode receber pedido de adiantamento da produção do último dia. Precisa dizer **até quando esperar** — é a recusa mais provável e a mais confundível com defeito |
| `APURACAO_FORA_DE_ORDEM` | Há uma semana anterior ainda não processada; processe-a primeiro |
| `APURACAO_NAO_CONFIGURADA` | A configuração do repasse está incompleta |
| `PERIODO_DESALINHADO` | A data escolhida não é o início de uma semana de apuração |
| `EMPRESA_SEM_CNPJ` | O CNPJ da empresa não está cadastrado — sem ele a nota é reprovada na validação |
| `PERMISSAO_NEGADA` | 403; na prática inalcançável porque o botão não renderiza sem a permissão |

⚠️ **Nenhuma dessas recusas desaparece com D1.** D1 remove o passo manual, não as regras do fechamento. Mostrar "Gerar do repasse" habilitado e devolver recusa sem explicação é o modo de falha que o BRIEFING §7 nomeia — cada código precisa do seu texto.

---

## Convenções de borda deste componente

| Camada | Case | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas no Postgres | `snake_case` | migration | `infra/hub/migrations/*.sql` |
| Payload da API (req/resp) | `camelCase` | mapeamento explícito na rota | `contracts/hub-repasse-gerar-movimentos.md` |
| Tipos TS do client | `camelCase` | tipagem em `lib/hub/adiantamentos-api.ts` | o próprio arquivo |
| Path param `:periodo` | `'YYYY-MM-DD'` | regex na rota + `<input type="date">` | rota + `lib/hub/periodo` |

A rota já faz o mapeamento `snake_case → camelCase` à mão (`apuracao_id → apuracaoId`) **[VIGENTE]**; não há ORM nem automapeamento. O 409 novo segue a mesma convenção (`porStatus`, `motoristasOmitidos`, `entregadorId`).

---

## Testes de UI exigidos

⚠️ **[VIGENTE] Hoje não existe nenhum teste vitest cobrindo `gerarMovimentos` nem o botão "Gerar notas da semana"** — `page.test.tsx` tem 19 testes e mocka só `fecharRepasse`; `adiantamentos-api.test.ts` tem 15, nenhum de `gerarMovimentos`. A frente **cria** essa cobertura; ela não existe para ser mantida.

| Teste | Prova |
|---|---|
| `components/hub/gerar-do-repasse-button.test.tsx` — sem a permissão, nada renderiza | FR-016 |
| idem — `periodo` definido ⇒ **sem** seletor; `periodo` undefined ⇒ **com** seletor, default = **semana anterior à corrente** (nunca a corrente), valor enviado em ISO | D9 + a única diferença entre montagens + P8 |
| idem — **guarda de remanescente negativo migrada**: caixa de confirmação exigida com `qtdNegativo > 0` **e** com resumo desconhecido (carregando / erro / campo ausente); com `qtdNegativo === 0` conhecido **não** exige; e **nunca recusa** — marcada a caixa, o fechamento segue ("informado, não bloqueado") | P9 / U3. Os **5 testes** de `repasse/page.test.tsx:193`–`:250` migram **antes** da remoção do diálogo, **sem alterar as asserções** |
| idem — 409 `ADIANTAMENTOS_PENDENTES` abre diálogo com contagem por status, nomes e `motoristasOmitidos`; e o corpo renderizado **não** contém CNPJ/telefone/valor | FR-009 + gate de privacidade |
| idem — cada 409 do fechamento gera a sua mensagem (6 códigos) | o modo de falha "recusa misteriosa" |
| `repasse/page.test.tsx` — "Fechar apuração" **não** existe mais; "Gerar" habilitado com semana **aberta** | D4 + FR-013. ⚠️ **O teste tem de falhar antes da mudança** (hoje o botão existe e o Gerar está desabilitado), senão é teste oco |
| teste de montagem única | FR-015: as telas renderizam o **mesmo** componente (Repasse + `action-bar`, que serve as duas telas de Envio em Massa), e `gerarMovimentos` é chamada **uma** vez por acionamento |
