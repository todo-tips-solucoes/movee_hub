# Project Briefing: busca de banco no app do motorista

> Briefing da frente corrente. O da frente anterior (corrigir o valor de um movimento,
> em produção desde 21/10) está no git, no commit do PR #287, e o plano completo em
> `docs/plans/corrigir-movimento/`.
>
> Detalhe desta frente, com as medições, em `docs/plans/filtro-banco-motorista/BRIEFING.md`.

## 1. Visão e Propósito

O motorista cadastra a conta bancária pelo app e **não encontra o banco dele** a menos
que saiba o código COMPE ou a razão social exata.

Pedido do operador (21/10): *"caso ele queira a conta nubank, seria interessante que ao
digitar `nu` o banco já retornasse."*

⚠️ **A hipótese inicial era que o filtro só casava o começo do texto. Medido, isso é
falso.** `routes/motorista-adiantamento.js:734-736` já normaliza o termo para minúsculas
e já usa `includes` no nome. Rodado contra a fixture real (463 bancos):

| Busca | Hoje |
|---|---|
| `nu` | ✅ acha `260 NU PAGAMENTOS - IP` (o Nubank) |
| **`nubank`** | ❌ **nada** — a fixture traz a razão social, não a marca |
| **`itau`** | ⚠️ acha `BCO ITAUBANK`, mas **não** `341 ITAÚ UNIBANCO` |
| `itaú` | ✅ acha |
| `260` | ✅ acha pelo código |

**As duas causas reais são acento e nome comercial**, não o operador de comparação.

## 2. Usuários e Stakeholders

| Quem | Como usa |
|---|---|
| **Motorista**, no celular (`app.motorista.moveelog.com.br`) | digita o nome do banco ao cadastrar a conta para receber adiantamento e repasse. É quem sofre o problema. |
| **Financeiro** (hub) | lança conta de pessoa física pelo hub; não usa esta busca. |

O motorista digita no teclado do celular, com pressa e sem acento. A busca precisa
funcionar para a marca que ele conhece.

## 3. Escopo

### MVP (Essencial)

1. **Ignorar acento** nos dois lados da comparação (`itau` acha `ITAÚ UNIBANCO`).
2. **Mapa de nomes comerciais** para os bancos mais usados pelo motorista:
   Nubank → NU PAGAMENTOS, PicPay, Inter, C6, Mercado Pago.
3. **Ranking**: o banco pedido vem **no topo**, não na posição 19 — o teto de 20 itens
   da tela permanece.

### Fora de Escopo

- Reescrever a fixture COMPE: apelido é camada de **busca**, não renomeação. O motorista
  precisa ver o nome real do banco escolhido, porque é o que aparece no comprovante.
- Trocar o `startsWith` do **código**: código é numérico e prefixo é o comportamento
  esperado (`260` → banco 260).
- Casar pedaços quaisquer do termo: digitar `banco` devolveria dezenas e pioraria a tela.

## 4. Prioridades e Trade-offs

Decisão do operador (21/10): **acento + apelidos comuns**, e não apenas acento — porque
sem o mapa de apelidos o `nubank` do próprio exemplo continua sem resultado.

Trade-off aceito: o mapa de apelidos é uma lista a manter. Mantém-se pequena e coberta
por teste, limitada aos bancos de fato usados pelos motoristas.

## 5. Restrições

- A busca é **server-side sobre fixture em memória** (`lib/fixtures/bancos-compe.json`,
  463 bancos). **Não há banco, PostgREST nem migration** no caminho — nada de índice,
  nada de RLS.
- Teto de **20 itens** no retorno: tela de celular.
- `lib/conta-bancaria-form.ts` recebe a lista por **injeção de dependência** e já tem
  teste — reusar, não duplicar.
- O app motorista roda `node --test` (**não** vitest) e **não tem arquivo de config de
  eslint** (baseline conhecida: `npm run lint` sai com erro de configuração ausente).
- ⚠️ `{/* */}` logo após `return (` quebra o build do turbopack.

## 6. Stack Técnica

- **Backend**: Express, Node 20. Rota `GET /bancos` em
  `routes/motorista-adiantamento.js:733`. Testes com `node --test`.
- **App motorista**: Next.js (PWA). Cliente em `lib/adiantamento-api.ts:230`
  (`buscarBancos`), form em `lib/conta-bancaria-form.ts`.

## 7. Qualidade e Padrões

- **Deduplicação**: a normalização de acento provavelmente já existe no repositório —
  **procurar antes de escrever** (`normalize('NFD')`, helpers de string). O repo já teve
  o mesmo mapa duplicado 3×.
- **Controle negativo obrigatório**: `nubank`, `itau` e `mercado pago` devem **falhar
  hoje** e passar depois; `nu` e `260` devem passar nos dois lados — e isso vai
  declarado como guarda de não-regressão, não como prova da correção.
- **Smoke agêntico em laço** (pedido explícito do operador): ver §6 de
  `docs/plans/filtro-banco-motorista/BRIEFING.md`. Como a rota não depende de banco, o
  smoke funcional roda **inteiro antes do merge**; reprovado ⇒ ajusta, roda a suíte
  completa de novo e repete o portão do zero. Só com tudo verde é que promove.
- Gates com números: `node --test` no backend e no app motorista; `next build` se tocar
  o app.

## 8. Visão de Futuro

Se a lista de apelidos crescer, movê-la para configuração por tenant (como o molde de
mensagem do adiantamento), em vez de constante no código.

## Itens a Definir

Nenhum. As decisões foram tomadas pelo operador em 21/10, antes do início do
desenvolvimento: acento **mais** apelidos comerciais; o `startsWith` do código fica.
