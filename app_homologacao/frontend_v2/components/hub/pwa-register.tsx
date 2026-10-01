'use client';

import { useEffect } from 'react';

/**
 * Registra `/sw.js` — a metade do PWA que precisa rodar no cliente. Sem um
 * service worker com fetch handler o Chrome Android recusa instalar o app
 * ("Não é possível instalar o app"), mesmo com manifest válido.
 *
 * Montado só na subárvore `/hub/*`: quem usa apenas o painel legado nunca
 * registra nada. O escopo do SW é `/` (o arquivo está na raiz), então basta
 * visitar o hub uma vez para o app ficar instalável.
 *
 * Falha de registro é silenciosa de propósito: o produto funciona sem SW (ele
 * não cacheia nada — ver `public/sw.js`), e um erro aqui não deve virar ruído
 * para quem só quer trabalhar.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);

  return null;
}
