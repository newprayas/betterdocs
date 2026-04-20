begin;

create extension if not exists pgcrypto;

alter table public.profiles
  add column if not exists subscription_expires_at timestamptz,
  add column if not exists trial_queries_used integer not null default 0,
  add column if not exists trial_queries_limit integer not null default 30;

update public.profiles
set trial_queries_used = coalesce(trial_queries_used, 0),
    trial_queries_limit = coalesce(trial_queries_limit, 30);

update public.profiles
set subscription_expires_at = case
  when subscription_plan = '1 Month' and subscription_start_date is not null then subscription_start_date + interval '30 days'
  when subscription_plan = '3 Months' and subscription_start_date is not null then subscription_start_date + interval '90 days'
  when subscription_plan = '6 Months' and subscription_start_date is not null then subscription_start_date + interval '180 days'
  when subscription_plan = '12 Months' and subscription_start_date is not null then subscription_start_date + interval '365 days'
  else subscription_expires_at
end
where subscription_expires_at is null
  and is_subscribed = true;

create table if not exists public.subscription_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  plan_type text not null check (plan_type in ('1 Month', '3 Months')),
  duration_days integer not null check (duration_days in (30, 90)),
  is_used boolean not null default false,
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

create unique index if not exists subscription_codes_code_upper_idx
  on public.subscription_codes (upper(code));

alter table public.subscription_codes enable row level security;

revoke all on public.subscription_codes from anon;
revoke all on public.subscription_codes from authenticated;

create or replace function public.ensure_profile_for_current_user()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.profiles (
    id,
    email,
    trial_start_date,
    is_subscribed,
    trial_queries_used,
    trial_queries_limit
  )
  values (
    auth.uid(),
    coalesce(auth.jwt() ->> 'email', ''),
    now(),
    false,
    0,
    30
  )
  on conflict (id) do update
  set email = coalesce(profiles.email, excluded.email),
      trial_queries_limit = coalesce(profiles.trial_queries_limit, 30),
      trial_queries_used = coalesce(profiles.trial_queries_used, 0);

  select *
  into current_profile
  from public.profiles
  where id = auth.uid();

  return current_profile;
end;
$$;

create or replace function public.get_subscription_access_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.profiles;
  subscription_active boolean;
  trial_query_limit integer;
  trial_queries_used integer;
  remaining_trial_queries integer;
  days_remaining integer;
begin
  current_profile := public.ensure_profile_for_current_user();

  trial_query_limit := coalesce(current_profile.trial_queries_limit, 30);
  trial_queries_used := coalesce(current_profile.trial_queries_used, 0);
  remaining_trial_queries := greatest(trial_query_limit - trial_queries_used, 0);
  subscription_active := current_profile.subscription_expires_at is not null
    and current_profile.subscription_expires_at > now();
  days_remaining := case
    when subscription_active then greatest(
      ceil(extract(epoch from (current_profile.subscription_expires_at - now())) / 86400.0)::integer,
      0
    )
    else null
  end;

  return jsonb_build_object(
    'has_access', subscription_active or remaining_trial_queries > 0,
    'access_type', case
      when subscription_active then 'subscription'
      when remaining_trial_queries > 0 then 'trial'
      else 'none'
    end,
    'is_trial_expired', remaining_trial_queries <= 0,
    'is_subscription_expired', not subscription_active,
    'days_remaining', days_remaining,
    'trial_queries_used', trial_queries_used,
    'trial_query_limit', trial_query_limit,
    'remaining_trial_queries', remaining_trial_queries,
    'subscription_expires_at', current_profile.subscription_expires_at,
    'subscription_plan', current_profile.subscription_plan
  );
end;
$$;

create or replace function public.consume_trial_query_if_needed()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.profiles;
  subscription_active boolean;
  remaining_trial_queries integer;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'unauthorized'
    );
  end if;

  perform public.ensure_profile_for_current_user();

  select *
  into current_profile
  from public.profiles
  where id = auth.uid()
  for update;

  subscription_active := current_profile.subscription_expires_at is not null
    and current_profile.subscription_expires_at > now();

  if subscription_active then
    return public.get_subscription_access_status() || jsonb_build_object(
      'allowed', true,
      'reason', 'subscription'
    );
  end if;

  remaining_trial_queries := greatest(
    coalesce(current_profile.trial_queries_limit, 30) - coalesce(current_profile.trial_queries_used, 0),
    0
  );

  if remaining_trial_queries <= 0 then
    return public.get_subscription_access_status() || jsonb_build_object(
      'allowed', false,
      'reason', 'trial_exhausted'
    );
  end if;

  update public.profiles
  set trial_queries_used = coalesce(trial_queries_used, 0) + 1
  where id = auth.uid();

  return public.get_subscription_access_status() || jsonb_build_object(
    'allowed', true,
    'reason', 'trial'
  );
end;
$$;

create or replace function public.redeem_subscription_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text;
  current_profile public.profiles;
  selected_code public.subscription_codes;
  base_expiry timestamptz;
  new_expiry timestamptz;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'success', false,
      'error', 'Unauthorized'
    );
  end if;

  normalized_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));

  if normalized_code = '' then
    return jsonb_build_object(
      'success', false,
      'error', 'Please enter a code.'
    );
  end if;

  current_profile := public.ensure_profile_for_current_user();

  select *
  into selected_code
  from public.subscription_codes
  where upper(code) = normalized_code
  for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'error', 'This code is invalid.'
    );
  end if;

  if selected_code.is_used then
    return jsonb_build_object(
      'success', false,
      'error', 'This code has already been used.'
    );
  end if;

  base_expiry := greatest(coalesce(current_profile.subscription_expires_at, now()), now());
  new_expiry := base_expiry + make_interval(days => selected_code.duration_days);

  update public.profiles
  set subscription_expires_at = new_expiry,
      subscription_start_date = now(),
      subscription_plan = selected_code.plan_type::subscription_plan_type,
      is_subscribed = true
  where id = auth.uid();

  update public.subscription_codes
  set is_used = true,
      used_by = auth.uid(),
      used_at = now()
  where id = selected_code.id;

  return jsonb_build_object(
    'success', true,
    'status', public.get_subscription_access_status(),
    'subscription_expires_at', new_expiry,
    'subscription_plan', selected_code.plan_type
  );
end;
$$;

create or replace function public.generate_subscription_codes(
  p_plan_type text,
  p_count integer default 25
)
returns table (
  code text,
  plan_type text,
  duration_days integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  generated_code text;
  generated_duration integer;
  char_index integer;
  code_index integer;
begin
  if p_plan_type not in ('1 Month', '3 Months') then
    raise exception 'Plan type must be 1 Month or 3 Months.';
  end if;

  if p_count < 1 or p_count > 500 then
    raise exception 'Code count must be between 1 and 500.';
  end if;

  generated_duration := case
    when p_plan_type = '1 Month' then 30
    else 90
  end;

  for code_index in 1..p_count loop
    loop
      generated_code := '';

      for char_index in 1..6 loop
        generated_code := generated_code || substr(
          chars,
          1 + floor(random() * length(chars))::integer,
          1
        );
      end loop;

      exit when not exists (
        select 1
        from public.subscription_codes
        where upper(subscription_codes.code) = upper(generated_code)
      );
    end loop;

    insert into public.subscription_codes (
      code,
      plan_type,
      duration_days,
      created_by
    )
    values (
      generated_code,
      p_plan_type,
      generated_duration,
      auth.uid()
    );

    code := generated_code;
    plan_type := p_plan_type;
    duration_days := generated_duration;
    return next;
  end loop;
end;
$$;

grant execute on function public.get_subscription_access_status() to authenticated;
grant execute on function public.consume_trial_query_if_needed() to authenticated;
grant execute on function public.redeem_subscription_code(text) to authenticated;

revoke all on function public.generate_subscription_codes(text, integer) from anon;
revoke all on function public.generate_subscription_codes(text, integer) from authenticated;

commit;
