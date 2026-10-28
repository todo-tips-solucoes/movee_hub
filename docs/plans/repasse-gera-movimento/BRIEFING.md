# BRIEFING — o repasse gera o movimento no Envio em Massa

> Frente aberta em 2026-10-28, a pedido do operador, para **corrigir o efeito nulo** da
> frente [`lancamento-externo`](../lancamento-externo/) — que está em produção, validada
> com dinheiro real, e **sem efeito**, porque depende de um passo que a operação não
> executa.

## 1. O problema, medido

A dedução dos valores pagos por fora só acontece no **fechamento da apuração**. Medido em
2026-10-28, o dia do pagamento da semana 19–25/10:

| Fato | Medição |
|---|---|
| Apurações fechadas na história | **0** (`ApuracaoRepasse` vazia) |
| Lançamentos pagos por fora registrados | **0** |
| Adiantamentos pendentes na semana | **116** (50 `LIBERADA` + 66 `EXPORTADA`) |

O fluxo real desta operação paga por **planilha** no Envio em Massa, não por fechamento
de apuração. Foi o mesmo motivo de a F5 ter ficado "no ar porém inerte" em 12/10
(ver `producao-2026-10-12`). Cinco rodadas de review mediram o código com rigor e
**nenhuma podia pegar isto** — era pergunta de operação, não de código.

## 2. A correção pedida pelo operador (literal)

> *"o mecanismo deve funcionar igual ao da tabela envioemmassa para gerar e o valor de
> nota. ao inves de fechar a planilha, o financeiro deve gerar movimento para o
> recebimento de nota na tela de envioemmassa, inserindo valor para a emissao da nota do
> motorista. o fluxo depois disso deve funcionar como ja funciona hoje. a unica alteração
> é a forma como o envio em massa é preenchido hoje."*

Ou seja: **o repasse passa a preencher o Envio em Massa**, e daí para frente o fluxo é o
que já roda (disparo, emissão, validação de XML, fechamento de movimento).

## 3. 🟢 O mecanismo JÁ EXISTE — isto é um desacoplamento, não uma construção

Levantado no código antes de planejar:

| Peça | Onde | Estado |
|---|---|---|
| Decide quem vira movimento e monta a linha | `backend/lib/adiantamento-geracao-movimento.js` (F4-B) | **pronta**, lógica pura e testada |
| Rota que grava na `EnvioMassa` + trilha de idempotência | `backend/routes/hub-adiantamentos.js:2177` (`POST /repasse/:periodo/movimentos`) | **pronta**, permissão `adiantamentos.pagamento_confirmar` |
| Botão "Gerar notas da semana" | `frontend_v2/app/hub/dashboard/adiantamentos/repasse/page.tsx:251` | **pronto**, bloqueado por `periodoAberto` |
| Motivos de recusa nomeados | `MOTIVOS` em `adiantamento-geracao-movimento.js` | **prontos**, incluem `MOVIMENTO_ABERTO` ("provavelmente da planilha") |
| Divisão nota × fora-nota | `valor_nota` / `valor_fora_nota` (config `categorias_nota`) | **pronta** |
| Retenção abaixo do mínimo + saldo transportado | `0098` em diante | **pronta** |

**Os três pontos que travam, e são a frente inteira:**

1. `backend/routes/hub-adiantamentos.js:2193` — `if (!apuracao) return res.status(409) 'APURACAO_NAO_FECHADA'`
2. `frontend_v2/.../repasse/page.tsx:251` — botão Gerar desabilitado quando `periodoAberto`
3. `frontend_v2/.../repasse/page.tsx:239` — botão "Fechar apuração" manual, que sai da tela

## 4. Decisões do operador — 12, todas tomadas ANTES de começar

| # | Questão | Decisão |
|---|---|---|
| D1 | O que congela o valor | **Fecha a apuração e gera num passo só**, em transação. O retrato imutável e o saldo transportado continuam valendo; o financeiro nunca vê a palavra "apuração" |
| D2 | De onde sai o pago por fora | **Só da parte da nota**. Gorjeta intacta |
| D3 | Pago por fora **maior** que a parte da nota | **Zera a nota** (não emite) + gorjeta intacta + **o excedente vira saldo** para a semana seguinte, pelo mecanismo que já existe |
| D4 | Botão manual "Fechar apuração" | **Sai da tela.** A função continua no código, usada por baixo pelo Gerar — evita o estado "apuração fechada sem movimento", que travaria a geração sem caminho de volta pela tela |
| D5 | Adiantamento do app pendente na semana | **Recusa e LISTA quem trava**, com status e nomes. Protege contra pagar duas vezes quando o adiantamento é pago depois da nota |
| D6 | Motorista já tem movimento da planilha | **Não gera e avisa** — comportamento que o código já tem (`MOVIMENTO_ABERTO`) |
| D7 | Valor abaixo do mínimo (R$ 5,50) | **Mantém a retenção**: não gera nota, soma na semana seguinte |
| D8 | Onde o financeiro dispara | **Nos dois lugares**: tela de Repasse (onde já está) **e** tela de Envio em Massa (ao lado do upload) |
| D9 | Qual semana processa | **A que estiver na tela** — gera exatamente os números que o financeiro está vendo |
| D10 | Mensagem ao motorista | **Modelo da empresa, como hoje.** Modelo ausente ⇒ **recusa e avisa**, nunca inventa texto |
| D11 | Corrigir geração errada | **Pela tela de Envio em Massa** — editar valor com motivo, ou apagar a linha. Fluxo que já existe desde 21/10. **Sem** botão de desfazer |
| D12 | Fechamento de **movimento** (Envio em Massa) | **Não muda nada.** É outro conceito, manual e opcional, como hoje |

⚠️ **D1 × D4 não se contradizem**: o fechamento da *apuração* passa a ser automático e
invisível; o que sai da tela é o **botão manual**.

⚠️ **Dois "fechamentos" diferentes, e confundi-los custou uma rodada de perguntas:**
"Fechar movimento" (Envio em Massa) encerra as linhas de um movimento — permanente, sem
reabrir, é o que a operação usa. "Fechar apuração" (hub › Repasse) grava o retrato
imutável do repasse — **nunca foi usado**. Esta frente mexe só no segundo.

## 5. Escopo

### Entra

1. A rota `POST /repasse/:periodo/movimentos` passa a **fechar a apuração se ela não
   existir**, na mesma transação da geração (D1).
2. A dedução do pago por fora sai da **parte da nota**, com o excedente virando **saldo
   transportado** (D2, D3).
3. **Recusa com diagnóstico** quando há adiantamento pendente: quantos, em que status,
   quais motoristas (D5).
4. O botão Gerar deixa de exigir período fechado; o botão **"Fechar apuração" sai** (D4).
5. **Botão novo na tela de Envio em Massa** — "Gerar do repasse" (D8).
6. Ajuda atualizada nas duas centrais.

### Fora

- Nenhuma mudança no fluxo **depois** do movimento criado: disparo, emissão, validação de
  XML e fechar movimento seguem como são.
- Nenhuma mudança no upload de planilha do Envio em Massa.
- Sem botão de desfazer a geração (D11).
- Sem alteração no app do motorista (a parcela "pago por fora" no extrato já está no ar).

## 6. Stack

Node 20 + Express sem ORM · PostgreSQL via PostgREST com funções `SECURITY DEFINER` ·
Next.js 16 App Router + React · Tailwind 4 + Base UI + shadcn · testes `node --test`
(backend), vitest (frontend_v2), Playwright (E2E do hub).

Skills de documentação oficial a consultar: `postgresql` / `postgres-best-practices`,
`nodejs-backend-patterns`, `nextjs-app-router-patterns`, `tailwind-patterns`,
`vitest-skill`, `typescript-pro`.

## 7. Riscos, cada um com a medição que o sustenta

| Risco | Por que importa | Mitigação exigida |
|---|---|---|
| 🔴 **Caminho do dinheiro** | A rota passa a fechar apuração **e** criar movimento que gera nota fiscal. Erro aqui emite nota errada | Transação única; controle negativo por conserto; cenário de ponta a ponta no `hub_homolog` |
| 🔴 **`EnvioMassa` não tem RLS alguma** | O filtro de `id_empresa` na query é a **única** proteção de tenant (medido na frente `corrigir-valor`) | Escopo explícito em toda query nova |
| 🔴 **D3 cria caminho novo de saldo** | "Excedente vira saldo" usa o mecanismo de transporte, que hoje só recebe valor retido por mínimo | Teste que prove o saldo chegando à semana seguinte, com controle negativo |
| ⚠️ **`mensagem1_modelo` é NULL no hub-homolog** | O teste de integração passaria pelo ramo de recusa sem exercitar o caminho feliz | Fixture própria com modelo configurado |
| ⚠️ **116 adiantamentos pendentes hoje** | Com D5, o financeiro não gera até resolver | A recusa tem de **nomear** quem trava, senão vira adivinhação |
| ⚠️ **Dois botões, um recurso** (D8) | Duplicar a chamada duplica a chance de divergir | Um só componente, usado nas duas telas |

## 8. Gates (números de 2026-10-28, a medir no início)

backend `npm test` **2136/0** · `test:hub:unit` **1426/0** · `tsc` limpo nos dois ·
vitest `frontend_v2` **981/0** · app motorista **126/0** (`node --test`, **não** vitest) ·
lint **28 (5/23)** = baseline · `hub-adiantamentos-integration` **231/0** ·
`hub-lancamento-externo-integration` **150/0** · `hub-repasse-lote-integration` **86/0** ·
roundtrip **57/0** · rollback **37 PASS** · perf APROVADO · `package-lock.json` sem diff.

## 9. Lições da frente anterior que valem aqui

- **4 das 15 correções criaram defeito novo.** As duas mais elegantes foram as mais
  caras. Preferir **restringir** a generalizar.
- **Uma guarda não pode exigir o que a ação não consegue desfazer** (o deadlock do
  crédito imortal).
- **Um alarme escopado à causa não vê quem removeu a causa** (o contador cego).
- **Teste que passa com e sem a correção é achado**, não cobertura.
- **A prévia do repasse devolve ZERO sem a claim de escopo** — parece defeito e não é.
- ⚠️ **Perguntar se a operação EXECUTA o passo de que a feature depende** — é o erro que
  criou esta frente.

## 10. Itens a definir

**Nenhum.** As 12 decisões foram tomadas antes de começar, a pedido do operador, para que
o desenvolvimento não precise interromper.
