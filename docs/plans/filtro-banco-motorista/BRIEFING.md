# Busca de banco no app do motorista: achar pelo nome que ele conhece

> Pedido do operador em 21/10/2026: *"o motorista ao pesquisar por um banco só tem
> retorno caso ele saiba o código do banco. Por exemplo, caso ele queira a conta
> nubank, seria interessante que ao digitar `nu` o banco já retornasse."*

## 1. O diagnóstico — e ele NÃO é o suposto

A hipótese era "o filtro só casa o começo". **Medido, isso é falso para o nome.**

`routes/motorista-adiantamento.js:734-736` já faz:

```js
const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
const filtrados = q ? todos.filter((b) => b.codigo.startsWith(q) || b.nome.toLowerCase().includes(q)) : todos;
```

O `q` **já** é normalizado para minúsculas e o nome **já** usa `includes`. Rodado contra
a fixture real (`lib/fixtures/bancos-compe.json`, **463 bancos**):

| Busca | Hoje |
|---|---|
| `nu` | ✅ acha `260 NU PAGAMENTOS - IP` (o Nubank) |
| `NU` | ✅ acha (o `toLowerCase` do `q` funciona) |
| **`nubank`** | ❌ **NADA** |
| **`itau`** | ⚠️ acha `479 BCO ITAUBANK`, mas **NÃO** `341 ITAÚ UNIBANCO` |
| `itaú` | ✅ acha `341 ITAÚ UNIBANCO` |
| `260` | ✅ acha pelo código |

**As duas causas reais:**

1. **Acento.** A fixture usa o nome oficial com acento (`ITAÚ UNIBANCO S.A.`). Quem
   digita `itau` no teclado do celular não acha. Nenhum dos dois lados é normalizado.
2. **Nome comercial.** A fixture traz a razão social COMPE (`NU PAGAMENTOS - IP`), e o
   motorista digita a marca que conhece (`nubank`). O exemplo do próprio operador.

O `startsWith` do **código** é correto e fica: código é numérico e prefixo é o
comportamento esperado (`260` → o banco 260).

## 2. Decisão do operador (21/10): acento + apelidos comuns

- **Normalizar acento** nos dois lados da comparação (resolve `itau` → `ITAÚ UNIBANCO`).
- **Mapa pequeno de nomes comerciais** para os bancos que o motorista mais usa:
  Nubank → NU PAGAMENTOS, PicPay, Inter, C6, Mercado Pago. É o que faz `nubank` achar.

Descartado: casar por pedaços quaisquer do termo — digitar `banco` retornaria dezenas e
pioraria a tela em vez de ajudar.

## 3. Onde isso vive

| Camada | Arquivo |
|---|---|
| Rota | `app_homologacao/backend/routes/motorista-adiantamento.js:733` (`GET /bancos`) |
| Fixture | `app_homologacao/backend/lib/fixtures/bancos-compe.json` (463 bancos) |
| Cliente | `app_homologacao/frontend_motorista/lib/adiantamento-api.ts:230` (`buscarBancos`) |
| Form | `app_homologacao/frontend_motorista/lib/conta-bancaria-form.ts` (recebe a lista por injeção) |

A busca é **server-side** sobre fixture em memória — não há banco nem PostgREST no
caminho. Isso simplifica: nada de índice, nada de RLS, nada de migration.

## 4. Restrições

- O teto de **20 itens** no retorno (`.slice(0, 20)`) fica: a tela é de celular.
  Com apelidos, o ranking importa mais — o banco pedido deve vir **no topo**, não na
  posição 19.
- A fixture é **COMPE oficial**; não a reescreva. Apelido é camada de busca, não
  renomeação do banco (o motorista precisa ver o nome real do banco que escolheu, porque
  é o que aparecerá no comprovante).
- `lib/conta-bancaria-form.ts` já tem teste e recebe a lista por injeção de dependência
  — reusar, não duplicar.
- App motorista roda `node --test` (não vitest) e **não tem config de eslint**.

## 5. Requisitos de qualidade (padrão do operador)

Deduplicação, escalabilidade, segurança e performance. Aqui o risco é baixo (fixture em
memória, sem I/O), então o peso vai para:

- **Dedup**: a normalização de acento provavelmente já existe no repo — **procurar antes
  de escrever** (`normalize('NFD')`, `onlyDigits`, helpers de string).
- **Controle negativo obrigatório**: teste que falhe contra o código atual. `nubank`,
  `itau` e `mercado pago` devem falhar hoje e passar depois; `nu` e `260` devem passar
  nos dois lados (guarda de não-regressão, declarada como tal).

## 6. Rito do smoke — AGÊNTICO, com laço de ajuste (pedido do operador, 21/10)

> *"o smoke test tem que ser realizado de forma agêntica. o smoke sendo aprovado deve
> ser promovido o código, caso o contrário deve ser realizado os ajustes e os testes
> iniciados novamente."*

A rota `GET /bancos` serve de **fixture em memória** — não há banco, PostgREST nem
migration no caminho. Logo o smoke **funcional** pode rodar inteiro antes do deploy,
o que é melhor do que só provar depois: o defeito é pego sem atingir cliente.

### Portão 1 — smoke funcional PRÉ-merge (100% agêntico, em laço)

Sobe o backend da branch num processo/container efêmero e exercita a rota por HTTP.
**Casos e veredito esperado:**

| Busca | Veredito |
|---|---|
| `nubank` | **DEVE** achar `260 NU PAGAMENTOS` — hoje não acha (é o pedido) |
| `itau` | **DEVE** achar `341 ITAÚ UNIBANCO` — hoje não acha (acento) |
| `mercado pago` | **DEVE** achar o banco correspondente |
| `nu` | deve achar `260` **no topo** (não-regressão + ranking) |
| `260` | deve achar pelo código (não-regressão do `startsWith`) |
| `banco` | **NÃO** deve devolver dezenas de itens irrelevantes |
| `` (vazio) | devolve a lista, no teto de 20 |

**Laço:** qualquer caso reprovado ⇒ **não promove**. Ajusta, roda a suíte inteira de
novo (não só o caso que falhou, para não trocar um defeito por outro) e repete o
portão 1 do zero. Só com os 7 verdes é que o merge acontece.

### Portão 2 — smoke PÓS-deploy (agêntico no que é verificável)

1. **Prova de bundle** no container **vivo**, com controle negativo contra a imagem
   anterior. ⚠️ `grep --include` **não existe no busybox** e o WORKDIR do backend é
   `/var/lib/envioMassa_homologacao/app_homologacao` (o do frontend é `/app`) — os dois
   erros já deram falso negativo nesta sessão.
2. **Limite honesto:** `GET /motorista/bancos` exige token de motorista, então o smoke
   HTTP de produção não é executável pelo agente sem credencial. O que o agente prova é
   que **o código servido é o novo**; a confirmação funcional na tela é do operador —
   e ela é barata: digitar `nubank` no cadastro de conta.
3. Reprovado ⇒ **rollback imediato** para a imagem anterior, com o comando pronto no
   cabeçalho do script de deploy.

### Por que o portão 1 carrega o peso

Não existe staging do produto legado: o que há é produção e o ambiente do hub. Como
esta rota não depende de banco, o portão 1 cobre o comportamento inteiro antes de
qualquer cliente ser atingido. Em frentes que tocam `EnvioMassa` isso não vale — ali o
`hub_homolog` tem a tabela e o smoke pré-deploy é de integração, não de HTTP.
