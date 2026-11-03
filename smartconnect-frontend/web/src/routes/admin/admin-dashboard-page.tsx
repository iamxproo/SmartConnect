import { Badge } from '@smartconnect/ui/components/badge';
import { Building2 } from 'lucide-react';
import { Card } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import type { AdminAccountSummary, AdminOrganization } from '@/lib/api/types';
import { useAdminAccountSummary, useAdminOrganizations } from '@/lib/queries/admin';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** The Super Admin dashboard (ADR 0015): read-only platform totals and the organization directory. */
export function AdminDashboardPage() {
  const accounts = useAdminAccountSummary();
  const organizations = useAdminOrganizations();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Platform administration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only overview. Organization content stays private to each organization&rsquo;s members.
        </p>
      </div>
      <section aria-labelledby="accounts-heading" className="flex flex-col gap-3">
        <h2 id="accounts-heading" className="font-medium">
          Accounts
        </h2>
        <QueryState query={accounts} label="account totals">
          {(summary) => <AccountTiles summary={summary} />}
        </QueryState>
      </section>
      <section aria-labelledby="organizations-heading" className="flex flex-col gap-3">
        <h2 id="organizations-heading" className="font-medium">
          Organizations
        </h2>
        <QueryState query={organizations} label="organizations">
          {(page) => <OrganizationTable organizations={page.data} total={page.total} />}
        </QueryState>
      </section>
    </div>
  );
}

function AccountTiles({ summary }: { summary: AdminAccountSummary }) {
  const tiles = [
    ['Accounts', summary.total],
    ['Verified email', summary.verified],
    ['Suspended or deactivated', summary.suspended + summary.deactivated],
    ['Super Admins', summary.superAdmins],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map(([label, value]) => (
        <Card key={label}>
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
        </Card>
      ))}
    </dl>
  );
}

function OrganizationTable({ organizations, total }: { organizations: AdminOrganization[]; total: number }) {
  if (organizations.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No organizations yet"
        description="Organizations appear here once they are created."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {organizations.length < total ? `The newest ${organizations.length} of ${total}.` : `${total} in total.`}
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-subtle text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Address
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Members
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {organizations.map((org) => (
              <tr key={org.id} className="border-t border-border">
                <th scope="row" className="px-3 py-2 font-medium">
                  {org.name}
                </th>
                <td className="px-3 py-2 font-mono text-xs">{org.slug}</td>
                <td className="px-3 py-2 text-right tabular-nums">{org.memberCount}</td>
                <td className="px-3 py-2">
                  <Badge>{org.status === 'active' ? 'Active' : 'Suspended'}</Badge>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{dateFormat.format(new Date(org.createdAt))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
