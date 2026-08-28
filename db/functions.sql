-- =====================================================================
-- WineSelection — Funções (schema `wineselection`)
-- Ordem: schema.sql -> functions.sql -> policies.sql
-- =====================================================================

-- Admin? (compara email autenticado com o admin fixo)
CREATE OR REPLACE FUNCTION wineselection.is_admin()
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT auth.email() = 'diogo.andre.f.silva@gmail.com';
$$;

-- Utilizador tem acesso? (email consta em allowed_users)
CREATE OR REPLACE FUNCTION wineselection.is_allowed()
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT auth.email() IN (SELECT email FROM wineselection.allowed_users);
$$;

-- ---------------------------------------------------------------------
-- Guarda de inserção das análises: o `user_email` nunca vem do cliente —
-- é sempre o email autenticado, carimbado aqui. Mesmo padrão do
-- goals.pedpag_guard_ins.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wineselection.analises_guard_ins()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'wineselection', 'public'
AS $$
BEGIN
  NEW.user_email := COALESCE(auth.email(), '');
  NEW.criado_em  := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS analises_guard_ins ON wineselection.analises;
CREATE TRIGGER analises_guard_ins
  BEFORE INSERT ON wineselection.analises
  FOR EACH ROW EXECUTE FUNCTION wineselection.analises_guard_ins();
