'use client';

// impeccable rodada 4 — h6 "Reconhecimento > memória" (3/4 no registro da
// rodada 3: "auditoria ainda pede ID do usuário responsável à mão"). Mesmo
// tratamento que o `EntidadeCombobox` recebeu na rodada 3, agora para o
// filtro de pessoa da auditoria e das importações.
//
// Por que NÃO reusa o `EntregadorCombobox`: aquele resolve um problema maior
// (milhares de entregadores → busca server-side com debounce e descarte de
// resposta fora de ordem). Os usuários de UMA entidade são dezenas: cabem
// numa carga só, e filtrar no cliente dispensa todo o maquinário de corrida.
// Reusar a máquina do problema difícil no problema fácil sairia mais caro de
// ler do que estas linhas.
//
// Degradação (o ponto que decidiu o desenho): `GET /usuarios` exige
// `usuarios.gerenciar`. Na auditoria isso está garantido (tela de
// admin_entidade), mas em IMPORTAÇÕES não — o papel `operador` tem o módulo
// e não tem a permissão. Em vez de o chamador ter que saber disso, o próprio
// componente detecta o 403 e vira um campo de ID numérico, com o mesmo
// contrato de `value`/`onChange`. Os dois chamadores ficam idênticos.

import { useCallback, useState } from 'react';
import { ChevronsUpDown, Loader2, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
// Casa a classe BASE (`HubApiError`), não a subclasse `UsuariosApiError`: o
// que decide a degradação é "a API respondeu 403", não qual módulo a lançou.
// Depender da subclasse acoplaria este componente à identidade do erro de um
// cliente específico — e falharia silenciosamente (sem degradar) se a rota
// passasse a ser servida por outro cliente de API.
import { HubApiError } from '@/lib/hub/api';
import { listarUsuarios } from '@/lib/hub/usuarios-api';
import type { UsuarioListItem } from '@/lib/hub/usuarios-dto';
import { cn } from '@/lib/utils';

/** Uma entidade não tem milhares de operadores; 100 cobre o caso real com
 * folga e mantém a carga em uma requisição só. */
const LIMITE = 100;

export interface UsuarioComboboxProps {
  id?: string;
  /** ID do usuário selecionado como string (o formato que os filtros já
   * usam); string vazia = nenhum filtro. */
  value: string;
  onChange: (valorId: string) => void;
  'aria-labelledby'?: string;
  ariaLabel?: string;
  className?: string;
}

export function UsuarioCombobox({
  id,
  value,
  onChange,
  ariaLabel = 'Filtrar por usuário responsável',
  className,
  ...aria
}: UsuarioComboboxProps) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([]);
  const [carregando, setCarregando] = useState(false);
  // `semPermissao` é o gatilho da degradação — uma vez negado, não insiste.
  const [semPermissao, setSemPermissao] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await listarUsuarios({ page: 1, pageSize: LIMITE });
      setUsuarios(r.usuarios);
    } catch (e) {
      if (e instanceof HubApiError && e.status === 403) {
        setSemPermissao(true);
      } else {
        setErro('Não foi possível carregar a lista. Digite o ID do usuário.');
      }
    } finally {
      setCarregando(false);
    }
  }, []);

  // Carrega na PRIMEIRA abertura (evento, não efeito de montagem): a tela não
  // paga a requisição de quem nunca abre este filtro.
  const aoAbrirFechar = (v: boolean) => {
    setAberto(v);
    if (v && usuarios.length === 0 && !semPermissao && !carregando) carregar();
  };

  // Degradação: sem permissão de listar, o filtro continua funcionando pelo
  // ID cru — que é exatamente o que existia antes desta rodada.
  if (semPermissao) {
    return (
      <Input
        id={id}
        type="number"
        min={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex.: 17"
        aria-label={aria['aria-labelledby'] ? undefined : ariaLabel}
        aria-labelledby={aria['aria-labelledby']}
        className={cn('h-11 sm:h-9', className)}
      />
    );
  }

  const termo = busca.trim().toLowerCase();
  const filtrados = usuarios.filter(
    (u) =>
      !termo ||
      u.nome.toLowerCase().includes(termo) ||
      u.email.toLowerCase().includes(termo) ||
      String(u.id).includes(termo),
  );
  const selecionado = usuarios.find((u) => String(u.id) === value) ?? null;

  const selecionar = (valorId: string) => {
    onChange(valorId);
    setAberto(false);
    setBusca('');
  };

  return (
    <Popover open={aberto} onOpenChange={aoAbrirFechar}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={aberto}
            aria-label={aria['aria-labelledby'] ? undefined : ariaLabel}
            aria-labelledby={aria['aria-labelledby']}
            className={cn('min-h-11 w-full justify-between gap-1.5 sm:min-h-9', className)}
          />
        }
      >
        <span className="flex items-center gap-1.5 truncate">
          <User className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">
            {/* Com a lista ainda não carregada, um valor vindo de fora (ex.:
                link compartilhado) aparece como "#17" em vez de sumir. */}
            {value ? (selecionado ? selecionado.nome : `#${value}`) : 'Todos os usuários'}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command onInputValueChange={(q: string) => setBusca(q)}>
          <CommandInput placeholder="Busque por nome, e-mail ou ID..." aria-label={ariaLabel} />
          <CommandList>
            {carregando && (
              <div role="status" className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                Carregando usuários...
              </div>
            )}
            {!carregando && erro && (
              <p role="alert" className="px-3 py-3 text-sm text-destructive">
                {erro}
              </p>
            )}
            {!carregando && !erro && (
              <>
                {value && (
                  <CommandItem value="todos" onClick={() => selecionar('')} className="cursor-pointer">
                    <X className="mr-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    Todos os usuários
                  </CommandItem>
                )}
                {filtrados.length === 0 && <CommandEmpty>Nenhum usuário encontrado.</CommandEmpty>}
                {filtrados.map((u) => (
                  <CommandItem
                    key={u.id}
                    value={`usuario-${u.id}`}
                    aria-selected={String(u.id) === value}
                    onClick={() => selecionar(String(u.id))}
                    className={cn('cursor-pointer', String(u.id) === value && 'bg-accent/20')}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{u.nome}</span>
                      {/* O e-mail é o que distingue dois homônimos — sem ele o
                          combobox só troca um número por um nome ambíguo. */}
                      <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">#{u.id}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
