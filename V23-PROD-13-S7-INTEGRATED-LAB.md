# NEXI V23-PROD-13-S7 — evidência local e bloqueios de certificação

Veredito: **S7 PARTIAL — SPECIFIC BLOCKERS**.

As sete falhas Evolution foram resolvidas nos fixtures, sem mudar a segurança de
produção. O laboratório necessário para certificar build e integração real não
está disponível neste host. Nenhuma evidência abaixo equivale a certificação de
runtime, latência WhatsApp ou aprovação para deploy.

## Referências e isolamento

Conferidas com `git ls-remote` e o grafo Git:

- Evolution S6: `9c7b90d135bbd397dd945ef4fe938761aa50c367`, parent
  `17d86efeadb6de74685ac3d1490415da908d88d9`.
- APP S5: `9bf54ed160f773a636d685863824c9a17f4c325b`, parent
  `a1fa50de47e231453250f6b0445beda941948da4`.
- Cada repositório recebeu seu worktree e branch
  `candidate/v23-prod-13-s7-integrated-certification`, diretamente da respectiva
  baseline. SHAs publicados constam da entrega após conferência remota.

Preflight: Docker/Podman ausentes do PATH e dos caminhos usuais; nenhum serviço
Docker/Podman/PostgreSQL/Redis identificado; WSL declara que não está instalado.
Host Windows com aproximadamente 3,8 GiB de RAM total, 156–324 MiB livres nas
amostras e aproximadamente 11 GiB de disco livre. Não foi instalado Docker/WSL,
criado serviço persistente, reiniciado processo existente nem usado daemon remoto.

Node 24.19.0; Ruby disponível 3.4.10, enquanto o projeto exige 3.4.4.
`bundle check` recusa essa divergência. Não se alterou o pin da aplicação.
Os testes Ruby abaixo usam diretamente gems locais de versões determinadas,
sem Bundler/Rails boot. Gems faltantes foram instalados somente no scratch
ignorado S7. Uma resolução inicial de dependências foi interrompida pelo limite
de 90 s; a instalação seguinte usou cinco versões explícitas, sem dependências
automáticas. Não se instalou dependência de produção.

Os testes de autoridade têm trap de rede. Transporte S6 usa loopback e respostas
controladas. PGlite usa banco em memória; a conexão pg do fixture APP é somente
127.0.0.1, porta efêmera escolhida pelo próprio processo. Não se lê configuração
de conexão Rails/.env para esses bancos. Não houve acesso à produção, WhatsApp,
VPS, EasyPanel, BIA/n8n ou envio a serviços reais.

## Resultado por etapa

| Etapa | Estado | Evidência e limite |
| --- | --- | --- |
| A: reprodução Evolution | PASS — reprodução | 56 testes: 49 PASS, sete falhas iguais às relatadas |
| A: duas suítes Evolution completas corrigidas | PASS — fixture | 56/56, sem skips; CAS e fronteira lexical reais, armazenamento/socket simulados |
| A: regressões negativas adicionais | PASS — fixture | 10/10; signatures, ownership, provider, epoch, rollback e writer sem capability |
| B: composição S1–S6 | PASS — fonte/fixture | Replay; R1 antes de S6 e R2 depois; fingerprints aceitos |
| B: testes de transporte | PASS — transporte local/fixture | 27/27; fetch/streams reais em loopback e transportes adversos injetados |
| B: imagem final PostgreSQL | BLOCKED | Docker/daemon Linux ausentes; sem imagem construída |
| B: imagem final MySQL | BLOCKED | Mesmo bloqueio; client, bundle e runtime final não executados |
| B: imagem final psql_bouncer | BLOCKED | Mesmo bloqueio; nenhum PgBouncer em execução |
| B: SDK/helpers/Prisma/bundles na imagem final | BLOCKED | Source replay não comprova artefato final; gates de ausência foram exercitados, sem builder real |
| C: migrations Evolution PostgreSQL | PASS — SQL WASM | Três arquivos sem alterações aplicados em ordem; cinco grupos de verificações |
| C: migrations APP S4/S5 | PASS — schema parcial WASM | Três migrations reais em ordem; quatro testes/14 asserções, parents mínimos |
| C: índice receipts CONCURRENTLY | BLOCKED | Fixture remove somente CONCURRENTLY do DDL gerado; construção concorrente nativa NÃO testada |
| C: fila/lease/reducer S5 | PASS — AR/PG WASM fixture | 25 cenários, 96 asserções; autoridade histórica é boundary substituído |
| C: capsules Sidekiq | PASS — configuração fixture | Config real Sidekiq 7.3.1; nenhum worker/Redis ativo |
| C: boot Rails/Sidekiq, schema completo e orçamento agregado | BLOCKED | Sem serviços nativos; Ruby incompatível com Gemfile; aplicação não inicializada |
| D: release APP | PASS — contrato unitário | Quatro testes/23 asserções, envelopes/digests canônicos; não é HTTP entre aplicações |
| D: autenticação receipts | PASS — contrato unitário | Sete testes/19 asserções; persistência substituída nesse teste |
| D: conformance receipts APP/Evolution | PASS — golden fixture | Sete fixtures reconhecidos pelo produtor Evolution atual |
| D: projeção de perfil APP R2 | PASS — fixture | Método real, objetos de persistência substituídos, IDs preservados |
| D: ingresso/envio/receipts entre aplicações reais | BLOCKED | Rails, Evolution runtime, bancos e workers não iniciados |
| E: R2 contratos | PASS — fonte/fixture limitado | Dez grupos do verifier, com execução de adapter webhook e dispatcher controlados |
| E: seis integrações em runtime APP/Evolution | BLOCKED | Não foram executadas contra aplicações/destinos de laboratório completos |
| F: testes reais de carga, crash e duas conexões PostgreSQL | BLOCKED | Não houve backends PostgreSQL independentes ou workers reais |
| G: p50/p95/p99 do percurso integrado | NOT TESTED | Nenhum percurso integrado executado; sem amostras para percentis |
| Runtime WhatsApp real | NOT TESTED | Proibido nesta etapa |

**Falha adicional registrada:** `authority_transport_test.rb` mais
`automation_fence_test.rb` na APP: **FAIL — fixture legado**, 41 casos,
155 asserções, 26 PASS e 15 erros. Todos os erros restantes são nos casos de
`AttendancePreparationOrchestratorTest`, por ausência de
`DatabaseGuard.verify_work_queue!` no double antigo. Na baseline, as mesmas duas
suítes nem inicializam, por ausência do import de WorkQueue.

Não foi criado um `verify_work_queue!` permissivo, removido guard ou simulado
lease válido para esconder esses erros. Esse fixture precisa representar a fila
S5, com `NexiAttendanceWork`, relógio/transações e guards reais, antes de receber
PASS. O fixture S5 separado cobre scheduling/reducer reais com parents mínimos,
mas não substitui esses 15 cenários de autoridade histórica completa.

## Correções efetivas

1. `attendance-socket-test-support.cjs` usa configure, instalação Groups,
   trackSocket, lifecycle, refreshContext e captura reais. A resposta APP de
   teste verifica o HMAC do pedido e assina o contexto com segredo exclusivamente
   sintético, nonce e namespace originais. A assinatura pública de conta é gerada
   localmente e verificada pelo libsignal real, com protobuf/prefixos rc13.
   Não se substitui verificador por função que sempre retorna true.
2. Testes positivos agora chegam ao CAS. Casos negativos são preparados com um
   socket legítimo antes de invalidar sessão/contexto/storage, evitando sucesso
   aparente por rejeição prematura de registro ausente.
3. O double transacional Evolution permitia rollback de um concorrente apagar
   commit de outro. O fixture possui uma linha: a exclusão agora cobre snapshot,
   execução, commit/rollback e liberação dessa linha. Há teste específico para o
   rollback não apagar um commit. Isto modela FOR UPDATE, não prova sua execução
   entre bancos reais.
4. O teste concorrente conserva a exigência de exatamente uma escrita simulada
   e informa os resultados dos dois concorrentes em caso de falha.
5. Dockerfile copia os novos helpers de teste usados pelas suítes do builder.
   Nenhum helper de teste foi acrescentado ao runtime final.
6. APP: dois imports reais ausentes no suporte de testes foram adicionados:
   OrchestrationDiagnostics e WorkQueue. Não houve alteração de serviço/model
   produtivo, migration ou relaxamento de guard.

Nenhum arquivo runtime NEXI/Baileys foi modificado na S7. WriterBarrier, HMAC,
CAS, fencing, grants, reservas, identity PN/LID e outcome_unknown continuam com
os mesmos bytes da baseline. O teste lexical comprova CAS antes da escrita
simulada, replay sem segunda escrita e ausência de SERVER_ACK por retorno local.

## Cobertura das famílias R2

| Família | Cobertura executada S7 | Runtime integrado |
| --- | --- | --- |
| message_webhook | Adapter real extraído, local/global e falha ambígua controlados | BLOCKED |
| contact_webhook | Âncoras habilitadas e contrato dispatcher compartilhado; não validado destino completo | BLOCKED |
| chat_name_webhook | Âncoras habilitadas e contrato compartilhado; sem ciclo real de contato | BLOCKED |
| chatbot | Await/debounce/fanout e isolamento de dependências em fixture; sem engine externo real | BLOCKED |
| contact_chatwoot | Âncoras/dispatcher e callback controlado; sem sincronização Chatwoot real | BLOCKED |
| contact_cache | Composição, schema e namespace exercitados; não worker Prisma completo | BLOCKED |

O replay verifica HMAC dos manifests, tentativa ambígua sem reenvio, sibling não
iniciado recuperável, callback duplicado, limites retidos até settlement e fence
de sessão. Não comprova toda combinação habilitado/desabilitado, reinício,
destino real e ordem para cada família. At-most-once attempt não foi mudado.

## Concorrência, recuperação e latência

PASS em fixtures: callback durante/liberação, wake perdido, falha simulada de
enqueue, lease expirado/substituído, receipt antes/depois da reserva, redução
sem regressão, CAS concorrente e transporte que ignora/rejeita cancelamento.

BLOCKED em runtime integrado: 1/10/50 contatos e 100 eventos; contenção entre
duas conexões PostgreSQL; reinício de processo entre journal/HTTP/checkpoint;
Redis efetivamente interrompido; Sidekiq sob filas administrativas cheias;
APP indisponível no percurso completo. Não se executaram esses cenários usando
sessões reais nem se chamou um transporte sintético de WhatsApp real.

| Percurso/etapas solicitadas | n | p50 | p95 | p99 | máximo | falhas |
| --- | --- | --- | --- | --- | --- | --- |
| Ingresso: transporte/journal/worker/APP/Chatwoot/correlação/persistência/projeção | 0 | N/A | N/A | N/A | N/A | N/A |
| Envio: intenção/preparação/prova/liberação/consumo/dispatch simulado integrado | 0 | N/A | N/A | N/A | N/A | N/A |
| Receipts: intake/persistência/wake/reducer/projeção integrados | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| Idade de fila, throughput e backpressure integrados | 0 | N/A | N/A | N/A | N/A | N/A |

Os logs possuem durações das baterias, não desses percursos. Não se inferiu
plausibilidade operacional de 2–3 s a partir delas.

## Evidência e reprodução

`fixtures/s7-local-validation.json` registra comandos, resultados, SHA256 dos
logs locais e migrations. Logs completos ficam no scratch ignorado
`.test-runtime/s7-*.log` deste worktree. Não se somam resultados unitários como
se fossem tráfego de aplicação. Não houve build ou boot oculto com o entrypoint
que aplica migrations automaticamente.

Para os 66 testes Evolution, disponibilizar o node_modules rc13 aceito:

```text
NODE_PATH=<node_modules rc13/libsignal locais> node --test --test-timeout=15000 attendance-authority.test.cjs attendance-physical-dispatch.test.cjs attendance-socket-registration.test.cjs
node verify-transport-s6.mjs <source Evolution e273b904...> <node_modules local> <SDK pristine> <SDK instalado>
S6_COMPOSED_ROOT=<root produzido> S6_DEPENDENCIES=<node_modules local> node --test --test-timeout=15000 baileys-transport-s6.test.cjs
node verify-ingress-schema-s7.mjs <PGlite 0.3.14/dist/index.js>
```

Schema APP: fornecer checkout APP, gems ActiveRecord 7.1.5.2/pg 1.6.3 e env
S5_NODE/S5_PGLITE_MODULE locais; executar
`ruby verify-app-schema-s7.rb <checkout APP>`. A fila S5 usa o script original
`script/verify_attendance_s5.rb`, com ActiveJob 7.1.5.2, Sidekiq 7.3.1 e
connection_pool 2.5.5. Esses testes não inicializam Rails ou usam Redis.

## Revisão técnica da S7

Conferidos: mudanças limitadas aos fixtures/validadores/documentação; rede
fechada ou loopback; chaves apenas de teste; HMAC bidirecional; verificadores
reais; vínculo ao socket original; CAS durável anterior à escrita simulada;
serialização e rollback do double; rejeições negativas; ausência de retries
novos; cleanup dos processos PostgreSQL WASM; migrations lidas sem edição;
diferença explícita entre índice normal e CONCURRENTLY; COPY de dependências de
teste; sintaxe e diff. A primeira execução do novo fixture APP foi corrigida:
cleanup em at_exit encerrava o banco antes do autorun; passou para after_run.
Os testes finais do schema passaram. Não era defeito da aplicação.

Não foi possível revisar comportamento observado de bundles finais, boot,
deadlocks nativos, consumo Redis, pool agregado ou crash de workers reais.
Não há regressão de integração comprovada, pois a integração não foi executada.
Também não há evidência suficiente para aprová-la.

## Sequência futura recomendada — não executada

1. Primeiro resolver os bloqueios S7: host Linux/Docker isolado com orçamento
   suficiente, Ruby 3.4.4/gems locked, PostgreSQL/MySQL/Redis/PgBouncer descartáveis
   e destinos controlados. Corrigir os 15 fixtures APP sem mock permissivo do
   guard. Negar egress WhatsApp/terceiros no laboratório.
2. Construir os três providers e registrar digests das imagens. Inspecionar o
   estágio final, SDK, helpers, Prisma e bundles; executar todas as assertions.
   Inicializar com conexões explicitamente descartáveis. O entrypoint versionado
   executa migrations: não iniciá-lo com configuração herdada de ambiente real.
3. Executar fases D–G restantes e guardar spans/percentis por etapa, contagem de
   falhas, idade de fila e backpressure. Só então avaliar ativação posterior.
4. Para uma ativação futuramente autorizada: registrar imagens/SHAs, backup
   verificável dos bancos e estados persistentes, janela e plano de interrupção.
   Pausar novas liberações pelo mecanismo existente e drenar/parar workers
   antigos preservando outboxes, tentativas e resultados incertos.
5. Aplicar todo o histórico APP requerido. Em seguida: S4
   `20261015000000_create_channel_whatsapp_ingress_admissions`; S5
   `20261016000000_add_attendance_durable_work`; depois
   `20261016000001_index_attendance_receipt_correlation`, fora de transação.
   Conferir constraints, triggers/fingerprints e índice válido/pronto; em falha
   de CONCURRENTLY, não aceitar índice inválido somente porque existe pelo nome.
6. Subir APP web/workers S5 compatíveis antes da Evolution S6. Sem mistura de
   workers com leases antigos e novos: drenar, respeitar expiração dos antigos e
   conferir backfill. Validar orçamento total/pool e capsules 2/1/1/default,
   conexão Redis e cron de recuperação. Não aumentar concorrência global.
7. No banco Evolution do provider escolhido, após o histórico anterior, aplicar
   em ordem `20261015000000_nexi_durable_ingress`,
   `20261015000001_nexi_ingress_secondary`,
   `20261015000002_nexi_ingress_contact_cache`. MySQL precisa sua versão SQL;
   psql_bouncer usa o contrato PostgreSQL, com pool validado separadamente.
8. Ativar Evolution compatível somente após schema e endpoints APP validados.
   Não misturar protocolos S4/R1/R2. Conferir ingress.observed/reconcile/
   correlated/profile, Message IDs existentes, fencing e recuperação. Não
   reenfileirar efeitos antigos incertos nem reinterpretar blocked_contract
   legado como permissão para executar o efeito.
9. Reabrir liberações somente com autoridade válida e evidência dos gates.
   Conferir receipts reais e recuperação sem retransmissão comercial.
10. Se falhar: pausar novas autorizações e preservar journals/outboxes/UNKNOWN.
    Reverter código somente se a versão de retorno entender os novos estados e
    schemas; caso contrário, manter pausa e corrigir adiante. Não executar down
    destrutivo nem restaurar Signal/sessão como rollback comum de código.

Nada dessa sequência foi aplicado a ambiente real. Nenhuma migration foi criada
ou alterada pela S7; apenas executadas em fixtures descartáveis locais.
