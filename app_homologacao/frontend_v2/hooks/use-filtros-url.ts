'use client';

// impeccable rodada 14 (h3=2) — filtro e página vivem na URL, para que voltar
// do detalhe devolva a lista como ela estava.
//
// Antes: `useState` local nas listas ("sem sync de URL — convenção observada
// na S4"). Quem filtrava por nome, ia à página 4, abria um motorista e clicava
// em "Voltar à lista" recebia a lista zerada — e `router.back()` não resolveria
// nada, porque o estado de um componente cliente não sobrevive à remontagem.
// Só a URL sobrevive.
//
// O estado local CONTINUA sendo a fonte da UI: digitar filtra na hora, e a URL
// é espelhada 300ms depois. Escrever na URL a cada tecla dispararia uma
// navegação por caractere. `replace` e não `push`: um "voltar" do navegador
// deve sair da lista, não desfazer letra por letra o que foi digitado.
//
// A leitura da URL acontece só na montagem — sem sincronização reversa, que
// criaria laço entre "URL muda → estado muda → URL muda".

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDebounce } from '@/hooks/use-debounce';

/** Nome do parâmetro de página. Evita colidir com um filtro chamado `page`. */
const PARAM_PAGINA = 'pagina';

// `Record<keyof T, string>` e não `Record<string, string>`: os tipos de filtro
// das telas são interfaces com uniões literais (`'' | 'true' | 'false'`), que
// não têm index signature. A restrição aqui exige apenas que todo campo seja
// string — que é o que a URL sabe carregar.
export function useFiltrosUrl<T extends Record<keyof T, string>>(iniciais: T) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [filtros, setFiltrosState] = useState<T>(() => {
    const lidos = { ...iniciais };
    for (const chave of Object.keys(iniciais)) {
      const valor = searchParams.get(chave);
      // Só chaves conhecidas: um parâmetro estranho na URL não vira filtro.
      if (valor !== null) lidos[chave as keyof T] = valor as T[keyof T];
    }
    return lidos;
  });

  const [page, setPage] = useState(() => {
    const bruto = Number(searchParams.get(PARAM_PAGINA));
    return Number.isInteger(bruto) && bruto > 0 ? bruto : 1;
  });

  const setFiltros = useCallback((partial: Partial<T>) => {
    setFiltrosState((prev) => ({ ...prev, ...partial }));
    setPage(1); // filtro novo, contagem nova: manter a página 4 mostraria vazio
  }, []);

  const limpar = useCallback(() => {
    setFiltrosState(iniciais);
    setPage(1);
  }, [iniciais]);

  // Dois `useDebounce` em vez de um sobre `{ filtros, page }`: aquele objeto
  // nasce novo a cada render, então o `useEffect` abaixo dispararia em TODO
  // render — e com o valor ainda não debounçado, isto é, escrevendo na URL o
  // filtro ANTERIOR a cada tecla. Pego pelo teste do hook, não por leitura.
  // `filtros` é estado: sua referência só muda quando o filtro muda de fato.
  const filtrosEspelho = useDebounce(filtros, 300);
  const pageEspelho = useDebounce(page, 300);
  useEffect(() => {
    const query = new URLSearchParams();
    for (const [chave, valor] of Object.entries<string>(filtrosEspelho)) {
      // Só o que difere do padrão entra na URL: filtro vazio na query seria
      // ruído no link que a pessoa copia.
      if (valor) query.set(chave, valor);
    }
    if (pageEspelho > 1) query.set(PARAM_PAGINA, String(pageEspelho));
    const qs = query.toString();
    // Escreve só quando há diferença de verdade. Uma guarda de "primeiro
    // render" por `useRef` parecia equivalente e não é: sob StrictMode (dev) e
    // no ambiente de teste o efeito monta duas vezes, a flag já vem consumida
    // na segunda e a URL levava um `replace` com o estado inicial. Comparar o
    // resultado com a URL corrente é idempotente por construção — foi o teste
    // deste hook que mostrou a diferença.
    if (qs === searchParams.toString()) return;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filtrosEspelho, pageEspelho, pathname, router, searchParams]);

  return { filtros, page, setFiltros, setPage, limpar };
}
