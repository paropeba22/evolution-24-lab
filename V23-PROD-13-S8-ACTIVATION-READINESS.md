# NEXI S8 — preparação de ativação OVH

**S8 CONDITIONAL — EXPLICIT PREDEPLOY REQUIREMENTS**

Preparação concluída; nenhuma operação de deploy autorizada por este documento.
Sem laboratório, build local/CI, PostgreSQL/Redis descartável, novas baterias de
fixtures, sessão WhatsApp real, migration real, reinício ou alteração EasyPanel.

## 1. Referências e prontidão

Confirmadas por `git ls-remote` e grafo Git:

| Componente | Base S7 | Parent |
| --- | --- | --- |
| Evolution | 73ce9bb163b76d6633d04d0cb20f3465c8742d4b | 9c7b90d135bbd397dd945ef4fe938761aa50c367 |
| APP | 05fc828d70fcbf8f8d439515cd4c11fa10a16d23 | 9bf54ed160f773a636d685863824c9a17f4c325b |

Evolution S8: branch `candidate/v23-prod-13-s8-activation-readiness`, derivada
diretamente da S7. SHA remoto na entrega. APP permanece exatamente na S7;
nenhuma branch APP S8 é necessária. Não promover branches canônicas.

APP: modelo NexiAttendanceWork, callbacks após commit, WorkQueue e o método real
DatabaseGuard.verify_work_queue! existem e correspondem à migration S5. Capsules
Sidekiq 7.3.1 particionam o orçamento existente. Endpoints ingress.observed,
ingress.reconcile, ingress.correlated, ingress.profile e receipts permanecem.
Boot produtivo, schema instalado e capacidade real não estão comprovados.

Evolution: patchers S1–S6, SDK instrumentado, captura após decrypt, journal,
materialização R1, seis contratos R2, download/cache S6 e fronteira de envio
permanecem. Build/imagem final e boot produtivo não estão comprovados.

Os resultados S7 são históricos: 56/56 + dez regressões + 27 testes S6 passaram;
não foram reexecutados nesta missão. Os 15 erros APP continuam **FAIL de fixture
legado**, não PASS. O double não oferece o contrato de work S5. A revisão do
código produtivo não encontrou ausência desse contrato; isso não certifica seu
estado na OVH. A alternativa decidida pelo proprietário é verificar o schema,
os guards e o fluxo real sob autorização futura, sem outra missão de fixtures.

## 2. Correções e revisão S8

Problema concreto: o ENTRYPOINT S7 executava deploy_database.sh em toda partida,
aplicando migrations antes do runtime. Isso acoplava restart ao DDL e impedia
separar as etapas operacionais exigidas. O script upstream também contém echo de
DATABASE_URL quando essa variável está definida; ele não deve ser usado para a
operação coordenada.

- `nexi-start.sh` agora seleciona o bundle e faz exec direto do mesmo Node/flag
  usados em start:prod, preservando npm_package_version lido do mesmo package.json.
  Não aplica migrations nem gera client. Sinais chegam ao
  processo Node. Argumentos extras são recusados; Dockerfile limpa CMD herdado.
- Migrations ficam em tarefa única explícita, fora do startup, somente depois de
  autorização. A operação documentada usa npm run db:deploy diretamente.
- `assert-ingress-runtime.mjs` acrescenta gates no builder e no estágio final:
  SDK 1.1.17 instrumentado por hash, Axios 0.27.2 realmente resolvido no pacote
  aninhado, helpers externos e seis modelos/checkpoints no Prisma dos três
  bundles. Ausência ou divergência recusa a imagem.
- Guards anteriores, fingerprints e patchers não foram removidos ou alterados.
  Sem mudanças em WriterBarrier, HMAC, grants, PN/LID, CAS, leases, receipts ou
  semântica de outcome_unknown. Nenhuma migration nova ou alterada.

Verificações S8 executadas: sintaxe Node do gate, sh -n do startup, metadados e
hashes do SDK já disponível da S7, resolução Axios, leitura dos modelos nos três
schemas já disponíveis, rejeição de campo obrigatório/bundles ausentes,
revisão do comando sem DDL e diff. Nenhuma aplicação/SDK HTTP foi acionada.
O gate completo ainda depende do build real; não recebeu PASS de imagem.

**Mudança operacional obrigatória:** a imagem S8 não migra ao reiniciar. O schema
deve ser aplicado separadamente antes de sua ativação. Limpar qualquer comando
antigo de startup no EasyPanel que acrescente argumentos/migrations. Sem essa
adequação, haverá recusa de partida; não improvisar voltando ao entrypoint antigo.

## 3. Inventário real — pendente

**Lembrete do proprietário:** o dono desta conversa decidiu expressamente deixar
o READ-ONLY da OVH para outra conversa, especificamente autorizada para isso.
O inventário real permanece pendente por essa decisão. Nenhuma inspeção ou
tentativa de conexão OVH foi executada aqui. Cliente SSH/known_hosts locais não
comprovam acesso nem autorização; nenhuma credencial de outro alvo foi usada.

Preencher `ops/s8-target-inventory.template.json` mediante inspeção READ-ONLY
autorizada: IDs de projeto/serviços/containers, imagens/digests/SHAs implantados,
réplicas, restart, comandos efetivos, DB/provider/schema, migrations aplicadas,
Redis/DB lógico, volumes, rotas HTTPS, instâncias e ownership, processos antigos,
CPU/RAM/disco e orçamento dos builds, conexões, backups e verificação disponível.
Nada disso deve ser inferido de relatórios antigos ou do compose de exemplo.

Comandos preparados para uma sessão futura de inspeção autorizada, com IDs
conferidos. Não executados na S8:

```sh
docker inspect --type container --format 'id={{.Id}} image={{.Image}} status={{.State.Status}} started={{.State.StartedAt}} restart={{.HostConfig.RestartPolicy.Name}}' "$NEXI_APP_WEB_ID" "$NEXI_APP_WORKER_ID" "$NEXI_EVOLUTION_ID"
docker inspect --type container --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}' "$NEXI_APP_WEB_ID" "$NEXI_EVOLUTION_ID"
docker image inspect --format 'id={{.Id}} digests={{json .RepoDigests}}' "$NEXI_APP_IMAGE" "$NEXI_EVOLUTION_IMAGE"
docker stats --no-stream "$NEXI_APP_WEB_ID" "$NEXI_APP_WORKER_ID" "$NEXI_EVOLUTION_ID"
df -h
free -m
```

Se Swarm for usado, conferir também réplicas desejadas, tasks antigas e política
de atualização/restart dos serviços NEXI. Não executar update/scale/restart nesta
inspeção. Não imprimir Config.Env, DSNs, comandos com secrets, dump de Redis,
credenciais, QR, mensagens ou dados pessoais. Inspecionar somente os alvos NEXI
confirmados; nunca o endpoint 181.225.170.5:8081.

SQLs de catálogo preparados em ops/s8-*-catalog.sql são READ ONLY e não foram
executados. Usar apenas o arquivo do banco/provider confirmado. Ausência de
schema_migrations ou _prisma_migrations interrompe o plano; não inicializar um
banco para fazer a inspeção passar. Não chamar endpoints de connect, bootstrap,
writer_probe, grant, retry ou envio como se fossem healthchecks READ-ONLY.

## 4. Schema: ordem definida e pendências ainda desconhecidas

`ops/s8-migration-manifest.json` contém 32 arquivos APP de dependência e o
histórico Prisma da imagem: 70 PostgreSQL, 32 MySQL, após overlays NEXI. Contém
SHA256 com LF e origem; applied_on_ovh é UNKNOWN. psql_bouncer usa migrations
PostgreSQL. O inventário não é autorização para aplicar tudo.

Antes de qualquer aprovação de DDL, comparar o catálogo real ao checkout/imagem:
histórico Chatwoot/ISP anterior, managed_channels/bindings/events, ledger
WhatsApp, Groups, identity/outbound foundations, guards, canonical version,
receipts, criação atômica, authority transport, ownership humano/automação,
dispatch, invalidations, perfis autenticados e conversation successors.
Prisma: incluir histórico upstream e as migrations NEXI anteriores ao ingresso.
Migration aplicada com checksum divergente ou failed/unfinished bloqueia avanço.
Versão Rails aplicada não comprova integridade: conferir triggers/fingerprints.
Pendências fora desse escopo exigem revisão específica; nunca usar migrate-all
para instalar alterações ERP ou outras funcionalidades incidentalmente.

Ordem dos incrementos finais, após dependências anteriores aprovadas:

| Ordem | Migration | Risco/condição |
| --- | --- | --- |
| APP 1 | 20261015000000_create_channel_whatsapp_ingress_admissions | Tabela, FKs/índices, trigger; locks de catálogo/parents. Down implícito destrói admissões: proibido após uso |
| APP 2 | 20261016000000_add_attendance_durable_work | Tabela/índice parcial, CHECK, funções/triggers; down explicitamente irreversível |
| APP 3 | 20261016000001_index_attendance_receipt_correlation | CONCURRENTLY, fora de transação global; pode esperar transações longas e deixar índice inválido após falha |
| Evolution 1 | 20261015000000_nexi_durable_ingress | Cria scopes/lanes/journal e índices únicos |
| Evolution 2 | 20261015000001_nexi_ingress_secondary | ALTER journal/scope, effects/lanes, índices; lock exclusivo breve pode aguardar transação antiga |
| Evolution 3 | 20261015000002_nexi_ingress_contact_cache | ALTER effects e cache/índices PN/LID; respeitar provider |

Migrations antigas de guards podem fazer ALTER TABLE, validações e índices não
concorrentes em tabelas populadas. O tempo/lock não está estimado sem volumes e
atividade reais. Não desabilitar triggers ou CAS para abreviar manutenção.

Para CONCURRENTLY: analisar transações antigas, definir orçamento de lock e
statement no processo migrador, conferir indisvalid e indisready. Se o índice
existe inválido, não repetir cegamente nem remover automaticamente. Preparar
reparo nominal autorizado; se existe válido mas a versão não foi registrada,
resolver o estado da migration por procedimento revisto, sem alterar o ledger
à mão. Nunca executar down/reset como solução de atualização.

## 5. Recursos e configuração necessários

- APP: Ruby 3.4.4/Bundler 2.5.16, gems locked, mesma imagem para web e workers;
  preservar SECRET_KEY_BASE, chaves ActiveRecord Encryption e tokens existentes.
- Sidekiq total >=5, <= pool PostgreSQL efetivo. Com total 10: preparação 2,
  receipts/correlação 1, recovery 1, default 6. CLI/capsules customizadas não
  podem ampliar o orçamento. Somar réplicas, web, Evolution e conexões de migração.
  Conferir pools Redis e cron NexiAttendanceWorkRecoveryJob em attendance_recovery.
- APP: NEXI_CHANNELS_CHATWOOT_URL e NEXI_CHANNELS_EVOLUTION_PUBLIC_URL HTTPS na raiz;
  NEXI_CHANNELS_EVENT_URL termina em /webhooks/nexi/channels/evolution. Usuário
  de serviço configurado, token válido e membership administrador no account.
- NEXI_CHANNELS_EVENT_MASTER_SECRET consistente nos dois lados, >=32 bytes;
  não rotacionar durante a transição, pois autentica trabalho já persistido.
- Evolution: DATABASE_PROVIDER explícito e DATABASE_CONNECTION_URI correto,
  privilégios compatíveis com os guards, Redis/namespace e persistência de sessão
  confirmados. MySQL deve satisfazer o storage guard existente; não presumir que
  MariaDB genérico oferece as mesmas constraints/semântica. Validar psql_bouncer
  separadamente quanto a pooling/estado de sessão e conexão de DDL.
- Evolution: nove limites obrigatórios NEXI_ATTENDANCE_ (QUEUE_ITEMS, QUEUE_BYTES,
  APPEND_CONCURRENCY, DB_ACQUISITION_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_MS,
  DB_LOCK_TIMEOUT_MS, APPEND_DEADLINE_MS, RECOVERY_ITEMS, RECOVERY_BYTES) devem
  satisfazer settings(): aquisição e statement menores que deadline, lock <=
  statement e concorrência <= itens. Não inventar valores sem orçamento real.
- S6 tem defaults limitados de download: 30 s, 64 MiB, quatro globais, dois por
  socket, fila 64. Homologar política de mídia; não aumentar concorrência global
  por tentativa. Não habilitar fotos no ingresso para validar aparência.
- Relógios devem satisfazer os limites de HMAC/leases; conferir sincronização.
  Builds APP/Evolution possuem etapas com heap de até 4 GiB: executar em sequência
  no fluxo real, com orçamento que não ameace APP/BIA/DB existentes. Sem capacidade
  comprovada, NO-GO; não contratar ou alterar infraestrutura nesta missão.

## 6. Backup e limites de recuperação

Pré-condição: política existente, última execução, retenção, cobertura e
integridade verificadas. Preservar DB APP, DB Evolution, volumes de sessão,
attachments/storage, configuração/secrets pelo cofre existente e estado Redis
relevante. Se infraestrutura/volumes/Redis forem compartilhados com BIA, não
reiniciar, reconfigurar ou fazer operação global nesse serviço. Resolver o escopo
NEXI antes de qualquer ação. DB lógico Redis não prova isolamento físico.

BIA/n8n e a Evolution independente, inclusive 181.225.170.5:8081, permanecem
intocáveis: sem alteração de serviço, DB, Redis, sessão, credencial, instância
ou volume, e sem restart de seus containers. Se uma conta WhatsApp tiver sessões
simultâneas NEXI/BIA, há interação remota pelo próprio WhatsApp; isolamento de
containers não prova independência. Declarar esse vínculo e autorizar o escopo
antes de testes; preferir uma conta de teste já disponível e expressamente
designada, sem criar autoridade NEXI sobre uma sessão externa.

Após autorização específica, backups finais devem refletir um corte consistente
com os escritores NEXI parados/drenados. PostgreSQL pode usar pg_dump formato
custom via credencial já provisionada; pg_restore --list e hash validam leitura
do arquivo, não uma restauração completa. MySQL pode usar dump transacional de
InnoDB, rotinas/triggers e sem locks globais, no banco NEXI confirmado. Snapshots
de volumes/session state exigem quiescência e manifest/digest. Não inventar que
um backup é recuperável só porque há arquivo ou exit 0.

Exemplos de comandos preparados, com serviço/credenciais aprovados, não executados:

```sh
pg_dump --dbname="service=$NEXI_APP_PG_SERVICE" --format=custom --no-owner --file="$NEXI_APP_BACKUP_FILE"
pg_restore --list "$NEXI_APP_BACKUP_FILE"
sha256sum "$NEXI_APP_BACKUP_FILE"
```

Não fornecer senha/URI completa no argv ou log. Para a Evolution repetir somente
no banco/provider confirmado; não copiar volumes de uma Evolution antiga.
Não foi montado ambiente de restore nesta missão. Se não existir evidência
suficiente da recuperação exigida, registrar essa lacuna como NO-GO pré-deploy.

Depois de qualquer avanço criptográfico, snapshot Signal antigo não pode ser
restaurado como rollback de código. Schema/admissões/grants/UNKNOWN novos também
podem impedir retorno de versão. A estratégia é contenção, preservação e correção
para a frente; não apagar journal ou reenviar o que ficou incerto.

## 7. Procedimento coordenado futuro — cada avanço exige seus gates

**Fase 0 — identidade e escopo.** Inventário READ-ONLY completo; confirmar IDs
NEXI, bancos, volumes, sessões, backups e fronteira BIA. Registrar as imagens
atuais e candidatas e pendências efetivas. Nenhum alvo vem de nome presumido.

**Fase 1 — build real, sem ativação.** Sob autorização própria, construir no fluxo
EasyPanel/registry real, sem atualizar serviço automaticamente. Evolution usa
Dockerfile da raiz, commit S8; APP usa docker/Dockerfile, commit S7. Informar
GIT_SHA APP no build e guardar digest imutável. Não usar compose de exemplo ou
chatwoot:latest. Não fornecer DSNs/secrets produtivos como argumentos de build.
Conferir que build não aciona auto-update, release hook ou o Procfile APP:
seu comando release chama db:chatwoot_prepare e não pode antecipar DDL.
Conferir todos os gates do builder E da imagem final e os três
providers, SDK/Axios, libsignal/Baileys/helpers, Prisma e dependências. Sem gate
aprovado, não ativar. Build ainda não executado.

Inspeção de artefato da imagem construída pode rodar com network=none e entrypoint
explicitamente substituído, sem env/volumes produtivos e sem iniciar aplicação.
É leitura do artefato definitivo, não ambiente paralelo NEXI. Exemplos futuros:

```sh
docker run --rm --network none --entrypoint node "$NEXI_EVOLUTION_IMAGE_DIGEST" /evolution/assert-ingress-runtime.mjs /evolution
docker run --rm --network none --entrypoint node "$NEXI_EVOLUTION_IMAGE_DIGEST" /tmp/assert-baileys-transport-runtime.mjs /evolution
```

**Fase 2 — janela e drenagem.** Congelar novas liberações pelo mecanismo de
manutenção/barrier existente, somente com autorização. Não ativar WriterBarrier.
Suspender entradas mutantes NEXI e automações de forma explícita; não responder
200 para mensagem descartada. Manter interface de consulta quando o mecanismo
atual permitir; caso não haja isolamento de escrita confiável, breve manutenção
é preferível a coexistência insegura. Não inventar flag de pausa inexistente.

Drenar jobs em andamento; parar TODOS os processos/cron NEXI que possam executar
o protocolo antigo, incluindo réplicas web que originem callbacks/autorizações e
workers fora da fila nominal. Stop/update de um serviço gerenciado precisa
considerar o controller que recria tasks; matar um container isolado não garante
ausência de escritor. Conferir zero tasks antigas efetivas antes do runtime novo.
Se não houver drenagem concluível, identificar a operação e persistência antes
de interromper; incerteza não vira sucesso. Fazer backup final do corte.

Journal só protege trabalho já admitido duravelmente. Não há atomicidade Signal/
PostgreSQL R0/R1. Se o runtime antigo ainda mantém mensagens apenas em buffer,
esvaziá-lo e comprovar checkpoints antes de parar; não prometer redelivery ou
perda zero para mensagem recebida/descriptografada sem journal. Janela/resíduo
precisam ser explicitados na autorização operacional.

**Fase 3 — APP schema.** Um único migrador da imagem APP aprovada, sem worker e
sem liberação física. Aplicar somente a sequência de versões efetivamente
pendentes revisada, dependências antes dos três incrementos finais. Não envolver
o índice CONCURRENTLY em uma transação global. Exemplos dentro da tarefa de
manutenção NEXI já identificada (não no web/worker antigo):

```sh
RAILS_ENV=production bundle exec rails db:migrate:status
RAILS_ENV=production POSTGRES_STATEMENT_TIMEOUT=600s PGOPTIONS='-c lock_timeout=5s' bundle exec rails db:migrate:up VERSION=20261015000000
RAILS_ENV=production POSTGRES_STATEMENT_TIMEOUT=600s PGOPTIONS='-c lock_timeout=5s' bundle exec rails db:migrate:up VERSION=20261016000000
RAILS_ENV=production POSTGRES_STATEMENT_TIMEOUT=600s PGOPTIONS='-c lock_timeout=5s' bundle exec rails db:migrate:up VERSION=20261016000001
```

600 s e 5 s são tetos propostos do processo migrador, sujeitos ao orçamento
aprovado; não configurações permanentes. Se há dependência anterior pendente,
esses comandos ainda NÃO são a lista executável. Em timeout, parar e inspecionar
estado; não repetir automaticamente. Nenhuma execução ocorreu na S8.

**Fase 4 — APP compatível.** Subir web S7 com escritas/liberações ainda contidas;
validar boot, imagem/SHA, encryption e endpoints. Conferir guards no banco real
em transação READ ONLY, sem desabilitar nenhum deles:

```sh
RAILS_ENV=production bundle exec rails runner 'ApplicationRecord.transaction do; ApplicationRecord.connection.execute("SET TRANSACTION READ ONLY"); Platform::Attendance::DatabaseGuard.verify_authority_transport!; Platform::Attendance::DatabaseGuard.verify_work_queue!; raise ActiveRecord::Rollback; end; puts "attendance guards verified"'
```

Esse comando inicializa Rails e fica reservado à fase autorizada, não à inspeção
S8. Nesta fase manter Sidekiq parado. Conferir configuração de capsules/conexões/
cron antes da partida posterior. Não misturar leases. Backfill respeita due_at/
lease antigo; aguardar expiração legítima, sem zerar tokens. Confirmar ausência
das réplicas antigas antes de enqueues novos.

**Fase 5 — Evolution schema.** Com runtime antigo NEXI parado e banco comprovado,
uma única tarefa da imagem S8, env/secret existentes do NEXI e entrypoint de
manutenção explícito: `npm run db:deploy`. Esse comando aplica TODO o histórico
Prisma pendente do provider; só pode ser usado após aprovação da lista completa
e checksums. Não executar Docker/scripts/deploy_database.sh nem gerar/mudar
schema em processo paralelo. Não usar db:migrate:dev, db:push ou migrate reset.
Prisma client já pertence ao bundle gerado no build; não regenerá-lo no startup.
Conferir _prisma_migrations, ausência de failed/unfinished e os seis modelos.

**Fase 6 — Evolution runtime.** Subir uma réplica escritora NEXI, comando da
imagem S8 sem override antigo. Restaurar somente o estado corrente preservado,
nunca um snapshot Signal anterior. Conferir provider/bundle, inicialização
Prisma/Redis, socket owner, epoch/session, logs de storage e retomada dos journals.
Não chamar connect/logout/repair/retry como teste de saúde. Não criar instância
ou parear QR sem autorização específica. Sessão BIA permanece fora do plano.

**Fase 7 — liberação controlada.** Somente com autorização explícita de autoridade
e contas de teste, iniciar workers S5, conferir capsules/cron efetivos e reabrir
o processamento NEXI, observando a instância/conversa designada. A partida de
workers pode retomar backlog legitimamente autorizado e jobs de ativação:
não é um healthcheck. Inventariar esse backlog e confirmar que a contenção
existente impede liberações fora do escopo autorizado. Se isso não puder ser
comprovado, NO-GO para abrir workers; não inventar uma flag de isolamento.
Preservar mesmos Message IDs/reservas/tentativas; readback/reconcile
para incertezas, sem nova criação ou envio físico automático. Ampliação ocorre
somente após os critérios da seção seguinte. Não considerar HTTP 200 como ACK.

## 8. Roteiro operacional curto após autorização

1. Saúde: web/UI, Sidekiq/capsules, Evolution/provider e DB/Redis sem erro; nenhum
   escritor NEXI antigo, nenhuma sessão/volume da BIA selecionada.
2. Recebimento: titular autorizado envia três mensagens numeradas na conversa
   de teste. Registrar IDs e tempos: transporte -> journal -> worker -> APP ->
   Message ID -> correlação -> UI. Exigir uma criação por ID, mesma identidade
   PN/LID e nome observado, ordem, checkpoints e ausência de bloqueio secundário
   da materialização. Sem usar um contato de cliente como fixture.
3. Independência: repetir com segunda conversa/conta expressamente autorizada,
   observando fila e limites; não provocar falha de serviço real para simular carga.
4. Envio, **somente sob aprovação específica de envio**: atendente autorizado
   envia uma mensagem de teste, rastreando intenção -> attempt/reservation ->
   prepare/proof -> release/consume -> dispatch. Exigir uma fronteira física e
   identidade exata. Se houver resposta incerta, parar; não clicar reenviar.
5. Receipts: registrar evidência autenticada e timestamps reais. SERVER_ACK,
   DELIVERY_ACK e READ só aparecem quando observados. Receipt -> persistência ->
   wake -> reducer -> UI sem depender exclusivamente do cron. Se a conta não
   fornecer READ, registrar ausência; não fabricar receipt.
6. Medir durações individuais de WhatsApp -> UI, intenção -> início do dispatch
   e receipt -> UI, com relógios correlacionados. Amostra inicial de 3–5 eventos:
   listar tempos e máximo, sem p95/p99. Para campanha depois autorizada, propor
   >=100 amostras para p50/p95 e >=1000 para p99, com n, método e falhas; ainda
   avaliar estabilidade/representatividade. Não criar volume artificial de envios
   para obter percentis. Meta de 2–3 s não foi demonstrada nem prometida.

## 9. GO / NO-GO e contenção

GO para cada fase apenas quando: alvo/inventário verificado; backups íntegros
com procedimento de recuperação conhecido; recursos/conexões suficientes; build
final e hashes aprovados; migrations sem drift; guards ativos; keys/URLs e
membership preservados; escritores antigos ausentes; contenção vigente; contas
e ações de teste autorizadas. Aprovação de build não autoriza DDL ou envio.

NO-GO imediato: banco/volume/session ownership ambíguo ou compartilhamento BIA
sem escopo seguro; dois writers; HMAC/identity/fencing divergentes; perda de
persistência; migration/checksum/guard inválido; índice inválido; boot/capacity
Sidekiq recusado; incompatibilidade Prisma/module; fila sem progresso, duplicação,
UNKNOWN transformado em retransmissão, receipt fictício ou pressão que ameace
serviços existentes. Não prosseguir esperando que o próximo restart corrija.

Ao detectar falha: conter novas liberações/entradas mutantes NEXI, preservar
trabalho e evidências, parar apenas processos NEXI conforme plano autorizado e
inspecionar checkpoints. Não mudar para Evolution genérica/antiga, recriar IDs,
zerar leases, apagar UNKNOWN, desabilitar guard, ativar automação ou restaurar
credenciais antigas. Código anterior só pode voltar se houver prova de que
entende os estados/schema já persistidos. Caso contrário, manter contenção e
corrigir para a frente. Backup Signal é evidência, não botão de rollback.

## 10. Autorizações ainda necessárias

Separadamente: acesso READ-ONLY OVH identificado; build real sem auto-update;
backup/coleta de dados; janela/pausa/drenagem; DDL da lista pendente aprovada;
atualização/restart NEXI e ajustes necessários do startup; abertura de autoridade
WriterBarrier quando cabível; contatos/contas e envio de teste; expansão gradual.
Nenhuma dessas ações operacionais foi realizada ou implicitamente autorizada
pela S8. Não criar laboratório para cumprir os gates: executá-los no fluxo real
somente depois da autorização correspondente.
