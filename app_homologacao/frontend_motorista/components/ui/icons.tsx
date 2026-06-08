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
