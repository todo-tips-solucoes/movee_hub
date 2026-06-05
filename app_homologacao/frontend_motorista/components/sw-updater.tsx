'use client';

import { useEffect } from 'react';

/**
 * Garante que uma nova versão do app (novo service worker) seja aplicada sem
 * o usuário precisar limpar cache manualmente:
 * - força `registration.update()` ao montar e sempre que o app volta ao foco;
 * - ao detectar que um SW novo assumiu o controle (`controllerchange`),
 *   recarrega a página uma única vez para buscar os assets atualizados.
 *
 * Não recarrega na primeira instalação (quando ainda não havia controller),
 * evitando reload desnecessário no primeiro acesso.
 */
export function SwUpdater() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    let reloading = false;
    const hadController = !!sw.controller;

    const onControllerChange = () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    };

    const checkForUpdate = () => {
      sw.getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {
          /* sem registro ainda — ignora */
        });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };

    sw.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibility);
    checkForUpdate();

    return () => {
      sw.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return null;
}
