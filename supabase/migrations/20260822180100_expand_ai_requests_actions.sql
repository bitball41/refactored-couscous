-- luna-direct now writes action-scoped rows: 'luna_reply' (signed-in, so the
-- Liminal AI budget is separate from Liminal Chat's 'reply' budget),
-- 'guest_reply' was planned for the per-IP guest throttle, and chat-auth uses
-- 'signup' (per-IP signup throttle). Guest throttling actually lives in
-- rate_events because ai_requests.user_id references auth.users; the wider
-- action list stays so the accounting table keeps working for both apps.
alter table public.ai_requests drop constraint ai_requests_action_check;
alter table public.ai_requests add constraint ai_requests_action_check
  check (action = any (array['reply'::text, 'summarize_inbox'::text, 'luna_reply'::text, 'guest_reply'::text, 'signup'::text]));
