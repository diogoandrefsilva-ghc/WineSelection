-- =====================================================================
-- WineSelection — RLS Policies (schema `wineselection`)
--
-- PRÉ-REQUISITO: depende das funções em functions.sql —
--   wineselection.is_admin(), wineselection.is_allowed()
-- Correr functions.sql ANTES deste ficheiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- access_requests
-- ---------------------------------------------------------------------
CREATE POLICY ar_insert ON wineselection.access_requests
  FOR INSERT TO authenticated
  WITH CHECK (email = auth.email());

CREATE POLICY ar_admin_sel ON wineselection.access_requests
  FOR SELECT TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

CREATE POLICY ar_admin_del ON wineselection.access_requests
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- allowed_users
-- ---------------------------------------------------------------------
CREATE POLICY au_select ON wineselection.allowed_users
  FOR SELECT TO authenticated
  USING ((email = auth.email()) OR (auth.email() = 'diogo.andre.f.silva@gmail.com'::text));

CREATE POLICY au_admin_ins ON wineselection.allowed_users
  FOR INSERT TO authenticated
  WITH CHECK (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

CREATE POLICY au_admin_del ON wineselection.allowed_users
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- analises — cada utilizador só vê/gere as suas; o admin vê todas (útil
-- para acompanhar uso). O trigger (functions.sql) já garante que
-- user_email é sempre o do autenticado, por isso o INSERT só precisa de
-- confirmar acesso.
-- ---------------------------------------------------------------------
CREATE POLICY analises_sel ON wineselection.analises
  FOR SELECT TO authenticated
  USING (user_email = auth.email() OR wineselection.is_admin());

CREATE POLICY analises_ins ON wineselection.analises
  FOR INSERT TO authenticated
  WITH CHECK (wineselection.is_allowed());

CREATE POLICY analises_del ON wineselection.analises
  FOR DELETE TO authenticated
  USING (user_email = auth.email() OR wineselection.is_admin());

-- ---------------------------------------------------------------------
-- sync_log — só o admin lê (diagnóstico); escreve-se sempre pela service
-- role (a Edge Function), que ignora RLS por GRANT direto, não por policy.
-- ---------------------------------------------------------------------
CREATE POLICY sync_log_admin_sel ON wineselection.sync_log
  FOR SELECT TO authenticated
  USING (wineselection.is_admin());
