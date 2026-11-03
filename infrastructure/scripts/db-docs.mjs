#!/usr/bin/env node
// Generates docs/database/erd.md and docs/database/schema-reference.md from the LIVE catalog of the
// dev database, so diagrams and column-level reference can never drift from what is deployed.
//
//   node infrastructure/scripts/db-docs.mjs        (run after `make db-migrate`)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, SERVICES, loadTargets, runSql } from './lib/db-lib.mjs';

const target = loadTargets().dev;
const OUT = path.join(REPO_ROOT, 'docs/database');
const INFRA_TABLES = new Set(['outbox_events', 'processed_events', '_prisma_migrations']);
const json = (sql) => JSON.parse(runSql(target, `select coalesce(json_agg(t), '[]') from (${sql}) t`));
const schemas = `array[${SERVICES.map((s) => `'${s}'`).join(',')}]`;

const columns = json(`
  select n.nspname as schema, c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type,
         a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as dflt, a.attnum
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = any(${schemas}) and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  order by n.nspname, c.relname, a.attnum`);
const constraints = json(`
  select n.nspname as schema, c.relname as tbl, k.conname as name, k.contype as type, pg_get_constraintdef(k.oid) as def,
         (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) as cols,
         fc.relname as ref_tbl
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_class fc on fc.oid = k.confrelid
  where n.nspname = any(${schemas}) order by n.nspname, c.relname, k.contype, k.conname`);
const indexes = json(`
  select schemaname as schema, tablename as tbl, indexname as name, indexdef as def
  from pg_indexes where schemaname = any(${schemas}) order by schemaname, tablename, indexname`);
const uniqueIndexes = json(`
  select n.nspname as schema, c.relname as tbl, i.relname as name,
         (select array_agg(a.attname order by x.ord) from unnest(ix.indkey::int2[]) with ordinality x(attnum, ord)
            join pg_attribute a on a.attrelid = c.oid and a.attnum = x.attnum) as cols
  from pg_index ix join pg_class c on c.oid = ix.indrelid join pg_class i on i.oid = ix.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where ix.indisunique and ix.indpred is null and n.nspname = any(${schemas})`);
const tables = json(`
  select n.nspname as schema, c.relname as tbl, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = any(${schemas}) and c.relkind = 'r' order by n.nspname, c.relname`);
const policies = json(`
  select schemaname as schema, tablename as tbl, policyname as name, cmd, qual, with_check
  from pg_policies where schemaname = any(${schemas}) order by schemaname, tablename, policyname`);
const functions = json(`
  select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any(${schemas}) order by 1, 2`);

const by = (rows, schema, tbl) => rows.filter((r) => r.schema === schema && (tbl === undefined || r.tbl === tbl));
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

// ---------------------------------------------------------------------------------------------
function mermaidType(type) {
  const t = type.replace(/"/g, '').replace(/^[a-z_]+\./, ''); // enums render schema-qualified
  if (t.endsWith('[]')) return `${mermaidType(t.slice(0, -2))}_array`;
  return t
    .replace(/^character varying.*/, 'varchar')
    .replace(/^character\(.*/, 'char')
    .replace(/^timestamp\(\d\) with time zone$/, 'timestamptz')
    .replace(/^double precision$/, 'float8')
    .replace(/[^A-Za-z0-9_]/g, '_');
}

function serviceErd(svc) {
  const lines = ['```mermaid', 'erDiagram'];
  const domain = by(tables, svc).filter((t) => !INFRA_TABLES.has(t.tbl));
  for (const { tbl } of domain) {
    const cons = by(constraints, svc, tbl);
    const keyOf = (col) => {
      const keys = [];
      if (cons.some((k) => k.type === 'p' && k.cols.includes(col))) keys.push('PK');
      if (cons.some((k) => k.type === 'f' && k.cols.includes(col))) keys.push('FK');
      if (!keys.length && by(uniqueIndexes, svc, tbl).some((u) => u.cols.length === 1 && u.cols[0] === col))
        keys.push('UK');
      return keys.join(', ');
    };
    lines.push(`  ${tbl} {`);
    for (const c of by(columns, svc, tbl)) lines.push(`    ${mermaidType(c.type)} ${c.col} ${keyOf(c.col)}`.trimEnd());
    lines.push('  }');
  }
  for (const k of constraints.filter((k) => k.schema === svc && k.type === 'f' && !INFRA_TABLES.has(k.tbl))) {
    const nullable = k.cols.some(
      (col) => !columns.find((c) => c.schema === svc && c.tbl === k.tbl && c.col === col).not_null,
    );
    const unique = by(uniqueIndexes, svc, k.tbl).some(
      (u) => u.cols.length === k.cols.length && u.cols.every((c) => k.cols.includes(c)),
    );
    const childSide = unique ? 'o|' : 'o{';
    lines.push(
      `  ${k.ref_tbl} ${nullable ? '|o' : '||'}--${childSide} ${k.tbl} : "${k.cols.filter((c) => c !== 'organization_id').join(', ') || k.cols.join(', ')}"`,
    );
  }
  lines.push('```');
  return lines.join('\n');
}

const overview = `\`\`\`mermaid
erDiagram
  %% Solid lines: real foreign keys inside one schema. Dotted lines: LOGICAL references across services
  %% (plain UUID columns, no FK; consistency via outbox events). Every tenant row carries organization_id.
  organizations ||--o{ organization_members : "organization"
  organizations ||--o{ organization_roles : "organization"
  users ||..o{ organization_members : "user_id (logical)"
  organizations ||..o{ workspaces : "organization_id (logical)"
  workspaces ||--o{ channels : "workspace"
  workspaces ||--o{ workspace_members : "workspace"
  channels ||--o{ channel_members : "channel"
  channels ||..o| conversations : "channel_id (logical)"
  conversations ||--o{ conversation_members : "conversation"
  conversations ||--o{ messages : "conversation"
  messages ||--o{ message_reactions : "message"
  messages ||..o{ message_attachments : "message"
  files ||..o{ message_attachments : "file_id (logical)"
  users ||..o{ messages : "sender_user_id (logical)"
  channels ||..o{ meetings : "channel_id (logical)"
  meetings ||--o{ meeting_participants : "meeting"
  meetings ||--o{ meeting_recordings : "meeting"
  files ||..o{ meeting_recordings : "file_id (logical)"
  documents ||--o{ document_versions : "document"
  task_lists ||--o{ tasks : "task list"
  users ||..o{ notifications : "recipient_user_id (logical)"
  workflows ||--o{ workflow_executions : "workflow"
  integration_connections ||--o{ webhooks : "connection"
  organizations ||..o{ audit_logs : "organization_id (logical)"
  users ||--o{ sessions : "user"
\`\`\``;

const erd = [
  '<!-- GENERATED by infrastructure/scripts/db-docs.mjs from the live catalog. Do not edit by hand. -->',
  '# SmartConnect database ERD',
  '',
  'Generated from the deployed dev database. It reflects the migrations, not intentions. Regenerate with `node infrastructure/scripts/db-docs.mjs` after `make db-migrate`.',
  '',
  '- **Overview** shows the core entities across services. Dotted lines are *logical* cross-service references: UUID columns with no foreign key, kept consistent by events ([relationships.md](relationships.md)).',
  '- **Per-service diagrams** show every domain table with exact columns and foreign keys. Composite tenant foreign keys are labelled by their non-tenant column. `organization_id` is implied, and both columns are enforced together. ([tenant-isolation.md](tenant-isolation.md)).',
  '- `outbox_events`, `processed_events` and `_prisma_migrations` exist in **every** schema and are omitted from the diagrams.',
  '',
  '## Overview (cross-service)',
  '',
  overview,
  '',
  ...SERVICES.flatMap((svc) => [`## ${svc}`, '', serviceErd(svc), '']),
].join('\n');

// ---------------------------------------------------------------------------------------------
const reference = [
  '<!-- GENERATED by infrastructure/scripts/db-docs.mjs from the live catalog. Do not edit by hand. -->',
  '# Schema reference (generated)',
  '',
  `Generated from the deployed dev database (${SERVICES.length} service schemas, ${tables.length} tables). ` +
    'Rationale, tenancy, retention and security notes for each entity live in [schema-design.md](schema-design.md).',
  '',
  ...SERVICES.flatMap((svc) => {
    const fns = functions.filter((f) => f.schema === svc);
    return [
      `## ${svc}`,
      '',
      ...(fns.length
        ? [
            '**Functions:** ' +
              fns.map((f) => `\`${f.name}(${f.args})\`${f.definer ? ' *(SECURITY DEFINER)*' : ''}`).join(', '),
            '',
          ]
        : []),
      ...by(tables, svc).flatMap(({ tbl, rls }) => {
        const pols = by(policies, svc, tbl);
        return [
          `### \`${svc}.${tbl}\``,
          '',
          `Row-level security: **${rls ? 'enabled' : 'off'}**${pols.length ? ` · policies: ${pols.map((p) => `\`${p.name}\` (${p.cmd})`).join(', ')}` : ''}`,
          '',
          '| Column | Type | Null | Default |',
          '|---|---|---|---|',
          ...by(columns, svc, tbl).map(
            (c) =>
              `| \`${c.col}\` | ${esc(c.type)} | ${c.not_null ? 'NOT NULL' : 'null'} | ${c.dflt ? `\`${esc(c.dflt)}\`` : ''} |`,
          ),
          '',
          '<details><summary>Constraints and indexes</summary>',
          '',
          // Definitions are code spans: as plain text, CHECK regexes such as `[a-z0-9](?:…)` render as links.
          ...by(constraints, svc, tbl).map((k) => `- \`${k.name}\`: \`${k.def}\``),
          ...by(indexes, svc, tbl).map(
            (i) =>
              `- index \`${i.name}\`: \`${i.def.replace(/ ON [a-z_]+\.[a-z_]+ USING btree/, '').replace(/^CREATE /, '')}\``,
          ),
          '',
          '</details>',
          '',
        ];
      }),
    ];
  }),
].join('\n');

writeFileSync(path.join(OUT, 'erd.md'), erd + '\n');
writeFileSync(path.join(OUT, 'schema-reference.md'), reference + '\n');
console.log(
  `✔ wrote docs/database/erd.md and docs/database/schema-reference.md (${tables.length} tables, ${constraints.length} constraints, ${indexes.length} indexes, ${policies.length} policies)`,
);
