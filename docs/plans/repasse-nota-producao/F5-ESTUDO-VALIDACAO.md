# F5 — estudo da rotina de validação de nota

Levantamento **medido em produção em 2026-09-23**, depois da F4 no ar. Documento, não
código: nada foi alterado para produzi-lo.

Fecha o briefing `BRIEFING-AGENTE-00C.md` §F5.

---

## 1. O que a validação confere hoje

A FastAPI é **externa e não está neste repositório**. Recebe o XML + `id_empresa`
(+ `nexus`), acha sozinha o movimento aberto pelo CNPJ do prestador, e grava `nota_ok`
(URL do XML) ou `erro_validacao` na `EnvioMassa`. O backend só relê.

Os sete validadores, pelos códigos que ela grava (espelhados em
`frontend_motorista/app/(app)/movimento/page.tsx:62-70`):

| Código | O que confere |
|---|---|
| `valid_valor` | valor da nota × `EnvioMassa.valor` |
| `valid_cnpj_prestador` | CNPJ do emitente × `cnpj_prestador` |
| `valid_cnpj` | CNPJ do tomador × `cnpj_tomador` |
| `valid_dCompet` | data de competência |
| `valid_trib_nac` | tributação nacional × `tribnac` |
| `valid_trib_mun` | tributação municipal |
| `valid_descricao_servico` | descrição do serviço |

### Como isso se comporta na prática

Sobre 50.149 movimentos da empresa 6:

| | Quantidade |
|---|---|
| Com nota enviada | 37.096 |
| Sem nota | 13.053 |
| **Reprovações registradas** | **~520** |

E a distribuição das reprovações é desequilibrada:

| Erro | Ocorrências |
|---|---|
| **`valid_valor`** | **485 (≈93%)** |
| `valid_dCompet` | 11 |
| `valid_cnpj_prestador` | 7 |
| `valid_cnpj` | 7 |
| `valid_trib_nac` | 3 |
| combinações | ~7 |

**`valid_descricao_servico` e `valid_trib_mun` não aparecem nenhuma vez.** Ou não estão
ativos para esta empresa, ou nunca falharam — o estudo não consegue distinguir sem acesso
à FastAPI, e isso fica registrado como **incerteza**, não como conclusão.

Taxa de reprovação por valor: **1,04%** sem gorjeta e **0,69%** com gorjeta. Ou seja, a
presença de gorjeta no movimento **não** é hoje uma fonte de erro — quem tem gorjeta erra
até um pouco menos.

---

## 2. O que muda com a origem nova (F4)

A linha gerada pelo hub tem de ser indistinguível de uma linha da planilha. Comparando
campo a campo o que a planilha grava (`server.js#/upload`) com o que a F4 grava
(`lib/adiantamento-geracao-movimento.js`):

| Campo | Planilha | F4 | Efeito na validação |
|---|---|---|---|
| `valor` | coluna da planilha | **base da nota** (créditos − fora da nota) | muda o número que o motorista deve emitir |
| `gorjeta` | coluna da planilha | soma do que não entra na nota | não é validado |
| `cnpj_prestador` | planilha | `ContaMotorista` (hub) | igual |
| **`cnpj_tomador`** | planilha | **`req.body.cnpjTomador`, que a tela não envia → NULL** | ⚠️ **`valid_cnpj` reprova** |
| `tribnac` | planilha | não grava → **DEFAULT da coluna** | ✅ conferido: o default bate com o valor em uso |
| `dCompet` | não grava | não grava | igual (sempre NULL hoje, 979/979 dos abertos) |
| `number`, `nome` | planilha | `ContaMotorista` (hub) | não validado |
| `mensagem1/2` | planilha | molde configurável | não validado |
| `enviado` | `'off'` | `'off'` | igual |

### 2.1 ⚠️ DEFEITO ENCONTRADO: `cnpj_tomador` nasce nulo

**Este é o achado que muda o produto.** A rota lê `req.body.cnpjTomador`
(`routes/hub-adiantamentos.js:1718`), mas `gerarMovimentos()`
(`lib/hub/adiantamentos-api.ts:612`) envia só `{confirmacao: true}`. **Nenhum movimento
gerado pelo hub teria CNPJ do tomador** — e `valid_cnpj` reprovaria 100% deles.

Nos 50.149 movimentos reais o campo está sempre preenchido (`sem_tomador = 0`), então a
FastAPI de fato o compara.

Complica um pouco: há **duas formas** do mesmo CNPJ em uso —

| Forma | Movimentos | Período |
|---|---|---|
| `48904…0100` (só dígitos) | 25.084 | 2024-10-07 → 2025-10-21 |
| `48.90…1-00` (formatado) | 25.065 | 2025-10-27 → 2026-09-21 |

A forma **atual é a formatada**. Escolher a errada pode reprovar tudo, dependendo de como
a FastAPI normaliza — e isso **não dá para saber daqui**, porque ela é externa.

**Por que não foi pego antes:** só existe apuração fechada zero, então o botão nunca
gerou uma linha real. Os testes cobrem o planejamento (`planejarGeracao`), onde
`cnpjTomador` chega por parâmetro e é preenchido nos fixtures — a lacuna está na *ligação*
entre a tela e a rota, que nenhum teste unitário atravessa.

### 2.2 O que **não** muda

- **`valid_valor` continua funcionando igual** — só o número muda. O motorista passa a
  emitir pelo valor **sem a gorjeta**, que é exatamente o desenho pedido. O risco não é
  técnico, é de entendimento: o motorista que emitir pelo total produzido reprova. O card
  da home já mostra `VALOR DA NOTA FISCAL` separado de `GORJETA`, então a informação
  existe; o que muda é que agora ela vem do hub.
- **`tribnac`** é preenchido pelo DEFAULT da coluna, conferido igual ao valor em uso.
- **`dCompet`** não é gravado por ninguém hoje; os 11 erros vêm do XML do motorista, não
  do movimento.
- **Nada na FastAPI precisa mudar** para a F4 funcionar (decisão 3 do operador, mantida).

---

## 3. Opções, com risco

### ✅ RESOLVIDA — o tomador vem do CADASTRO da empresa (`Empresa.cnpj`)

**Decisão do operador, 2026-09-23**, que derrubou a recomendação original deste estudo:

> "quando o cnpj do motorista mudar por alguma razão, quem troca? onde edito? portanto o
> cnpj deve vir do campo cnpj do motorista e esse dado vive no hub"

O critério vale para os **dois** CNPJs do movimento, e é mais forte que o que eu havia
proposto: **dado sem lugar de edição é dado que ninguém mantém**.

| Campo | De onde vem agora | Onde se edita |
|---|---|---|
| `cnpj_prestador` (motorista) | `ContaMotorista.cnpj_prestador` | cadastro do motorista, no hub |
| `cnpj_tomador` (empresa) | **`Empresa.cnpj`** | cadastro da empresa, no hub |

Conferido em produção: `Empresa.cnpj` da empresa 6 **bate** com o `cnpj_tomador` do último
movimento, comparando só dígitos. O cadastro já é a fonte correta — não era preciso criar
campo nenhum.

Se `Empresa.cnpj` estiver vazio, a rota **recusa** com `EMPRESA_SEM_CNPJ` em vez de gerar:
sem o tomador a FastAPI reprova a nota inteira, e o motorista só descobriria ao tentar
emitir.

**As alternativas descartadas, e por quê:**

- *herdar do último movimento* (era a recomendação original): cria uma cópia sem dono.
  Quando o CNPJ mudar, não há onde trocar — o dado se propaga de movimento em movimento
  sem que ninguém decida.
- *campo novo na configuração de adiantamentos*: um segundo lugar guardando o mesmo CNPJ
  que `Empresa` já guarda, e portanto um segundo lugar para divergir.
- *enviar pela tela*: só empurra a pergunta — a tela teria de saber de onde tirar.

---

## 4. O que este estudo NÃO conseguiu determinar

Registrado como incerteza, não como conclusão:

1. **Como a FastAPI normaliza CNPJ** (se ignora pontuação). Determina se a forma do
   `cnpj_tomador` importa. **Só um teste com nota real responde.**
2. **Se `valid_descricao_servico` e `valid_trib_mun` estão ativos** para a empresa 6 —
   nunca apareceram em ~520 reprovações.
3. **O que a FastAPI faz com a gorjeta.** Ela compara o valor da nota com
   `EnvioMassa.valor`; se em algum caminho somasse `gorjeta`, a F4 quebraria. Os dados
   sugerem que não (movimentos com gorjeta reprovam *menos*), mas é inferência.

**O teste que resolve os três de uma vez:** gerar **um** movimento pelo hub para um
motorista real, pedir a emissão e acompanhar o `erro_validacao`. Um caso, não uma semana.

---

## 5. Recomendação de sequência

1. ~~Corrigir `cnpj_tomador`~~ — ✅ **feito**: vem de `Empresa.cnpj`, com recusa
   explícita se estiver vazio.
2. **Testar com um motorista só**, numa apuração fechada, antes de usar o botão em escala.
3. **Comunicar a mudança do valor** ao motorista: a nota passa a ser emitida sem a gorjeta.
   A tela já separa os números; o que falta é o aviso de que a origem mudou.
4. Só então usar a geração para a semana inteira.
