begin;

create or replace function public.apply_pending_trial_queries(p_count integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.profiles;
  safe_count integer;
  subscription_active boolean;
  limit_left integer;
  applied_count integer;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'success', false,
      'error', 'Unauthorized'
    );
  end if;

  safe_count := greatest(coalesce(p_count, 0), 0);
  if safe_count = 0 then
    return jsonb_build_object(
      'success', true,
      'applied_count', 0,
      'status', public.get_subscription_access_status()
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
    return jsonb_build_object(
      'success', true,
      'applied_count', 0,
      'status', public.get_subscription_access_status()
    );
  end if;

  limit_left := greatest(
    coalesce(current_profile.trial_queries_limit, 30) - coalesce(current_profile.trial_queries_used, 0),
    0
  );
  applied_count := least(safe_count, limit_left);

  if applied_count > 0 then
    update public.profiles
    set trial_queries_used = coalesce(trial_queries_used, 0) + applied_count
    where id = auth.uid();
  end if;

  return jsonb_build_object(
    'success', true,
    'applied_count', applied_count,
    'status', public.get_subscription_access_status()
  );
end;
$$;

grant execute on function public.apply_pending_trial_queries(integer) to authenticated;

commit;
