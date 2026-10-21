# Project Briefing: importar o retorno da Transfeera em XLSX

> Briefing da frente corrente. As duas anteriores desta sessão estão em produção
> (correção de valor do movimento, PR #287; busca de banco no app, PR #289) e os planos
> em `docs/plans/`. Detalhe desta frente, com as medições, em
> `docs/plans/retorno-transfeera-xlsx/BRIEFING.md`.

## 1. Visão e Propósito

O financeiro importa o retorno da Transfeera para confirmar quais pagamentos foram
efetivados — vale para **repasse** e **adiantamento**. Hoje o importador aceita **só CSV
de 23 colunas**, e a Transfeera passou a entregar o retorno em **XLSX de 21 colunas**.

Pedido do operador (21/10): *"o arquivo de retorno será com esse layout. Hoje está
pedindo o csv."*

Sem isso, o financeiro não tem como dar baixa nos pagamentos: a tela recusa o arquivo que
a Transfeera fornece. Medido na rota em produção: `express.text({ type: ['text/csv',
'text/plain'] })` — um XLSX chega com mime binário, **não casa o `type`**, e o corpo chega
**vazio**, produzindo erro sem relação com a causa.

## 2. Usuários e Stakeholders

| Quem | Como usa |
|---|---|
| **Financeiro** (Movee Hub) | baixa o retorno na Transfeera e importa pela tela, para confirmar pagamento. Precisa de `adiantamentos.pagamento_confirmar`. |
| **Motorista** | é o efeito final: pagamento confirmado (ou devolvido, com o motivo) depende desta importação. |

## 3. Escopo

### MVP (Essencial)

1. **Ler XLSX de 21 colunas** no lugar do CSV, com o cabeçalho conferido contra contrato.
2. **Casar por `ID integração`** (coluna F) → `ADV-000123`/`REP-000123`, com o mesmo
   `extrairIdSolicitacao` de hoje. **Determinístico, nada de heurística.**
3. **Vale para repasse E adiantamento** (mesmo importador, prefixos `REP`/`ADV`).
4. **Recusar status desconhecido em voz alta**, nomeando o valor encontrado.

### Fora de Escopo

- Inventar o rótulo de devolução (ver §5).
- Casar por CPF+valor+lote: desnecessário, agora que o ID volta.
- Mudar o cálculo do que é confirmado, ou a tela além do necessário.

## 4. Prioridades e Trade-offs

**Decisão do operador (21/10): substituir o CSV, aceitar só XLSX.** Essa decisão era
condicional ao ID de integração voltar — e voltou (§5), então deixa de ser arriscada: o
casamento permanece tão seguro quanto o de hoje.

Trade-off aceito: quem exportar CSV passa a receber recusa. O operador optou por um
caminho só, em vez de manter dois formatos.

## 5. Restrições

### O que foi medido, e muda o escopo

- O layout real é o de **21 colunas** (`Valor · Favorecido · Comprovante Transfeera ·
  Comprovante Banco · Status · ID integração · Motivo · CPF ou CNPJ · Email · Banco ·
  Agência · Conta · Dígito da conta · Tipo de Conta · Nome do lote · Data transferido ·
  Banco de saída · Data de agendamento · Tentativas de pagamento · Tipo da chave PIX ·
  Chave PIX`), com **cabeçalho na linha 1**.
- A coluna **F (`ID integração`) traz o nosso `ADV-xxx`** quando o arquivo enviado está
  correto. O texto livre da amostra veio de a coluna J do arquivo de **envio** ter sido
  sobrescrita à mão — medido: **idêntica à coluna L (`Descrição Pix`) em 58 de 58
  linhas**. A Transfeera devolve o que recebeu.
- ⚠️ **O rótulo de DEVOLUÇÃO é desconhecido.** A amostra tem `FINALIZADO` em 58 de 58. O
  CSV usa `Finalizada`/`Devolvida`. **Não inventar**: cobrir `FINALIZADO` e **recusar**
  qualquer outro, nomeando-o. Quando a primeira devolução real aparecer, o enum cresce
  numa linha.
- ⚠️ **`express.text` não serve** — XLSX é binário. Precisa de `express.raw` com os mimes
  de XLSX. ⚠️ E **nunca** subir o `express.json()` global (100 KB, roda antes do router):
  o parser vai **na própria rota**, como o atual já faz.
- ⚠️ **`paraCentavos('1.234,56')` devolve `NaN`** — separador de milhar em formato BR
  quebra. A amostra não tem valor acima de mil, mas vai haver. O XLSX traz valor com
  vírgula decimal (`54,57`).
- O motivo da devolução é **literal do arquivo**, nunca fabricado (hoje: `Motivo da
  falha`, caindo para `Código de erro`; no XLSX existe só `Motivo`).

### Técnicas

- `xlsx` **já é dependência** do backend (o exportador a usa) — nada a instalar.
- Fixture de teste **no repo**: `tests/fixtures/retorno-transfeera-21col-exemplo.xlsx`
  (21 colunas, 58 linhas, coluna F de `ADV-000015` a `ADV-000074`). Não depender de
  `/root`.
- A deduplicação de linhas repetidas do mesmo ID (hoje `dedupePorId`) precisa de
  equivalente, ou de decisão explícita de que não se aplica.
- Backend roda `node --test`; o `npm test` **lista os arquivos um a um** — teste novo que
  não entre no script **não roda**.

## 6. Stack Técnica

- **Backend** Express/Node 20. Parser atual: `lib/adiantamento-retorno-transfeera.js`
  (`CABECALHO_ESPERADO` de 23 colunas, `lerCsv`, `extrairIdSolicitacao`,
  `casarComItensDoLote`). Rota: `routes/hub-adiantamentos.js:1471`
  (`POST /lotes/:id/retorno`).
- **Frontend_v2** (hub): a tela que envia o arquivo.
- Persistência por **PostgREST**, sem ORM.

## 7. Qualidade e Padrões

- **Deduplicação**: reusar `extrairIdSolicitacao`, `casarComItensDoLote`, `dedupePorId` e
  `paraCentavos`. **Procurar antes de escrever** — este repositório já teve o mesmo mapa
  duplicado 3×. O leitor de XLSX é a única peça realmente nova.
- **Controle negativo obrigatório**: a fixture XLSX deve **falhar** contra o parser atual
  (que só lê CSV) e passar depois. Dizer **quais** testes falham, nome por nome.
- **Segurança**: o arquivo vem de fora. Conferir cabeçalho por contrato, limitar tamanho e
  número de linhas (hoje `MAX_LINHAS_RETORNO = 10000`), e não confiar em tipo de célula.
- **Smoke agêntico em laço** (regra do operador): o portão roda antes do merge; reprovado
  ⇒ ajusta, roda a suíte **completa** de novo e repete do zero. Só com tudo verde promove.
- Gates com números: `node --test` do backend (baseline atual **1956 pass / 0 fail**),
  `package-lock.json` sem diff. Se tocar o hub: `tsc`, `vitest`, `next build`, lint contra
  a baseline (28 problemas: 5 erros, 23 avisos).

## 8. Visão de Futuro

Se a Transfeera mudar o layout outra vez, o contrato de cabeçalho já falha alto e
nomeia a divergência — o custo de adaptar fica em um lugar só.

## Itens a Definir

Nenhum que bloqueie. O único desconhecido é o **rótulo de devolução no XLSX**, e a
decisão sobre ele já está tomada: **recusar status desconhecido nomeando-o**, em vez de
adivinhar. Quando a primeira devolução real chegar, o operador envia a amostra.
