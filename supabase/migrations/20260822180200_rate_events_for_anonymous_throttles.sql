-- Anonymous callers (guest AI replies, signups) have no auth.users row, so
-- ai_requests.user_id cannot track them. rate_events is the append-only
-- counter table for IP-derived throttle keys. Same posture as ai_requests:
-- RLS enabled, no policies, no client grants; only the service role touches it.
create table public.rate_events (
  id bigint generated always as identity primary key,
  key text not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index rate_events_key_action_created_idx on public.rate_events (key, action, created_at desc);
alter table public.rate_events enable row level security;
