-- กล่องเครื่องมือทำงานของ กสม.
-- รันใน Supabase SQL Editor ได้โดยไม่ลบข้อมูลเดิม
-- Embedding ใช้ 1536 มิติ (OpenAI text-embedding-3-small)

create extension if not exists vector with schema extensions;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique,
  title text not null,
  document_type text not null check (document_type in ('กฎหมาย ระเบียบ แนวปฏิบัติ', 'คู่มือปฏิบัติงาน', 'บทเรียนการทำงาน', 'อื่น ๆ')),
  legal_category text,
  work_category text,
  record_type text not null default 'รายฉบับ' check (record_type in ('รายฉบับ', 'ฉบับรวม')),
  version_status text not null default 'รอตรวจสอบสถานะ',
  is_published boolean not null default true,
  source_path text not null,
  source_file text not null,
  storage_bucket text not null default 'reference-documents',
  storage_path text,
  mime_type text,
  file_size bigint,
  content_hash text,
  modified_at timestamptz,
  content_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ปรับ constraint ได้แม้ตาราง documents ถูกสร้างไปแล้ว
alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check
  check (document_type in ('กฎหมาย ระเบียบ แนวปฏิบัติ', 'คู่มือปฏิบัติงาน', 'บทเรียนการทำงาน', 'อื่น ๆ'));

create table if not exists public.document_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  page_start integer,
  page_end integer,
  heading text,
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create table if not exists public.work_categories (
  id bigint generated always as identity primary key,
  name text not null unique,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.document_work_categories (
  document_id uuid not null references public.documents(id) on delete cascade,
  work_category_id bigint not null references public.work_categories(id) on delete cascade,
  primary key (document_id, work_category_id)
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  question_text text not null,
  answer_text text,
  answer_status text not null default 'answered' check (answer_status in ('answered', 'insufficient_evidence', 'error')),
  model_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.answer_citations (
  id bigint generated always as identity primary key,
  question_id uuid not null references public.questions(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete restrict,
  chunk_id bigint references public.document_chunks(id) on delete set null,
  citation_label text,
  quoted_text text,
  relevance_score numeric,
  created_at timestamptz not null default now()
);

create index if not exists documents_type_idx on public.documents(document_type);
create index if not exists documents_legal_category_idx on public.documents(legal_category);
create index if not exists documents_work_category_idx on public.documents(work_category);
create index if not exists documents_modified_at_idx on public.documents(modified_at desc);
create index if not exists document_chunks_document_idx on public.document_chunks(document_id, chunk_index);
create index if not exists document_chunks_embedding_idx on public.document_chunks using hnsw (embedding vector_cosine_ops);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

insert into public.work_categories (name, sort_order) values
  ('งานดิจิทัล', 10),
  ('งานงบประมาณ งานคลัง', 20),
  ('งานพัสดุ-จัดซื้อจัดจ้าง งานบุคคล', 30),
  ('งานสารบรรณ งานบริหารทั่วไป งานคุ้มครอง งานส่งเสริม งานเฝ้าระวัง งานระหว่างประเทศ งานวิจัยและวิชาการ', 40)
on conflict (name) do nothing;

create or replace function public.match_document_chunks(
  query_embedding extensions.vector(1536),
  match_threshold float,
  match_count integer,
  filter_document_type text default null,
  filter_work_category text default null
)
returns table (
  chunk_id bigint,
  document_id uuid,
  title text,
  source_file text,
  source_path text,
  document_type text,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    c.id,
    d.id,
    d.title,
    d.source_file,
    d.source_path,
    d.document_type,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where d.is_published = true
    and c.embedding is not null
    and (filter_document_type is null or d.document_type = filter_document_type)
    and (filter_work_category is null or d.work_category = filter_work_category)
    and 1 - (c.embedding <=> query_embedding) >= match_threshold
  order by c.embedding <=> query_embedding
  limit least(match_count, 50);
$$;

-- RLS: เอกสารเผยแพร่อ่านได้ แต่การเขียนต้องทำผ่าน backend ที่เก็บ service key ไว้ฝั่ง server
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.work_categories enable row level security;
alter table public.document_work_categories enable row level security;
alter table public.questions enable row level security;
alter table public.answer_citations enable row level security;

drop policy if exists "published documents are readable" on public.documents;
create policy "published documents are readable"
on public.documents for select
to anon, authenticated
using (is_published = true);

drop policy if exists "published chunks are readable" on public.document_chunks;
create policy "published chunks are readable"
on public.document_chunks for select
to anon, authenticated
using (exists (
  select 1 from public.documents d
  where d.id = document_chunks.document_id and d.is_published = true
));

drop policy if exists "work categories are readable" on public.work_categories;
create policy "work categories are readable"
on public.work_categories for select
to anon, authenticated
using (true);

drop policy if exists "document category links are readable" on public.document_work_categories;
create policy "document category links are readable"
on public.document_work_categories for select
to anon, authenticated
using (exists (
  select 1 from public.documents d
  where d.id = document_work_categories.document_id and d.is_published = true
));

drop policy if exists "questions are not publicly readable" on public.questions;
drop policy if exists "citations are not publicly readable" on public.answer_citations;

grant select on public.documents, public.document_chunks, public.work_categories, public.document_work_categories to anon, authenticated;
grant execute on function public.match_document_chunks(extensions.vector(1536), float, integer, text, text) to anon, authenticated;

-- Storage: สร้าง bucket เอกสารแบบ private; backend จะออก signed URL ให้เปิดเอกสารจริง
insert into storage.buckets (id, name, public)
values ('reference-documents', 'reference-documents', false)
on conflict (id) do nothing;

drop policy if exists "authenticated users can read reference documents" on storage.objects;
create policy "authenticated users can read reference documents"
on storage.objects for select
to authenticated
using (bucket_id = 'reference-documents');

-- หมายเหตุ: การอัปโหลด/แก้ไข/ลบให้ทำผ่าน backend service role เท่านั้น
