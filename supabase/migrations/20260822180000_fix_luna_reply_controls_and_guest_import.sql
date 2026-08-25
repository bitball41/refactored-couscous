-- 1) Luna replies (inserted via chat_insert_luna_reply, which sets app.luna_reply_insert)
--    must not be blocked by community moderation: kill-switches, banned words,
--    slow mode, and length limits target human posts. Until now a maintenance
--    window or a banned-word match rejected Luna's already-paid replies with
--    reply_insert_failed.
-- 2) Guest-history import runs under the service role, where auth.uid() is null.
--    The DM guard trigger rejected every imported message with 'Authentication
--    required'. A transaction-scoped GUC (app.luna_import_user), set only by the
--    service-role-only RPC below, now marks guarded import inserts.

create or replace function public.chat_enforce_message_controls()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_is_owner boolean := false;
  v_is_admin boolean := false;
  v_is_banned boolean := false;
  v_timeout timestamptz;
  v_enabled boolean;
  v_words jsonb;
  v_word text;
  v_slow integer := 0;
  v_max_length integer := 2000;
  v_last_message_at timestamptz;
  v_is_luna_reply boolean := new.sender = 'Luna'
    and current_setting('app.luna_reply_insert', true) = 'true';
  v_luna_workspace boolean := false;
begin
  -- Guarded bulk import of guest history (service role, transaction-scoped flag).
  if coalesce(current_setting('app.luna_import_user', true), '') <> '' then
    return new;
  end if;

  -- Luna's replies are generated paid-side; community controls must not reject them.
  if v_is_luna_reply then
    return new;
  end if;

  select p.is_owner, p.is_admin, p.is_banned, p.timeout_until
  into v_is_owner, v_is_admin, v_is_banned, v_timeout
  from public.profiles p
  where p.username = new.sender;

  if tg_table_name = 'dm_messages' then
    select exists (
      select 1 from public.dms d
      where d.id = new.dm_id and 'Luna' = any (d.participants)
    ) into v_luna_workspace;
  end if;

  if coalesce(v_is_banned, false) then
    raise exception 'Banned accounts cannot send messages';
  end if;
  -- Timeouts are a chat mute. They do not apply to Luna or to DMs with Luna.
  if v_timeout is not null and v_timeout > now()
     and new.sender <> 'Luna'
     and not v_is_luna_reply
     and not v_luna_workspace then
    raise exception 'This account is timed out';
  end if;

  select coalesce((select value = 'true' from public.app_settings where key = 'app_enabled'), true)
  into v_enabled;
  if not v_enabled and not coalesce(v_is_owner, false) then
    raise exception 'Liminal Chat is currently disabled';
  end if;

  if tg_op = 'INSERT' then
    select coalesce((select value = 'true' from public.app_settings where key = 'messages_enabled'), true)
    into v_enabled;
    if not v_enabled and not coalesce(v_is_admin, false) and not coalesce(v_is_owner, false) then
      raise exception 'Sending messages is currently disabled';
    end if;

    if tg_table_name = 'dm_messages' then
      select coalesce((select value = 'true' from public.app_settings where key = 'dms_enabled'), true)
      into v_enabled;
      if not v_enabled and not coalesce(v_is_admin, false) and not coalesce(v_is_owner, false) then
        raise exception 'Direct messages are currently disabled';
      end if;
    end if;

    if not coalesce(v_is_admin, false) and not coalesce(v_is_owner, false) then
      begin
        select value::integer into v_slow
        from public.app_settings where key = 'slow_mode_seconds';
      exception when others then
        v_slow := 0;
      end;

      if v_slow > 0 then
        if tg_table_name = 'dm_messages' then
          select max(created_at) into v_last_message_at
          from public.dm_messages where sender = new.sender;
        else
          select max(created_at) into v_last_message_at
          from public.messages where sender = new.sender;
        end if;

        if v_last_message_at > now() - pg_catalog.make_interval(secs => v_slow) then
          raise exception 'Slow mode is active. Please wait before sending again';
        end if;
      end if;
    end if;
  end if;

  if not v_is_luna_reply then
    begin
      select value::integer into v_max_length
      from public.app_settings where key = 'max_message_length';
    exception when others then
      v_max_length := 2000;
    end;
    v_max_length := greatest(100, least(v_max_length, 4000));
    if char_length(coalesce(new.content, '')) > v_max_length then
      raise exception 'Message exceeds the current length limit';
    end if;
  end if;

  if new.type = 'gif' then
    select coalesce((select value = 'true' from public.app_settings where key = 'gifs_enabled'), true)
    into v_enabled;
    if not v_enabled then raise exception 'GIFs are currently disabled'; end if;
  elsif coalesce(new.media_url, '') <> '' then
    select coalesce((select value = 'true' from public.app_settings where key = 'uploads_enabled'), true)
    into v_enabled;
    if not v_enabled then raise exception 'Media uploads are currently disabled'; end if;
  end if;

  if coalesce(new.content, '') <> '' then
    begin
      select value::jsonb into v_words
      from public.app_settings where key = 'banned_words';
      for v_word in select jsonb_array_elements_text(coalesce(v_words, '[]'::jsonb))
      loop
        if v_word <> '' and position(lower(v_word) in lower(new.content)) > 0 then
          raise exception 'Message contains a blocked word';
        end if;
      end loop;
    exception
      when invalid_text_representation then null;
    end;
  end if;
  return new;
end;
$function$;

create or replace function public.chat_guard_dm_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor text := private.chat_username();
begin
  if tg_op = 'INSERT'
     and new.sender = 'Luna'
     and current_setting('app.luna_reply_insert', true) = 'true' then
    return new;
  end if;
  -- Guarded bulk import of guest history (service role, transaction-scoped flag).
  if tg_op = 'INSERT'
     and coalesce(current_setting('app.luna_import_user', true), '') <> ''
     and (new.sender = 'Luna' or new.sender = current_setting('app.luna_import_user', true)) then
    return new;
  end if;
  if v_actor is null then raise exception 'Authentication required'; end if;
  if tg_op = 'INSERT' then
    if new.sender <> v_actor then raise exception 'Sender must match the signed-in user'; end if;
    return new;
  end if;
  if new.id <> old.id or new.sender <> old.sender or new.dm_id <> old.dm_id
     or new.created_at <> old.created_at then
    raise exception 'DM ownership fields are immutable';
  end if;
  if old.sender = v_actor then
    if new.read_by is distinct from old.read_by then
      raise exception 'Senders cannot forge read receipts';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'read_by') <> (to_jsonb(old) - 'read_by')
     or new.read_by is distinct from pg_catalog.array_append(old.read_by, v_actor) then
    raise exception 'Only your own read receipt may be added';
  end if;
  return new;
end;
$function$;

-- 3) Service-role-only RPC that imports one guest conversation for a user.
--    Idempotent: a thread whose title and first message already exist is
--    returned as-is instead of being duplicated.
create or replace function public.chat_import_guest_thread(p_username text, p_title text, p_messages jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_username text;
  v_title text := pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_title, '')), '\s+', ' ', 'g'), 64);
  v_parts text[];
  v_dm_id uuid;
  v_msg jsonb;
  v_sender text;
  v_content text;
  v_type text;
  v_media text;
  v_reply_to jsonb;
  v_first jsonb;
  v_index integer := 0;
begin
  select p.username into v_username
  from public.profiles p
  where p.username = pg_catalog.btrim(p_username)
    and not coalesce(p.is_banned, false);
  if v_username is null then
    raise exception 'Active account required';
  end if;
  if v_title = '' then
    v_title := 'New conversation';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) < 1 then
    raise exception 'Messages are required';
  end if;
  if jsonb_array_length(p_messages) > 120 then
    raise exception 'Too many messages in one conversation';
  end if;

  v_parts := case when v_username < 'Luna'
    then array[v_username, 'Luna']::text[]
    else array['Luna', v_username]::text[] end;

  v_first := p_messages -> 0;
  select d.id into v_dm_id
  from public.dms d
  where d.participants = v_parts
    and d.title = v_title
    and exists (
      select 1 from public.dm_messages m
      where m.dm_id = d.id
        and m.sender = case when v_first ->> 'sender' = 'Luna' then 'Luna' else v_username end
        and m.content = pg_catalog.left(coalesce(v_first ->> 'content', ''), 20000)
    )
  limit 1;
  if v_dm_id is not null then
    return v_dm_id;
  end if;

  insert into public.dms (participants, title)
  values (v_parts, v_title)
  returning id into v_dm_id;

  perform pg_catalog.set_config('app.luna_import_user', v_username, true);

  for v_msg in select * from jsonb_array_elements(p_messages)
  loop
    v_sender := case when v_msg ->> 'sender' = 'Luna' then 'Luna' else v_username end;
    v_content := pg_catalog.left(pg_catalog.btrim(coalesce(v_msg ->> 'content', '')), 20000);
    v_type := case when v_msg ->> 'type' in ('image', 'file') then v_msg ->> 'type' else 'text' end;
    v_media := pg_catalog.left(coalesce(v_msg ->> 'media_url', ''), 1000);
    if v_media like 'data:%' then
      v_media := '';
    end if;
    v_reply_to := case
      when v_sender = 'Luna' and jsonb_typeof(v_msg -> 'reply_to') = 'object' then v_msg -> 'reply_to'
      else null end;
    if v_content = '' and v_media = '' then
      continue;
    end if;
    insert into public.dm_messages (dm_id, sender, content, type, media_url, reply_to, read_by, created_at)
    values (
      v_dm_id,
      v_sender,
      v_content,
      v_type,
      nullif(v_media, ''),
      v_reply_to,
      array[v_sender]::text[],
      now() + (v_index * interval '1 millisecond')
    );
    v_index := v_index + 1;
  end loop;

  return v_dm_id;
end;
$function$;

revoke all on function public.chat_import_guest_thread(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.chat_import_guest_thread(text, text, jsonb) to service_role;
