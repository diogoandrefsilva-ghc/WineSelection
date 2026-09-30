-- =====================================================================
-- WineSelection — Funções (schema `wineselection`)
-- Ordem: schema.sql -> functions.sql -> policies.sql
-- =====================================================================

-- As duas levam `search_path` fixo. Nenhuma é SECURITY DEFINER e tudo o que
-- lhes interessa já vai qualificado, por isso o risco aqui é pequeno — mas
-- é a regra que TODAS as funções da Garrafeira cumprem desde sempre, e uma
-- regra que vale para umas e não para outras é uma regra que um dia se
-- esquece na que importa. Mais uma em que a lição tinha ficado só de um
-- lado (ver "As lições da Garrafeira têm de atravessar para cá" no
-- CLAUDE.md). Aplicado em produção pela migração 13 do repo Garrafeira,
-- `db/migracao-blindagem.sql`.

-- Admin? (compara email autenticado com o admin fixo)
CREATE OR REPLACE FUNCTION wineselection.is_admin()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path TO 'wineselection', 'public'
AS $$
  SELECT auth.email() = 'diogo.andre.f.silva@gmail.com';
$$;

-- Utilizador tem acesso? (email consta em allowed_users — OU tem IA na
-- Garrafeira). A segunda metade é de 30/09/2026: as Sugestões passaram a
-- viver no Catálogo da Garrafeira (o separador "Sugestões", repo Garrafeira,
-- "SUGESTÕES" no app.js), e quem as usa lá é quem tem IA lá
-- (`garrafeira.plano_ia()`: 'gratis' ou 'premium'; o admin é sempre
-- 'premium'). As duas Edge Functions perguntam AQUI (RPC com o JWT de quem
-- chamou), e a policy `analises_ins` também: a regra vive num sítio só.
-- `plano_ia()` é SECURITY DEFINER e está aberta a PUBLIC; sem sessão devolve
-- 'sem_ia'. Quando esta app for desligada, a primeira metade pode sair.
CREATE OR REPLACE FUNCTION wineselection.is_allowed()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path TO 'wineselection', 'public'
AS $$
  SELECT COALESCE(auth.email() IN (SELECT email FROM wineselection.allowed_users), false)
      OR COALESCE(garrafeira.plano_ia() IN ('gratis', 'premium'), false);
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
