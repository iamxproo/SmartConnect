import { Button } from '@smartconnect/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@smartconnect/ui/components/dropdown-menu';
import { Bell, BellOff, BellRing, type LucideIcon } from 'lucide-react';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import {
  levelAt,
  useNotificationPreferences,
  useSetNotificationLevel,
  type ActivityLocation,
  type NotificationLevel,
} from '@/lib/queries/activity';
import { useRequiredOrg } from '@/lib/queries/orgs';

const options: { value: NotificationLevel; label: string; icon: LucideIcon }[] = [
  { value: 'all', label: 'All', icon: Bell },
  { value: 'mentions', label: 'Mentions', icon: BellRing },
  { value: 'none', label: 'Off', icon: BellOff },
];

const isLevel = (value: string): value is NotificationLevel => options.some((option) => option.value === value);

/** "Notifications: All / Mentions / Off" for one channel or conversation. */
export function NotificationLevelMenu({ location }: { location: ActivityLocation }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const prefs = useNotificationPreferences(org.id);
  const set = useSetNotificationLevel(org.id, location);
  const current = options.find((option) => option.value === levelAt(prefs.data, location)) ?? options[0]!;
  const Icon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Icon aria-hidden="true" />
          Notifications: {current.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Notify me about</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.value}
          onValueChange={(value) => {
            if (!isLevel(value)) return;
            set.mutate(value, {
              onError: (error) =>
                toast({ title: "Couldn't change notifications", description: describeError(error), tone: 'error' }),
            });
          }}
        >
          {options.map(({ value, label, icon: OptionIcon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <OptionIcon aria-hidden="true" />
              {value === 'all' ? 'All activity' : value === 'mentions' ? 'Mentions only' : 'Off'}
              <span className="sr-only"> ({label})</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
