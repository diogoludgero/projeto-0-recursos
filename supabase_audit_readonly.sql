-- Auditoria complementar. Não altera dados, permissões, buckets ou contas.
-- Executar no SQL Editor do projeto Supabase correto, com acesso autenticado.
-- Não executar supabase_setup.sql como uma migração de segurança.
BEGIN TRANSACTION READ ONLY;

-- RLS e políticas efetivamente instaladas (o ficheiro de setup pode diferir).
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('users', 'subjects', 'files', 'file_requests',
                   'student_grades', 'student_enrolled', 'student_absences');

SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('users', 'subjects', 'files', 'file_requests',
                    'student_grades', 'student_enrolled', 'student_absences')
ORDER BY tablename, policyname;

SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
ORDER BY table_name, grantee, privilege_type;

-- Triggers que possam interferir nas operações ou voltar a criar registos.
SELECT c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('files', 'file_requests', 'subjects')
  AND NOT t.tgisinternal;

SELECT pubname, schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY schemaname, tablename;

-- Conteúdo embebido na base de dados versus eventuais URLs externas.
SELECT CASE WHEN data_url LIKE 'data:%' THEN 'conteudo_embebido'
            WHEN data_url LIKE '%/storage/v1/%' THEN 'url_storage_a_verificar'
            ELSE 'outro_formato' END AS formato,
       count(*) AS quantidade
FROM public.files GROUP BY 1;

-- Registos associados a cadeiras inexistentes; apenas identificação, sem conteúdo.
SELECT f.id, f.subject_id
FROM public.files f LEFT JOIN public.subjects s ON s.id = f.subject_id
WHERE s.id IS NULL;

SELECT r.id, r.subject_id
FROM public.file_requests r LEFT JOIN public.subjects s ON s.id = r.subject_id
WHERE s.id IS NULL;

-- Candidatos a duplicação, não uma indicação para os eliminar automaticamente.
SELECT subject_id, file_name, title, count(*) AS quantidade
FROM public.files
GROUP BY subject_id, file_name, title
HAVING count(*) > 1;

SELECT count(*) AS grupos_de_usernames_duplicados_sem_distinguir_maiusculas
FROM (SELECT lower(username) FROM public.users
      GROUP BY lower(username) HAVING count(*) > 1) duplicados;

-- Inventário de buckets/objetos. Não lê nem elimina o conteúdo dos ficheiros.
SELECT b.id, b.public, count(o.id) AS quantidade_objetos
FROM storage.buckets b
LEFT JOIN storage.objects o ON o.bucket_id = b.id
GROUP BY b.id, b.public ORDER BY b.id;

ROLLBACK;
