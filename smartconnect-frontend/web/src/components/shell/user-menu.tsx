import { Avatar, AvatarFallback } from '@smartconnect/ui/components/avatar';
import { Button } from '@smartconnect/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@smartconnect/ui/components/dropdown-menu';
import { Link } from '@tanstack/react-router';
import { LogOut, UserCog } from 'lucide-react';
import { initials } from '@/components/people-list';
import { useAuthStore, useUser } from '@/lib/auth';

/** Signed-in account: who you are and how to sign out. Navigation after sign-out is handled by the shell. */
export function UserMenu() {
  const user = useUser();
  const auth = useAuthStore();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Account menu: ${user.displayName}`}>
          <Avatar className="size-7">
            <AvatarFallback>{initials(user.displayName) || '?'}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-sm text-foreground">{user.displayName}</DropdownMenuLabel>
        <DropdownMenuLabel className="pt-0 font-normal">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account/sessions">
            <UserCog aria-hidden="true" />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void auth.logout()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
