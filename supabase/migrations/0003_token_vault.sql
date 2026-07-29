-- 0003_token_vault — encrypted storage for third-party OAuth tokens.
--
-- The data-access OAuth problem (a Gmail/Calendar refresh token the ingestion
-- worker uses in the background) is NOT solved by Supabase Auth — it must be
-- persisted and refreshed by us, server-side, encrypted at rest, never on the
-- client (architecture.md, "OAuth — two different problems").
--
-- We store tokens in Supabase Vault (pgsodium-backed). account.token_secret_id
-- points at the vault secret; the plaintext only ever exists transiently inside
-- these SECURITY DEFINER helpers, callable by the service role only.

create extension if not exists supabase_vault cascade;

-- Write (create or replace) the token blob for an account and stamp its
-- secret id onto the account row. `token_json` is the serialized
-- { access_token, refresh_token, expiry, scope } bundle.
create or replace function store_account_token(p_account_id uuid, p_token_json text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_name text := 'account_token:' || p_account_id::text;
begin
  select token_secret_id into v_secret_id from account where id = p_account_id;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_token_json, v_name, 'PRM account OAuth token');
    update account set token_secret_id = v_secret_id, updated_at = now()
      where id = p_account_id;
  else
    perform vault.update_secret(v_secret_id, p_token_json);
  end if;

  return v_secret_id;
end;
$$;

-- Read the decrypted token blob for an account (service role only).
create or replace function read_account_token(p_account_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_plain text;
begin
  select token_secret_id into v_secret_id from account where id = p_account_id;
  if v_secret_id is null then
    return null;
  end if;
  select decrypted_secret into v_plain
    from vault.decrypted_secrets where id = v_secret_id;
  return v_plain;
end;
$$;

-- Lock the helpers down: never callable from the browser.
revoke all on function store_account_token(uuid, text) from public, anon, authenticated;
revoke all on function read_account_token(uuid) from public, anon, authenticated;
grant execute on function store_account_token(uuid, text) to service_role;
grant execute on function read_account_token(uuid) to service_role;
