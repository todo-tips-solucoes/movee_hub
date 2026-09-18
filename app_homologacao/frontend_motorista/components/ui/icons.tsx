import { cn } from '@/lib/utils';

/**
 * Ícones do app via Google Material Symbols Rounded (Guia de Marca EntreGô 2.0:
 * weight 500, optical 40, fill 0/outline). A fonte é carregada por <link> no
 * layout. Mantém os mesmos NOMES de export por compatibilidade com os
 * consumidores; o tamanho vem das classes h-* (mapeadas p/ font-size no
 * globals.css) e a cor segue currentColor.
 */
type IconProps = React.HTMLAttributes<HTMLSpanElement>;

function makeIcon(glyph: string) {
  const IconCmp = ({ className, ...props }: IconProps) => (
    <span
      className={cn('material-symbols-rounded shrink-0', className)}
      aria-hidden="true"
      translate="no"
      {...props}
    >
      {glyph}
    </span>
  );
  IconCmp.displayName = `Icon(${glyph})`;
  return IconCmp;
}

export const ArrowLeft = makeIcon('arrow_back');
export const ArrowUpRight = makeIcon('arrow_outward');
export const LogOut = makeIcon('logout');
export const RefreshCw = makeIcon('refresh');
export const Check = makeIcon('check');
export const CheckCircle = makeIcon('check_circle');
export const AlertTriangle = makeIcon('warning');
export const AlertCircle = makeIcon('error');
export const FileText = makeIcon('description');
export const UploadCloud = makeIcon('cloud_upload');
export const Calendar = makeIcon('calendar_today');
export const ShieldCheck = makeIcon('verified');
export const Sun = makeIcon('light_mode');
export const Moon = makeIcon('dark_mode');
export const Lock = makeIcon('lock');
export const Inbox = makeIcon('inbox');
export const MapPin = makeIcon('location_on');
export const Mail = makeIcon('mail');
export const Info = makeIcon('info');
export const Copy = makeIcon('content_copy');
export const Bell = makeIcon('notifications');
export const BellOff = makeIcon('notifications_off');
export const BellRing = makeIcon('notifications_active');
export const Smartphone = makeIcon('smartphone');
// adiantamento-motorista (tasks.md 6.2.1) — navegação inferior (prototipo M01).
export const Home = makeIcon('home');
export const Payments = makeIcon('payments');
export const Wallet = makeIcon('account_balance');
// adiantamento-motorista (tasks.md 6.3) — pills de status (prototipo ST/HST) e
// telas de solicitação/detalhe/regras (M03-M11, M15).
export const Schedule = makeIcon('schedule');
export const HourglassTop = makeIcon('hourglass_top');
export const TaskAlt = makeIcon('task_alt');
export const Inventory2 = makeIcon('inventory_2');
export const Sync = makeIcon('sync');
export const Paid = makeIcon('paid');
export const Block = makeIcon('block');
export const RemoveCircle = makeIcon('remove_circle');
export const Close = makeIcon('close');
export const EventBusy = makeIcon('event_busy');
export const EventAvailable = makeIcon('event_available');
export const TimerOff = makeIcon('timer_off');
export const Help = makeIcon('help');
export const EventRepeat = makeIcon('event_repeat');
// adiantamento-motorista (tasks.md 6.4-6.5) — conta bancária (M12-M14) e
// central de notificações (M02).
export const Edit = makeIcon('edit');
export const DoneAll = makeIcon('done_all');
export const Rule = makeIcon('rule');
