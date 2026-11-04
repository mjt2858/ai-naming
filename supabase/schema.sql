-- AI 起名记录表
-- 在 Supabase SQL Editor 中执行本文件即可

create table if not exists public.naming_records (
  id          uuid primary key default gen_random_uuid(),
  surname     text,
  gender      text,
  style       text,
  requirement text not null,
  result      text not null,
  model       text not null,
  created_at  timestamptz not null default now()
);

comment on table public.naming_records is 'AI 起名：用户需求、生成的方案与所用模型';
comment on column public.naming_records.requirement is '用户填写的起名需求';
comment on column public.naming_records.result is '模型流式输出的完整起名方案';
comment on column public.naming_records.model is '实际调用的模型标识';

create index if not exists naming_records_created_at_idx
  on public.naming_records (created_at desc);

-- 只允许服务端 service_role 读写（service_role 会自动绕过 RLS），
-- 不创建匿名访问策略，避免结果被公开读取。
alter table public.naming_records enable row level security;
