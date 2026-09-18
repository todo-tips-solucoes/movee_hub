'use client';

/**
 * adiantamento-motorista — app/(app)/conta-bancaria/alterar/page.tsx (tasks.md 6.4.1)
 *
 * Formulário de cadastro/atualização de conta bancária (protótipo M13).
 * Sempre parte em branco (nunca prefila com dado mascarado da conta atual —
 * `documentoMascarado`/`contaMascarada` não podem virar valor editável sem
 * fabricar dígitos que o servidor nunca revelou, Constitution VI).
 *
 * Validação local por `lib/conta-bancaria-form.ts` (mesma bateria de formatos
 * do backend) ANTES de enviar — o banco é validado contra a lista AO VIVO de
 * `buscarBancos()` (busca com debounce), nunca um fixture local (CHK018).
 * O backend valida de novo; é a fonte de verdade.
 *
 * Ref: prototipo M13; Spec US2, §FR-015/FR-016; security CHK018.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ThemeToggle } from '@/components/theme-toggle';
import { buscarBancos, solicitarContaBancaria, type Banco } from '@/lib/adiantamento-api';
import { traduzirErroAdiantamento } from '@/lib/erros-adiantamento';
import {
  validarFormularioContaBancaria, type DadosFormularioContaBancaria, type TipoChavePix,
} from '@/lib/conta-bancaria-form';
import { ArrowLeft } from '@/components/ui/icons';

const MENSAGEM_CAMPO: Record<string, string> = {
  titularNome: 'Informe o nome ou razão social do titular (até 120 caracteres).',
  titularDocumento: 'CPF ou CNPJ inválido.',
  bancoCodigo: 'Escolha um banco da lista.',
  agencia: 'Agência inválida — use só números (até 4 dígitos).',
  conta: 'Conta inválida — use só números (até 20 dígitos).',
  contaDigito: 'Dígito da conta inválido — um único número.',
  tipoConta: 'Escolha o tipo de conta.',
  chavePix: 'Chave PIX inválida para o tipo escolhido.',
  emailComprovante: 'E-mail inválido.',
};

const ROTULO_CHAVE_PIX: Record<TipoChavePix, string> = {
  CPF: 'CPF', CNPJ: 'CNPJ', EMAIL: 'E-mail', TELEFONE: 'Telefone', ALEATORIA: 'Aleatória',
};

export default function AlterarContaBancariaPage() {
  const router = useRouter();
  const [titularNome, setTitularNome] = useState('');
  const [titularDocumento, setTitularDocumento] = useState('');
  const [buscaBanco, setBuscaBanco] = useState('');
  const [bancos, setBancos] = useState<Banco[]>([]);
  const [bancoCodigo, setBancoCodigo] = useState('');
  const [agencia, setAgencia] = useState('');
  const [conta, setConta] = useState('');
  const [contaDigito, setContaDigito] = useState('');
  const [tipoConta, setTipoConta] = useState<'CORRENTE' | 'POUPANCA'>('CORRENTE');
  const [chavePixTipo, setChavePixTipo] = useState<TipoChavePix | ''>('');
  const [chavePix, setChavePix] = useState('');
  const [emailComprovante, setEmailComprovante] = useState('');
  const [erroCampo, setErroCampo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lista AO VIVO de bancos — carregada ao montar e a cada busca (debounce
  // 300ms), nunca um fixture próprio no app (CHK018).
  useEffect(() => {
    buscarBancos('').then((r) => setBancos(r.itens)).catch(() => setBancos([]));
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      buscarBancos(buscaBanco).then((r) => setBancos(r.itens)).catch(() => {});
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [buscaBanco]);

  const dados: DadosFormularioContaBancaria = useMemo(() => ({
    titularNome, titularDocumento, bancoCodigo, agencia, conta, contaDigito, tipoConta,
    chavePixTipo: chavePixTipo || undefined,
    chavePix: chavePix || undefined,
    emailComprovante: emailComprovante || undefined,
  }), [titularNome, titularDocumento, bancoCodigo, agencia, conta, contaDigito, tipoConta, chavePixTipo, chavePix, emailComprovante]);

  async function enviar() {
    const validacao = validarFormularioContaBancaria(dados, bancos);
    if (!validacao.valido) {
      setErroCampo(validacao.motivo);
      toast.error(MENSAGEM_CAMPO[validacao.motivo] || 'Alguns dados informados são inválidos.');
      return;
    }
    setErroCampo(null);
    setEnviando(true);
    try {
      await solicitarContaBancaria({
        titularNome, titularDocumento, bancoCodigo, agencia, conta, contaDigito, tipoConta,
        chavePixTipo: chavePixTipo || undefined,
        chavePix: chavePixTipo ? chavePix : undefined,
        emailComprovante: emailComprovante || undefined,
      });
      toast.success('Enviado para análise do financeiro.');
      router.push('/conta-bancaria');
    } catch (err) {
      const { mensagem, motivo } = traduzirErroAdiantamento(err);
      setErroCampo(motivo && MENSAGEM_CAMPO[motivo] ? motivo : null);
      toast.error(mensagem);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/conta-bancaria"
            aria-label="Voltar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">Alterar dados bancários</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-24 pt-5">
        <div className="space-y-1.5">
          <Label htmlFor="f-nome">Nome ou razão social do titular</Label>
          <Input
            id="f-nome" value={titularNome} onChange={(e) => setTitularNome(e.target.value)}
            aria-invalid={erroCampo === 'titularNome'}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="f-doc">CPF ou CNPJ do titular</Label>
          <Input
            id="f-doc" inputMode="numeric" value={titularDocumento}
            onChange={(e) => setTitularDocumento(e.target.value)}
            aria-invalid={erroCampo === 'titularDocumento'}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="f-banco-busca">Banco</Label>
          <Input
            id="f-banco-busca" placeholder="Buscar por código ou nome" value={buscaBanco}
            onChange={(e) => setBuscaBanco(e.target.value)}
          />
          <select
            id="f-banco" value={bancoCodigo} onChange={(e) => setBancoCodigo(e.target.value)}
            aria-invalid={erroCampo === 'bancoCodigo'}
            aria-label="Banco"
            className="flex h-12 w-full rounded-lg border border-input bg-background px-3.5 text-base text-foreground shadow-sm aria-[invalid=true]:border-destructive"
          >
            <option value="">Selecione…</option>
            {bancos.map((b) => (
              <option key={b.codigo} value={b.codigo}>{b.codigo} · {b.nome}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="f-ag">Agência</Label>
            <Input
              id="f-ag" inputMode="numeric" value={agencia} onChange={(e) => setAgencia(e.target.value)}
              aria-invalid={erroCampo === 'agencia'}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-cc">Conta</Label>
            <Input
              id="f-cc" inputMode="numeric" value={conta} onChange={(e) => setConta(e.target.value)}
              aria-invalid={erroCampo === 'conta'}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-dv">Dígito</Label>
            <Input
              id="f-dv" inputMode="numeric" maxLength={1} value={contaDigito}
              onChange={(e) => setContaDigito(e.target.value)}
              aria-invalid={erroCampo === 'contaDigito'}
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">Sem o dígito da agência. Zeros à esquerda são mantidos.</p>

        <div className="space-y-1.5">
          <Label>Tipo de conta</Label>
          <div role="radiogroup" aria-label="Tipo de conta" className="flex gap-2">
            {(['CORRENTE', 'POUPANCA'] as const).map((tp) => (
              <label
                key={tp}
                className={`flex-1 rounded-lg border px-3 py-2.5 text-center text-sm font-medium ${tipoConta === tp ? 'border-primary bg-primary/5 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]' : 'border-input'}`}
              >
                <input type="radio" name="tp" className="sr-only" checked={tipoConta === tp} onChange={() => setTipoConta(tp)} />
                {tp === 'CORRENTE' ? 'Corrente' : 'Poupança'}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="f-pt">Tipo de chave PIX (opcional)</Label>
            <select
              id="f-pt" value={chavePixTipo} onChange={(e) => setChavePixTipo(e.target.value as TipoChavePix | '')}
              className="flex h-12 w-full rounded-lg border border-input bg-background px-3.5 text-base text-foreground shadow-sm"
            >
              <option value="">Nenhuma</option>
              {(Object.keys(ROTULO_CHAVE_PIX) as TipoChavePix[]).map((tp) => (
                <option key={tp} value={tp}>{ROTULO_CHAVE_PIX[tp]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-px">Chave PIX</Label>
            <Input
              id="f-px" value={chavePix} onChange={(e) => setChavePix(e.target.value)}
              disabled={!chavePixTipo} aria-invalid={erroCampo === 'chavePix'}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="f-em">E-mail para comprovante (opcional)</Label>
          <Input
            id="f-em" type="email" value={emailComprovante} onChange={(e) => setEmailComprovante(e.target.value)}
            aria-invalid={erroCampo === 'emailComprovante'}
          />
          <p className="text-xs text-muted-foreground">Se preenchido, o banco envia o comprovante para este e-mail.</p>
        </div>

        <Button className="w-full" size="lg" onClick={enviar} disabled={enviando}>
          {enviando ? 'Enviando…' : 'Enviar para análise'}
        </Button>
      </div>
    </main>
  );
}
