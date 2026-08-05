'use client';

// hub-uiux-refresh (feedback do operador, 2026-08-05) — rota
// `/hub/dashboard/validacao_xml`: a validação de XML NFSe deixa de ser uma
// seção embutida em `/hub/dashboard/envio_massa` e vira módulo próprio do
// menu (migration 0045 cria o módulo `validacao_xml`; a rota resolve pela
// convenção pura de `moduloParaRota`, sem mudança no shell).
//
// Mesmo contrato da tela de origem (hub-envio-massa FASE 5): guard de
// entidade ativa idêntico (sem `entidade_ativa` → `/selecionar-entidade`) e
// reuso 100% do `XmlValidationCard` legado — nenhuma chamada de rede nova; o
// backend `/validate-xml-batch` continua gateado por `envio_massa.enviar`.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { XmlValidationCard } from '@/components/xml-validation-card';
import { PageHeader } from '@/components/hub/page-header';

export const SELECIONAR_ENTIDADE_ROUTE = '/selecionar-entidade';

export default function ValidacaoXmlHubPage() {
  const { entidadeAtiva, carregando: carregandoAuth } = useHubAuth();
  const router = useRouter();

  useEffect(() => {
    if (!carregandoAuth && entidadeAtiva === null) {
      router.replace(SELECIONAR_ENTIDADE_ROUTE);
    }
  }, [carregandoAuth, entidadeAtiva, router]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        titulo="Validação XML"
        subtitulo="Valide arquivos XML de NFSe em lote contra os movimentos abertos."
      />
      <XmlValidationCard />
    </div>
  );
}
