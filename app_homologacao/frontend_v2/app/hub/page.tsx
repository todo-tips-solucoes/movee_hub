// `/hub` puro não tinha rota (só `/hub/login` e `/hub/dashboard/*`), então caía
// no 404 do Next. Quem não está autenticado é devolvido ao login pelo
// `HubSessionGuard` do layout — este redirect não precisa saber de sessão.
import { redirect } from 'next/navigation';

export default function HubIndex() {
  redirect('/hub/dashboard');
}
