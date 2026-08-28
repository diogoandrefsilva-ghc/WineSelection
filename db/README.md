# WineSelection — Base de dados (Supabase)

Fonte de verdade do schema `wineselection` no **mesmo projeto Supabase do
FestasBV/Goals** (`diogoandrefsilva-personalapps-database`,
`https://gjweqwfbnkgnibhajldc.supabase.co`). `wineselection` é um schema à
parte — tabelas, RLS e admin próprios, não mexe em nada dos outros.

## Regra de ouro

**O repo é a fonte; o Supabase segue atrás.** Quando há uma alteração ao
schema, funções ou policies, edita-se primeiro o ficheiro `.sql` aqui e só
depois se cola no SQL Editor do Supabase.

## Ordem de execução

1. `schema.sql` — schema `wineselection`, tabelas, GRANTs e
   `ENABLE ROW LEVEL SECURITY`.
2. `functions.sql` — `is_admin()`, `is_allowed()` + o trigger de `analises`.
3. `policies.sql` — RLS policies (dependem das funções).
4. `admin_pass_temp.sql` — opcional mas recomendado: dá ao admin uma forma
   de gerar uma password temporária sem depender de email (ver "Recuperação
   de password" abaixo). Idempotente, tolerante.

## Passos manuais (fora do SQL Editor)

1. **Expor o schema `wineselection` na API**: Project Settings → API →
   Data API → "Exposed schemas" → acrescentar `wineselection` ao lado de
   `festasbv`/`goals`/etc. Sem isto o PostgREST devolve 404 a tudo.
2. **Redirect URL**: Authentication → URL Configuration → Redirect URLs →
   acrescentar o URL onde a app fica servida (ex.
   `https://diogoandrefsilva-ghc.github.io/WineSelection/`). Sem isto o
   login com Google ou por link/código de recuperação falha.
3. **Secret do Gemini**: já existe no projeto (`GEMINI_API_KEY`, partilhado
   com `calendario-sporting`/`fatura-restaurante`) — a Edge Function
   `sugerir-vinho` usa-o sem precisar de nenhum passo extra.
4. **Bootstrap inicial** (uma vez, depois das tabelas criadas):
   ```sql
   INSERT INTO wineselection.allowed_users (email) VALUES ('diogo.andre.f.silva@gmail.com');
   ```
   `is_admin()` sozinho não chega para entrar na app — `sbAposLogin` exige
   sempre uma linha em `allowed_users`, admin incluído.

## Recuperação de password (sem depender de email)

Sem SMTP próprio, o email de recuperação não é fiável — mesma limitação do
Goals/FestasBV, mesma solução: **Definições › Utilizadores › "Gerar"**
(password temporária). Escolhes a conta, a app gera uma password legível,
dita-la-lhe por telefone, e a pessoa entra e troca-a em Definições
("Alterar password"). Requer `admin_pass_temp.sql` corrido.

## Conteúdo

- **schema.sql** — `allowed_users`, `access_requests` (controlo de acesso,
  igual ao Goals/FestasBV), `analises` (histórico de sugestões — guarda o
  `prato` e o `resultado` estruturado que o Gemini devolveu; a imagem em si
  NUNCA se guarda). Também é a fila de trabalho assíncrono da Edge Function:
  a linha nasce `estado='pendente'` (`resultado` ainda `null`) assim que o
  pedido chega, e só fica `'concluido'`/`'erro'` quando o trabalho em
  segundo plano (`EdgeRuntime.waitUntil`) acaba — ver "A Edge Function" no
  `CLAUDE.md`. `sync_log` (diagnóstico das chamadas à Edge Function).
- **functions.sql** — `is_admin()`, `is_allowed()`, e o trigger
  `analises_guard_ins` (o `user_email` de uma análise nunca vem do cliente —
  é sempre carimbado a partir do login autenticado).
- **policies.sql** — cada utilizador só vê/apaga as suas análises; o admin
  vê todas. `sync_log` só o admin lê (escrita é sempre da service role, via
  GRANT — não passa por policy nenhuma).
- **admin_pass_temp.sql** — `wineselection.admin_pass_temp(email, password)`
  (SECURITY DEFINER): rede de segurança da recuperação de password. Opcional.

## Modelo de permissões

| Ação | Admin | Utilizador aprovado | Conta sem `allowed_users` |
|---|---|---|---|
| Fotografar carta e pedir sugestão | ✅ | ✅ | ❌ (ecrã "sem acesso") |
| Ver o próprio histórico | ✅ | ✅ | ❌ |
| Ver o histórico de todos | ✅ | ❌ (só o seu) | ❌ |
| Aprovar pedidos de acesso | ✅ | ❌ | ❌ |
| Gerar password temporária | ✅ | ❌ | ❌ |

## ⚠️ Segredos — nunca commitar

- A **service_role key** ignora todo o RLS — nunca entra em ficheiro nenhum
  do repo (só vive nos Secrets da Edge Function, gerido pelo Supabase).
- A **anon key** que vive em `app.js` é pública por design (protegida por
  RLS + login), tal como nas outras apps do mesmo projeto — não é bug, não
  se esconde.

## Recriar do zero

```sql
-- no SQL Editor do Supabase, por ordem:
--   1) schema.sql
--   2) functions.sql
--   3) policies.sql
--   4) admin_pass_temp.sql (opcional)
```

Antes: expor o schema `wineselection` em Project Settings → API → Data API →
Exposed schemas (senão os GRANTs não chegam e dá HTTP 403 / código 42501).
