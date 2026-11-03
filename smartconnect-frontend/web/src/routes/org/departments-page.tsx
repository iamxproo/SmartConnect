import { Button } from '@smartconnect/ui/components/button';
import { Input, Select } from '@smartconnect/ui/components/input';
import { Network, Plus } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormDialog } from '@/components/form/form-dialog';
import { RevealItem } from '@/components/motion/reveal';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import type { Department } from '@/lib/api/types';
import { useCreateDepartment, useDeleteDepartment, useDepartments, useUpdateDepartment } from '@/lib/queries/directory';
import { useCan, useRequiredOrg } from '@/lib/queries/orgs';

export function DepartmentsPage() {
  const org = useRequiredOrg();
  const departments = useDepartments(org.id);
  const canManage = useCan(org.id, 'departments.manage');

  return (
    <PageContainer>
      <PageHeader
        title="Departments"
        description="How the company is organized."
        actions={canManage ? <CreateDepartmentDialog departments={departments.data ?? []} /> : null}
      />
      <QueryState query={departments} label="departments">
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={Network}
              title="No departments yet"
              description={
                canManage ? 'Create the first department.' : 'Administrators have not set up departments yet.'
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((department, index) => (
                <RevealItem key={department.id} index={index} hoverLift>
                  <DepartmentCard
                    department={department}
                    parent={list.find((item) => item.id === department.parentId)}
                    all={list}
                    canManage={canManage}
                  />
                </RevealItem>
              ))}
            </ul>
          )
        }
      </QueryState>
    </PageContainer>
  );
}

function DepartmentCard({
  department,
  parent,
  all,
  canManage,
}: {
  department: Department;
  parent?: Department;
  all: Department[];
  canManage: boolean;
}) {
  const org = useRequiredOrg();
  const toast = useToast();
  const remove = useDeleteDepartment(org.id);
  const [deleting, setDeleting] = useState(false);
  return (
    <Card className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{department.name}</h3>
        {parent ? <p className="text-xs text-muted-foreground">Part of {parent.name}</p> : null}
        {department.description ? <p className="mt-1 text-sm text-muted-foreground">{department.description}</p> : null}
      </div>
      {canManage ? <EditDepartmentDialog department={department} all={all} /> : null}
      {canManage ? (
        <Button variant="outline" size="sm" aria-label={`Delete ${department.name}`} onClick={() => setDeleting(true)}>
          Delete
        </Button>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${department.name}?`}
        description="This cannot be undone. A department that still has teams or sub-departments cannot be deleted."
        confirmLabel="Delete department"
        messages={{
          department_not_empty:
            'This department is not empty: it still has sub-departments or teams. Move or delete them first.',
        }}
        onConfirm={async () => {
          await remove.mutateAsync(department.id);
          toast({ title: `${department.name} was deleted` });
        }}
      />
    </Card>
  );
}

function CreateDepartmentDialog({ departments }: { departments: Department[] }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const create = useCreateDepartment(org.id);
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <Plus aria-hidden="true" />
          New department
        </Button>
      }
      title="New department"
      submitLabel="Create department"
      fields={['name', 'description', 'parentId']}
      validate={(values) => ({ name: values.name.trim() ? undefined : 'Enter a name.' })}
      submit={async (values) => {
        await create.mutateAsync({
          name: values.name.trim(),
          ...(values.description.trim() ? { description: values.description.trim() } : {}),
          ...(values.parentId ? { parentId: values.parentId } : {}),
        });
        toast({ title: `${values.name.trim()} was created` });
      }}
    >
      {(errors) => (
        <>
          <Field label="Name" error={errors.name}>
            {(control) => <Input {...control} name="name" maxLength={80} autoComplete="off" />}
          </Field>
          <Field label="Description (optional)" error={errors.description}>
            {(control) => <Input {...control} name="description" autoComplete="off" />}
          </Field>
          <Field label="Part of (optional)" error={errors.parentId}>
            {(control) => (
              <Select {...control} name="parentId" defaultValue="">
                <option value="">Top level</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}

/** A department cannot move under itself or any of its own descendants. */
function descendantIds(root: string, all: Department[]): Set<string> {
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const department of all) {
      if (department.parentId && found.has(department.parentId) && !found.has(department.id)) {
        found.add(department.id);
        grew = true;
      }
    }
  }
  return found;
}

function EditDepartmentDialog({ department, all }: { department: Department; all: Department[] }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const update = useUpdateDepartment(org.id);
  const excluded = descendantIds(department.id, all);
  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm" aria-label={`Edit ${department.name}`}>
          Edit
        </Button>
      }
      title={`Edit ${department.name}`}
      submitLabel="Save changes"
      fields={['name', 'description', 'parentId']}
      validate={(values) => ({ name: values.name.trim() ? undefined : 'Enter a name.' })}
      submit={async (values) => {
        await update.mutateAsync({
          id: department.id,
          name: values.name.trim(),
          description: values.description.trim() || null,
          parentId: values.parentId || null,
        });
        toast({ title: `${values.name.trim()} was updated` });
      }}
    >
      {(errors) => (
        <>
          <Field label="Name" error={errors.name}>
            {(control) => (
              <Input {...control} name="name" maxLength={80} autoComplete="off" defaultValue={department.name} />
            )}
          </Field>
          <Field label="Description (optional)" error={errors.description}>
            {(control) => (
              <Input {...control} name="description" autoComplete="off" defaultValue={department.description ?? ''} />
            )}
          </Field>
          <Field label="Part of (optional)" error={errors.parentId}>
            {(control) => (
              <Select {...control} name="parentId" defaultValue={department.parentId ?? ''}>
                <option value="">Top level</option>
                {all
                  .filter((item) => !excluded.has(item.id))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}
