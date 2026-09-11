# Auditoria do civil67.pt — 11 de setembro de 2026

No encerramento da auditoria inicial, as correções do arquivo estavam aplicadas localmente e ainda não tinha sido feito commit, push ou deploy por esta tarefa. Não foram alteradas políticas nem dados na base de produção. Os documentos reais não foram eliminados. A aparência e a estrutura da página foram preservadas.

Na preparação da publicação, confirmou-se uma publicação anterior no GitHub: o commit `b501e5cfb5c8a6e0f0aa3cfcd7385611021b7511`, na `main`, já contém exatamente o `index.html` corrigido. O Vercel comunicou sucesso desse deploy e o domínio servia o mesmo HTML. O pacote adicional de publicação contém apenas este relatório, as consultas de auditoria e os dois ficheiros de testes; não altera o código do site nem executa SQL.

## Causa do reaparecimento dos ficheiros

O código publicado era igual ao `index.html` local no início da auditoria, commit `b53f7e9`. O fluxo original tinha duas fontes de dados: Supabase e cache/dados de demonstração no navegador.

1. Num navegador novo, o estado inicial continha `file_demo_1` e `file_demo_2`.
2. `fetchCloudState()` lia `public.files`.
3. Se a tabela estivesse vazia e a chave local `study_supabase_files_seeded` não existisse, a própria leitura executava INSERT dos ficheiros locais.
4. A chave só existia naquele navegador. Um navegador novo ou uma cache antiga podia, portanto, recriar os documentos após a sua eliminação.
5. O Realtime voltava a carregar esses registos nos outros navegadores.

Este mecanismo foi **reproduzido executando o código original num Chrome isolado, com uma base simulada vazia**: foram inseridos exatamente os dois IDs de demonstração. O código corrigido passou o mesmo teste sem inserir qualquer registo. Não é apenas uma hipótese sobre cache.

Havia ainda duas falhas independentes: `deleteFile()` removia o cartão e anunciava sucesso antes de terminar o DELETE; leituras simultâneas podiam aplicar uma resposta anterior à eliminação. Uma recusa por RLS sem linhas eliminadas também não era distinguida de sucesso.

As consultas de produção, exclusivamente de leitura, encontraram dois ficheiros com esses mesmos IDs. Ambos contêm os próprios PDFs em `files.data_url` e apontam para cadeiras inexistentes, explicando a etiqueta “Geral”. Não foi consultado o histórico dos DELETE reais; eventuais erros de permissões ou triggers instalados continuam por verificar no painel.

## Stack, tabelas e serviços

- HTML e JavaScript num único `index.html`, Tailwind via CDN, Font Awesome e Google Fonts. Não existe compilação, TypeScript, Next.js, ISR, revalidate, service worker ou routing de aplicação no repositório.
- Vercel serve os ficheiros estáticos. A raiz, o redirecionamento do domínio sem `www`, o logótipo e o favicon responderam HTTP 200. O HTML tinha `cache-control: public, max-age=0, must-revalidate`; o conteúdo servido coincidia com o código local original.
- Supabase JS v2 comunica diretamente com a API REST e subscreve alterações de PostgreSQL por Realtime.
- Tabelas: `users`, `subjects`, `student_grades`, `student_enrolled`, `student_absences`, `files`, `file_requests`.
- `files.data_url` guarda os ficheiros publicados; `file_requests.data_url` guarda os pedidos. São conteúdos Base64 dentro da base de dados, não uploads para buckets. Apagar uma linha de `files` elimina os metadados e o conteúdo embebido nessa linha na mesma operação. Não revoga cópias já descarregadas, caches de outros dispositivos ou backups do serviço.
- Não existem chamadas a Supabase Storage nem identificação de buckets no código. A existência de buckets ou objetos não utilizados no projeto remoto exige consulta autenticada; não foi presumida a sua ausência.
- Supabase Auth não é utilizado pelo login atual. A autenticação é uma comparação local de credenciais carregadas de `users`.
- Não existem ficheiros de configuração Vercel, `.env`, migrations de autenticação ou backend no repositório. URL e chave pública `anon` já estão no frontend. A presença de uma chave pública não é o problema de segurança; as permissões e a autenticação são.

## Problemas encontrados e resultado

| Gravidade | Local e causa | Correção / estado |
|---|---|---|
| Importante | `fetchCloudState`: INSERT automático quando `files` ou `subjects` estava vazia, controlado por uma chave de cada navegador. | **Corrigido:** a sincronização apenas lê; aceita listas vazias e nunca envia cache/demos para a nuvem. Removidos os ficheiros de demonstração do estado inicial. |
| Importante | `deleteFile`: remoção local e mensagem de sucesso antes da resposta, sem confirmar linhas afetadas. | **Corrigido:** aguarda DELETE com retorno do ID; erros, resposta vazia e falta de cliente Supabase não são anunciados como sucesso. Não cria uma lista local permanente de IDs escondidos. |
| Importante | Realtime: leituras sobrepostas ou anteriores a uma alteração podiam repor dados antigos. | **Corrigido para operações do arquivo abrangidas:** atualizações agrupadas e serializadas, com descarte de respostas iniciadas antes de uma operação; nova leitura após a operação e ao retomar a página. |
| Importante | `uploadFile`: gravação local antes do INSERT, sucesso mesmo perante falha e falta de tratamento de erro do FileReader. | **Corrigido:** confirmação remota, bloqueio de envio repetido, IDs UUID, captura da sessão, preservação do formulário se houver erro. |
| Importante | Cancelamento de pedido só alterava o navegador; recusa administrativa ignorava o resultado remoto. | **Corrigido:** DELETE confirmado em `file_requests`, com filtro de proprietário no cancelamento e verificação de papel na recusa. Estes controlos de interface não substituem RLS. |
| Importante | JSON inválido em localStorage ou quota excedida interrompia o arranque/fluxo de upload. | **Mitigado:** leitura defensiva, gravação independente das chaves e erro de cache não impede uma operação confirmada na nuvem. Falhas são registadas na consola. Isto não resolve operações de outros módulos que continuam a existir apenas localmente. |
| Importante | Leituras sem paginação e erros individuais ignorados, seguidos de mensagem de sincronização bem-sucedida. | **Corrigido:** paginação de 500 registos; só aplica a nova leitura completa se todas as consultas tiverem sucesso; avisa se os dados podem estar desatualizados. |
| Importante | Seletores de cadeiras e faltas podiam ficar desatualizados depois de carregar a nuvem. | **Corrigido:** atualização após sincronização, preservando a seleção válida nos formulários. |
| Crítico | `handleLogin`, contas iniciais, `syncDiogoAccount` e `supabase_setup.sql`: palavra-passe de administrador no código, palavras-passe em texto simples, papel/sessão controlados no navegador. O SQL prevê `FOR ALL TO anon USING (true) WITH CHECK (true)` nas sete tabelas. | **Pendente:** migrar para Supabase Auth e RLS por utilizador/papel, deixar de enviar palavras-passe ao browser, remover a conta automática e rodar a credencial exposta. A leitura anónima das sete tabelas foi confirmada por consultas HEAD; não foram testadas escritas anónimas nem lidas palavras-passe da produção. Não é seguro ativar apenas RLS restritiva: bloquearia o login e operações atuais. |
| Crítico | `handleRegister` e `handleAdminCreateStudent` executam DELETE por username antes do INSERT, confiando numa lista local que pode estar desatualizada. | **Corrigido o DELETE preventivo:** registo e criação administrativa aguardam o INSERT confirmado, preservam contas existentes em conflito e não criam sessão local em caso de falha. Cliques repetidos são bloqueados por username. A criação administrativa distingue conta criada de inscrições que falharam. A unicidade de usernames sem distinguir maiúsculas continua a exigir validação/migração na base. Não foram criadas ou eliminadas contas reais durante a auditoria. |
| Crítico | Valores introduzidos por utilizadores são interpolados diretamente em `innerHTML`, atributos e eventos. | **Correção parcial:** escape de texto e argumentos nos cartões do arquivo, pedidos e notificações. Permanecem pontos em cadeiras, docentes, perfis e alunos que exigem revisão completa de XSS e de URLs/ficheiros ativos. Não considerar o site seguro apenas com este escape parcial. |
| Importante | `approveFileRequest`: INSERT de ficheiro e DELETE de pedido independentes, sem transação nem tratamento adequado de falhas. | **Pendente:** função transacional na base, com autorização e idempotência por pedido. Pode haver duplicação ou perda de pedido se uma operação falhar. Não foi introduzida uma dependência SQL não instalada que bloqueasse o botão existente. |
| Importante | `saveGrade`, `handleAvatarUpload` e `handleRequestNameChange` alteram apenas o estado local. | **Pendente:** persistir esses dados e tratar falhas/concorrência. Uma sincronização pode repor o valor remoto; as alterações locais não chegam a outro dispositivo. |
| Importante | Eliminação de aluno, cadeira, avaliações, docentes, faltas e inscrições usam vários caminhos com escrita otimista ou erros ignorados. Notas, faltas e inscrições são arrays/objetos completos por aluno, sujeitos a sobreposição entre dispositivos. | **Pendente:** confirmação de cada operação, transações para alterações relacionadas e controlo de concorrência. A proteção nova do arquivo não é uma garantia para estes outros fluxos. |
| Importante | `files.subject_id` e `file_requests.subject_id` não têm FK no setup; apagar cadeira não persiste toda a limpeza de inscrições/notas/faltas. | **Pendente:** analisar dados existentes antes de acrescentar integridade referencial e limpeza transacional. Os dois demos reais já estão órfãos de cadeira; não foram corrigidos nem eliminados automaticamente. |
| Importante | Ficheiros e fotografias são Base64; leituras completas e Realtime recarregam todo o conteúdo. Não existe limite de upload no arquivo nem uso de Storage. | **Pendente:** acordar limite de tamanho e, se necessário, migrar conteúdos para Storage com política e eliminação coerentes. Não foi imposto um limite arbitrário nem alterado o armazenamento de dados existentes. |
| Menor | `openPdfFile`/`downloadPdfFile` tratam URLs externas como documentos de demonstração; objetos Blob de pré-visualização não são revogados. | **Pendente:** abrir apenas URLs válidas, controlar tipos ativos e libertar URLs de objetos. Os dois registos reais analisados são Base64, pelo que esta falha não explica o seu reaparecimento. |
| Menor | Tailwind em CDN emite aviso de produção; dependências externas não estão fixadas a versões exatas. O viewport impede zoom. | **Pendente:** preparar recursos CSS locais/versões fixas e rever acessibilidade numa alteração própria, validando que a aparência se mantém. As dependências externas verificadas responderam HTTP 200. |
| Importante | `supabase_setup.sql` é um setup antigo, não uma migração segura: recria políticas abertas, repõe credencial/role de administrador e volta a adicionar tabelas à publicação sem verificar adesão existente. | **Pendente:** substituir por migrations revisadas. Não executar o setup para aplicar estas correções; o arquivo corrigido não exige alteração de schema. |

## Ficheiros alterados/adicionados

- `index.html`: alterações limitadas ao JavaScript descrito acima. O HTML/CSS estático ficou igual.
- `tests/archive.test.cjs`: 28 testes automáticos do JavaScript real da página, sem rede nem dependências externas.
- `tests/browser-smoke.cjs`: execução em Chrome com Playwright, servidor local e todas as chamadas Supabase intercetadas; comparação com o código original e verificações da interface. Usa como referência fixa o commit remoto `8846dd0d57942158d77b66986194fde0a6c1f3da`, cujo HTML coincide com o original da auditoria, para continuar a funcionar depois de novos commits. `CIVIL_BASELINE_REF` permite escolher outra referência de teste.
- `supabase_audit_readonly.sql`: consultas complementares para o SQL Editor, dentro de uma transação READ ONLY terminada com ROLLBACK. Não foi executado remotamente.
- `AUDITORIA.md`: este relatório.

## Testes e evidência

`node --test tests/archive.test.cjs`: **28/28 testes aprovados**.

Cobertura: base vazia, cache antiga, último ficheiro, reinicialização com cache e sem cache, mudança de sessão simulada, execução do código após nova carga, erro RLS explícito, zero linhas eliminadas, falha de rede, ausência de Supabase, cliques repetidos, leitura anterior ao DELETE, cancelamento próprio e bloqueio de pedido alheio, recusa, upload admin/aluno, FileReader, falha de INSERT, quota de cache, 1201 registos, escape do conteúdo do arquivo, conflito de conta com cache antiga, confirmação antes de criar sessão local e falha parcial de inscrições.

Chrome/Playwright: **sem erros JavaScript**, DELETE e upload através dos botões reais da página, atualização de página após eliminar o último ficheiro, e DELETE simulado sem permissão. Código antigo reproduz a reinserção; código corrigido mantém listas vazias.

Comparação visual com dados de teste iguais: **PNG antes/depois idêntico** em 1440×1000 e 390×844. Sem overflow horizontal nos dois tamanhos; capturas também inspecionadas visualmente. As capturas ficam na pasta temporária `civil67-audit-screenshots`; o teste aceita `CIVIL_TEST_OUTPUT` para escolher outra pasta. O teste de navegador requer Playwright e Chrome; `CIVIL_CHROME_PATH` permite indicar outro executável.

Os avisos observados foram o aviso preexistente do Tailwind e os avisos esperados dos testes que bloquearam Realtime e simularam DELETE sem confirmação. A subscrição Realtime remota não foi validada com eventos reais.

Não existe etapa de build neste projeto. A sintaxe do JavaScript foi validada e os testes executaram o próprio script da página. O cenário “novo deploy” foi representado pela carga do código corrigido numa nova instância; **não se realizou um deploy real, nem login/logout de contas de produção, nem teste num dispositivo físico adicional**.

## Acesso e passos que faltam

1. **Publicação:** aplicar a alteração de `index.html` através do GitHub/Vercel e verificar o HTML servido no domínio. Não há novas variáveis de ambiente, buckets ou tabelas obrigatórias para esta correção.
2. **Clientes antigos:** pedir atualização das abas já abertas. Uma aba que ainda execute o código antigo conserva a capacidade de reinserir demos. Sem impedir essa escrita no servidor, um deploy não revoga JavaScript já carregado; corrigir autenticação/RLS e rever as políticas de escrita é necessário para proteção contra clientes antigos ou adulterados.
3. **Validação real:** após publicação, utilizar um documento claramente identificado como teste, confirmar a sua criação, eliminá-lo e verificar ausência na tabela, após refresh, logout/login e num segundo navegador. Não usar documentos reais para validar DELETE. Se o DELETE devolver zero linhas, investigar SELECT/DELETE nas políticas e o registo específico, sem alargar acesso anónimo.
4. **Supabase:** acesso autenticado ao dashboard/SQL Editor para examinar RLS, grants, triggers, funções, publicação Realtime, buckets e logs de API/Postgres. O script de leitura fornecido ajuda nessa inspeção. Para executar a migração de segurança serão ainda necessários acesso de gestão de Auth e um plano de migração/recuperação das contas, mantendo IDs e dados relacionados sempre que possível.
5. **Vercel/GitHub:** sessão autenticada ou CLI já configurada para verificar projeto ligado, deploy/preview e logs, e publicar a alteração quando pretendido. Não foi testado acesso de escrita a estes serviços.
6. **Credenciais:** não enviar passwords, tokens ou chaves privadas no chat. A correção atual usa a URL e a chave pública existentes. Uma eventual `SUPABASE_SERVICE_ROLE_KEY` só deverá existir no ambiente seguro de um backend que venha a ser preparado; não é necessária para estes testes nem deve ser colocada no frontend.

A remoção da inicialização automática não elimina dados remotos. Uma cache local deixa de ser uma fonte para repovoar a base; documentos que nunca chegaram à nuvem terão de ser recuperados a partir do navegador que os conserva, antes de limpar essa cache. A migração de autenticação, alterações de schema e limpeza de dados existentes ficaram por aplicar devido ao seu impacto no funcionamento atual.

Referências técnicas: a API permite obter os registos eliminados encadeando `select()` e exige inspeção do erro devolvido ([Supabase — DELETE](https://supabase.com/docs/reference/javascript/delete)); as políticas e os grants devem ser definidos com a identidade autenticada para proteger acesso aos dados ([Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)).
