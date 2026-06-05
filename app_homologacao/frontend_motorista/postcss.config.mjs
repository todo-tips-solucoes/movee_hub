/**
 * PostCSS — registra o plugin do Tailwind v4 (@tailwindcss/postcss).
 * Sem este arquivo, o `@import "tailwindcss"` não gera NENHUMA classe
 * utilitária (apenas o CSS custom de globals.css passa), deixando o app
 * sem layout/espaçamento/cores utilitárias.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
