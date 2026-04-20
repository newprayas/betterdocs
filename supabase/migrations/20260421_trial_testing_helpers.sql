begin;

create or replace function public.set_trial_usage_for_testing(
  p_email text,
  p_trial_queries_used integer,
  p_trial_queries_limit integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text;
  updated_profile public.profiles;
  safe_limit integer;
  safe_used integer;
begin
  normalized_email := lower(trim(coalesce(p_email, '')));

  if normalized_email = '' then
    raise exception 'Email is required.';
  end if;

  safe_limit := greatest(coalesce(p_trial_queries_limit, 30), 1);
  safe_used := greatest(coalesce(p_trial_queries_used, 0), 0);

  update public.profiles
  set trial_queries_limit = safe_limit,
      trial_queries_used = least(safe_used, safe_limit)
  where lower(email) = normalized_email
  returning *
  into updated_profile;

  if not found then
    raise exception 'No profile found for email: %', normalized_email;
  end if;

  return jsonb_build_object(
    'email', updated_profile.email,
    'trial_queries_used', updated_profile.trial_queries_used,
    'trial_queries_limit', updated_profile.trial_queries_limit,
    'remaining_trial_queries', greatest(updated_profile.trial_queries_limit - updated_profile.trial_queries_used, 0),
    'subscription_expires_at', updated_profile.subscription_expires_at,
    'subscription_plan', updated_profile.subscription_plan
  );
end;
$$;

revoke all on function public.set_trial_usage_for_testing(text, integer, integer) from anon;
revoke all on function public.set_trial_usage_for_testing(text, integer, integer) from authenticated;

commit;
