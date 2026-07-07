import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Desmonta o DOM renderizado entre testes (evita `data-testid` duplicado
// quando múltiplos `render()` acontecem no mesmo arquivo — vitest não faz
// isso automaticamente como o jest-environment-jsdom + testing-library/jest).
afterEach(() => {
  cleanup();
});
