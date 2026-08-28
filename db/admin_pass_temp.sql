-- =====================================================================
-- WineSelection — Migração: password temporária dada pelo admin
-- (wineselection.admin_pass_temp)
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
--
-- Mesmo padrão do goals.admin_pass_temp / festasbv.admin_pass_temp — motivo:
-- este projeto Supabase não tem SMTP próprio configurado, e sem ele o painel
-- não deixa editar templates de email, por isso o "Esqueci-me da password"
-- fica só com o template genérico (sem código de 6 dígitos). Em vez de
-- depender disso, o admin gera aqui uma password, dita-a por telefone, e a
-- pessoa troca-a assim que entra (Definições › Conta).
--
-- SEGURANÇA — o que a função garante, do lado do servidor:
--   · só o admin a pode executar (is_admin(), não a UI);
--   · só para contas que já têm acesso à app (allowed_users);
--   · não mexe na conta do próprio admin (essa muda-se no Supabase);
--   · search_path fixo.
--
-- Tolerante: sem esta migração, o botão na app diz que falta correr este
-- ficheiro e mais nada muda.
-- =====================================================================

CREATE OR REPLACE FUNCTION wineselection.admin_pass_temp(p_email text, p_password text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'wineselection', 'public', 'extensions'
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_id    uuid;
BEGIN
  IF NOT wineselection.is_admin() THEN
    RAISE EXCEPTION 'Apenas o administrador pode gerar passwords temporárias';
  END IF;
  IF v_email IS NULL OR v_email = '' OR p_password IS NULL OR length(p_password) < 8 THEN
    RAISE EXCEPTION 'Email em falta ou password demasiado curta (mínimo 8)';
  END IF;
  IF v_email = 'diogo.andre.f.silva@gmail.com' THEN
    RAISE EXCEPTION 'A password do administrador muda-se no Supabase';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wineselection.allowed_users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'Essa conta não tem acesso à app';
  END IF;

  UPDATE auth.users
     SET encrypted_password = crypt(p_password, gen_salt('bf', 10)),
         email_confirmed_at = COALESCE(email_confirmed_at, now()),
         updated_at         = now()
   WHERE lower(email) = v_email
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Não existe nenhuma conta com esse email';
  END IF;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION wineselection.admin_pass_temp(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wineselection.admin_pass_temp(text, text) TO authenticated;
