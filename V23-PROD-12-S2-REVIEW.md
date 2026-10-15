# NEXI V23-PROD-12-S2 — análise estática e candidatos

**Veredito: INSTRUMENTATION REQUIRED.**

Há um caminho de logging inseguro demonstrável e uma correção candidata. A causa
dos 6,568 s e do receipt ausente não está demonstrada. Instrumentação foi preparada;
nenhuma melhora de latência ou recuperação de confirmação foi certificada.

## Baselines, escopo e proveniência

Evolution: `paropeba22/evolution-24-lab`, base exata
`56f93707c665779484449aae3390ab285dc30639`, candidata
`fix/v23-prod-12-s2-capture-observability`.
Upstream fixado pelo Dockerfile: `e273b904d53f5726970fd6a244ed9caa61dfeb9a`;
Baileys fixado: 7.0.0-rc13.

APP: `paropeba22/isp-platform-lab`, canônica informada
`package-02/command-center-shell`, base exata
`223d00ad4336a54662c8af1ed3dae49c495eed0a`, candidata
`fix/v23-prod-12-s2-transport-observability`.

A revisão do container Evolution OVH continua desconhecida. A canônica GitHub
não é evidência de implantação. Os dados de Message #843 abaixo foram fornecidos
pelo solicitante; esta missão não acessou produção nem os coletou novamente.
Não foram executados testes, parser, lint, build, patchers, instalação de
dependências, SSH, EasyPanel, migrations, envio, reprocessamento ou deploy.
Não houve acesso à Evolution antiga, BIA ou n8n. Commits são locais, sem push ou
promoção. A avaliação é leitura de código/diffs, sem validação executável.

## A. Intervalo frozen → release consumido

Message #843, Account 3, Conversation #375, 15/10/2026:

| Marco fornecido | UTC | Recife (UTC−03) | Diferença do marco anterior |
| --- | --- | --- | --- |
| Message criada | 06:37:23.463 | 03:37:23.463 | — |
| Preparation criada | 06:37:24.872 | 03:37:24.872 | 1,409 s |
| Attempt criada | 06:37:25.237 | 03:37:25.237 | 0,365 s |
| Preparation frozen | 06:37:25.756 | 03:37:25.756 | 0,519 s |
| Release consumido | 06:37:32.324 | 03:37:32.324 | **6,568 s** |
| Dispatch iniciado | 06:37:32.730 | 03:37:32.730 | 0,406 s |
| Attempt outcome_unknown na APP | 06:37:32.844 | 03:37:32.844 | 0,114 s |

Total entre os marcos extremos: 9,381 s. Isso não mede escrita no socket ou
recepção no aparelho. Frozen usa relógio JavaScript; consumption usa o relógio DB
por `SELECT CURRENT_TIMESTAMP`. No PostgreSQL esse valor representa o início da
transação, não o commit. Sincronização dos relógios não foi verificada. As
diferenças da tabela não são durações monotônicas de operações individuais.

Caminho reconstruído:

1. `nexi-attendance.cjs::prepare` congela a preparação e enfileira
   `attendance.transport.prepared` em outbox durável. O HTTP de preparation não
   substitui a prova persistida pela APP.
2. `installRoutes` consulta trabalho due a cada **5 s**, com exclusão `running`.
   Drena instâncias sequencialmente: até 20 eventos por instância, cada POST
   aguardado, timeout de 10 s. Ticks durante uma drenagem são ignorados. Logo
   o período de 5 s não é limite máximo de espera. Existem lease de 30 s,
   backoff de 5 s até 300 s e teto de 12 tentativas para evidência/callback.
3. APP autentica HMAC, valida contrato, grava observação/prova e faz wake por
   `PreparationVerifier.persist!`: `update_all due_at=LEAST(...,clock_timestamp())`.
   Esse update não executa callbacks ActiveRecord nem comprova commit sozinho.
4. O ciclo inicial pode ainda deter lease de 90 s. No `ensure` do worker, a
   lease é liberada e `due_at` é imediato quando houve progresso; sem progresso
   há backoff de 60 s inicialmente, até 3600 s. O callback de update agenda
   `NexiAttendanceOrchestrationJob.set(wait_until: due_at)`. Há recuperação
   agendada e claim CAS; nenhum wake autoriza envio por conta própria.
5. Job usa `scheduled_jobs`. A configuração de filas tem prioridade estrita e
   coloca essa fila depois de `low`; filas superiores ocupadas podem atrasá-la.
   Não foi verificada a configuração efetiva do Sidekiq nem seu polling.
6. APP estabelece contexto do ator e executa `AdmissionService.authorize!`
   (`open!` e `decide!`) e `release!`. Há transações repetidas com graph locks:
   Account, User/membership/permissões, Inbox/API/channel/barrier, Contact/CI,
   Conversation, identidade, Message, Execution, Attempt e Reservation; também
   decision e advisory lock de correlação por canal. Pool, queries, locks e
   checagens do catálogo podem consumir tempo, sem duração demonstrada.
7. APP chama primeiro `consumption_readback` autenticado. Somente o resultado
   autenticado unresolved permite `consume` da MESMA operação. Não se removeu
   esse readback. HTTP, autenticação e parsing são outras fronteiras de espera.
8. Evolution valida envelope/material/binding, adquire transação Prisma,
   verifica storage guards, consulta preparação, verifica sessão/socket/owner,
   faz CAS de consumo e readback e conclui transação. `maxWait=3000` e
   `timeout=10000` são limites, não sleeps. Dispatch posterior faz novo contexto
   autenticado e CAS antes da escrita; não pertence ao intervalo frozen→consume.

**Não existe sleep determinístico de 6,568 s neste caminho.** O polling de 5 s é
um mecanismo concreto compatível com parte do intervalo; não foi provado que
dominou #843. Também não há prova para atribuir os 6,568 s integralmente ao
Sidekiq, à Evolution, a locks ou a HTTP.

Marcadores candidatos: idade e início/fim do POST de prepared outbox por
event/preparation UUID; wake APP explicitamente não confirmado como commit;
enqueue/job/claim existentes mais duração monotônica de claim, ciclo,
admission, release e cada HTTP authority; tempo para estabelecer ator;
Evolution transaction acquired/storage guard/transaction returned, distinguindo
readback de consume. O início do callback transacional fornece fronteira de
aquisição, sem prometer isolar exclusivamente a espera do pool. Detalhar um
lock específico exigirá dados adicionais se admission dominar.

## B. transportReturn e Attempt

`nexi-attendance-dispatch.cjs::dispatch` aguarda `client.sendMessage`, confere
ID/JID e chama `authority.transportReturned(..., true)`. Uma falha depois do
dispatch mark chama o caminho false. `transportReturned` grava uma única vez,
sob transação/guard/CAS por preparação, consumption, revisão e estado:
`{boundary_returned:true,succeeded:boolean}`. O CAS Prisma já foi corrigido na
base ancestral `b9b625c`; esse patch não é reimplementado aqui.

O dispatch mark define `outcomeUnknown=true` antes de encode/socket. O retorno
do método não é SERVER_ACK nem entrega/leitura; portanto a flag continua true
mesmo com `state=transport_returned` e `succeeded=true`.

`authority.result()` serializa estado, consumption/grant/release/preparation/
attempt/reservation/external IDs, consumed_at, dispatch_started_at,
outcome_unknown e physical_dispatch. **Não serializa transportReturn.** A mesma
forma chega por resposta HMAC de consume/readback. Não há callback de
transportReturn no conjunto de eventos aceitos. Na APP,
`PreparationOrchestrator.record_dispatch!` retém consumption_ack, grava
dispatch_marked_at e outcome_unknown e mantém a projeção incerta.

No código analisado nenhum caminho escreve `transport_return_metadata`.
O schema permitir esse campo não cria um produtor. Sua ausência em #843 é
compatível com esse contrato incompleto, não demonstra perda na persistência
APP de um campo que teria sido recebido. Sem receipts, strongest/played
também não são preenchidos. Não se estendeu protocolo, HMAC, schema, estado
público ou projeção nesta missão. Uma eventual propagação de metadata deve ser
evidência de conclusão do método, mantendo toda a incerteza e o fence de reenvio.

## C. Receipt ausente: fronteiras e diagnóstico

A primeira fronteira potencial está em `capture` antes do buffer. As condições
são alternativas, não causas confirmadas do incidente:

- hook não executado/não existente no artefato, ou receipt não disponibilizado
  pelo Baileys; `transport_returned` não prova que houve stanza de receipt;
- ausência da configuração herdada em WeakMap ou contexto da instância/sessão;
- endereço não PN/LID direto; normalização vazia, ID inválido, stanza/semântica
  sem prova suficiente; não se inventa PN a partir de LID;
- repository/limites indisponíveis, saturação de itens/bytes, deadline de append,
  timeout de pool/statement/lock, validação ou falha da transação;
- journal e outbox são criados juntos; transação rejeitada não deixa journal
  positivo. Dedupe e recuperação finita permanecem inalterados;
- binding removido/desabilitado, contrato não suportado, lease/outbox backlog,
  HTTP/rejeição/HMAC, JSON/ACK inválido, CAS do acknowledgement sem vencedor ou
  teto de tentativas;
- APP pode persistir evidência em pending/quarantine. O reducer correlaciona
  namespace de instância+sender lineage+external ID e autoridade histórica;
  pode adiar, colocar em quarantine ou aplicar historical_only. PN/LID não
  substitui essa proveniência. ACK do callback significa retenção, não delivery.

Foram preparados: razões específicas nos retornos de capture, normalização
com rethrow preservado; contadores agregados; referências HMAC amostradas no
pre-buffer/append; journal UUID após commit; idade/tempo de append, watchdog,
outbox HTTP/ACK/erros e event/journal IDs; intake e reducer APP com estado e
razão allowlisted e sem consultas adicionais para explicar o log. Diagnostic
reference ausente nunca impede o trabalho original.

Amostragem e rate limit significam que **ausência de log não prova ausência de
receipt**. Logs amostrados de pre-buffer usam external ref; APP também permite
correlação por journal/event UUID. A amostra de journal na APP não é idêntica à
amostra de external ref da Evolution; nem toda mensagem terá trace completo.
O agregado não é contador de receipts únicos (inclui dedupe/recuperação).
Para #843, não há elementos nesta missão para separar falta de stanza de falha
de captura/persistência. Não há patch especulativo de entrega/ACK.

## D. Backlog

Hooks: `messages-recv.js` após decrypt/cleanMessage e antes de upsert;
`chats.js` antes de ev.emit/buffer; `ev.process` ao anexar à
`eventProcessingQueue`; início e fim do mesmo callback serial; início/fim do
item; `WhatsappInboundCreation.create!` na APP, envolvendo a transação de
persistência real. Não se chama o callback de identidade de persistência de
mensagem. O primeiro hook não mede espera anterior ao decrypt/socket.

Há spans para grupos/intercept, settings/Prisma, history, upsert, chat lookup,
perfil/observação/correlação de identidade, Chatwoot HTTP, message persistence,
foto e emissão de bot. O tempo de `chatbot_emit` mede a chamada aguardada, não
a conclusão de controllers que ela dispara sem await. Lotes só de histórico
também recebem batch UUID/categoria.

`queue_age_ms` mede enqueue→start; `buffer_age_ms`, emit pré-buffer→enqueue;
`pre_item_ms`, start do lote→start do item. Durações usam performance.now /
CLOCK_MONOTONIC; timestamps UTC são separados. Timers diagnósticos unref
emitem um aviso de operação ainda aguardada depois de 1 s, sem cancelar nada.
Há amostragem 1/64 por HMAC e limites por instância/estágio com suppressed_count
na Evolution. A APP usa cache exclusivamente em memória para limitar emissão.
Não foi introduzida concorrência de processamento, descarte, retry ou reordenação.

Os marcadores incluem revisão efetiva disponível: GIT_HASH na APP;
NEXI_RUNTIME_REVISION validado (40hex) na Evolution, ou `unknown`. Esse campo
informado não é atestado criptográfico do container. Um futuro build aprovado
deve fornecer a revisão verdadeira; nada foi configurado em produção aqui.
WeakMaps não persistem observações após restart; merge/dedupe no buffer e falta
de contexto podem impedir trace por item. Não se reconstrói retroativamente 14/10.

## E. Segredo em logs e mitigação

O source upstream espalha webhookData, incluindo apikey, em logData. Porém a
sequência efetiva da baseline já aplicava `redactEventForLog` no bundle, removendo
esse payload. Essa distinção impede atribuir o segredo real ao campo apikey sem
o bundle/log da ocorrência. Permaneciam `url`/`server_url` fora do redactor e
message/stack de erro livres em falhas/retries/JWT. URL pode conter segredo no
path, query ou userinfo. Esse vazamento potencial é demonstrado no código.

`patch-webhook-safe-logs.mjs` substitui os argumentos de log por metadados
fixos/evento/status/contagem. Não registra URL, headers, payload, stack ou texto
livre do erro. Mantém webhookData, headers, signing e retry policy no wire.
É aplicado depois de patch-managed-retry e antes do bundle. Os dois transforms
minificados antigos de redaction e suas fixtures obsoletas foram retirados;
a lista de snapshots do teste de source passou a incluir chats.js:
o novo source não produz aqueles anchors. Nenhum patcher foi executado para
validar essa composição; isso continua requisito de revisão futura autorizada.
Não se afirma que todos os logs upstream foram sanitizados: há outros consoles
e integrações fora desse caminho, cujo uso efetivo não foi investigado aqui.

Procedimento de rotação, **não executado**:

1. Identificar exatamente o segredo exposto por localização/configuração e
   fingerprint privado, sem copiá-lo. Distinguir token de receiver/API token,
   webhook signing secret e master HMAC (este afeta vários contratos).
2. Preparar consumidor para chave nova e, se o protocolo suportar, breve janela
   de verificação de chave anterior. Se só existe uma chave, programar troca
   coordenada controlada de emissor e receptor; não introduzir fallback que
   aceite assinaturas inválidas. Considerar outbox pendente, envelopes assinados,
   grants ainda válidos e outros canais dependentes do mesmo master.
3. Após aprovação operacional, corrigir emissor de logs e trocar os pares de
   configuração em ordem coordenada, validar autenticação sem envio WhatsApp,
   revogar chave anterior e limitar acesso/retenção das cópias expostas conforme
   política de evidências. Não reprocessar dispatch desconhecido. Qualquer replay
   de callbacks precisa de autorização própria e preservação do event ID/body.

## F. Correções, revisão e riscos

Correção funcional comprovada: sanitização do caminho de logging webhook.
Demais mudanças são instrumentação. Não se alteraram WriterBarrier, fencing,
grants, CAS predicates, HMAC, PN/LID, schema, idempotência, estados de receipt
ou política de não reenvio. O outbox mantém exatamente suas decisões anteriores;
o diagnóstico não chama CAS zero de ACK persistido.

Revisão executada: leitura dos diffs e confrontação textual dos anchors com os
patches financeiros/Groups anteriores. Nenhum resultado de teste/build pode ser
inferido. Riscos residuais: composição dos patchers e invariantes de código
gerado ainda não executados; overhead de timers/HMAC/logging não medido;
observações amostradas incompletas; awaits internos sem span próprio ainda
aparecem somente no span pai; revisão OVH desconhecida; source correto não
recupera receipts que nunca foram emitidos/persistidos. Não está pronto para
deploy sem revisão e validação autorizadas em missão posterior.
# S2-R1 — correção dos bloqueios de observabilidade

Esta revisão corretiva descende de
`dea1ae902ee75395acc060390b8e620ad8c35271`. A autorização R1 permite push
somente da candidata após conferência estática, sem promover canônicas ou
executar deploy. As restrições históricas da análise S2 abaixo permanecem
registradas como contexto daquela etapa.

## Orçamento de emissão

A seleção determinística 1/64 por ref HMAC/UUID só torna um evento elegível;
`sampled` agora passa pelo mesmo controle antes de qualquer emissão.
`inboundTrace`, `receiptTrace` e o log `nexi_inbound_item_failed` compartilham
três reservas por processo: **120 sampled, 60 slow, 60 failed por janela
monotônica de 60 segundos**. `failed` inclui falhas explícitas e razões de
receipt, exceto `append_waiting`/`append_duplicate_race`, classificadas como slow.
Os demais avisos/contadores usam slow. Tráfego saudável não consome a reserva
de problemas, e lentidão não consome a reserva de falhas.

As três janelas têm início na primeira tentativa após sua expiração. O teto
combinado é 240 por conjunto de janelas; para qualquer intervalo móvel de
60 segundos, o teto conservador é 480 por processo (duas janelas de cada
categoria). Mais processos multiplicam o limite. Repetição de um ID, novas
instâncias, evicção, TTL e limpeza não reiniciam essas reservas globais.
O saldo é debitado e o estado gravado antes do logger; logger com erro não
permite repetição irrestrita nem fallback recursivo.

Há também intervalo mínimo por instância/estágio/categoria/razão: 1 s para
sampled/falha e 30 s para slow. A evicção pode antecipar uma nova emissão dessa
chave, mas nunca ultrapassar o orçamento global. O estado das reservas contém
somente três objetos de tamanho fixo e números; nenhum ID de mensagem.

## Memória, expiração e ciclo de vida

| Map diagnóstico | Capacidade global | TTL monotônico | Evicção |
| --- | ---: | ---: | --- |
| `inboundThrottle` | 1.024 entradas | 300.000 ms (5 min) | FIFO da última gravação |
| `receiptThrottle` | 1.024 entradas | 300.000 ms (5 min) | FIFO da última gravação |
| `receiptCounts` | 512 entradas | 900.000 ms (15 min) | FIFO da criação |

Limite combinado: **2.560 entradas**, inclusive se uma única instância ocupar
toda a capacidade. Chaves têm UUID validado (ou `unknown`), estágio e razão
limitados a 64 caracteres e categoria fixa. Os valores contêm somente escalares
de tamanho limitado; os contadores saturam em `Number.MAX_SAFE_INTEGER`.
Não se retêm mensagens, payloads, sockets ou credenciais nesses Maps.

Toda leitura/escrita remove oportunisticamente o prefixo expirado do Map
correspondente. Gravações reinserem no final com TTL fixo; leituras, supressões
e incrementos não renovam TTL. Antes de inserir no limite, remove-se a entrada
mais antiga. A ordem de expiração acompanha a ordem de inserção porque cada
Map tem TTL único e usa relógio monotônico. Se ficar ocioso, pode reter entradas
expiradas até a próxima operação/limpeza, sempre dentro da capacidade.
Contadores e `suppressed_count` são diagnósticos aproximados: podem reiniciar
por expiração, evicção ou ciclo de vida.

`clearInstanceDiagnostics` remove as entradas dos três Maps para a instância.
É chamado na reconfiguração, no callback existente de connection close,
cancelamento manual, cleanup e descarte por `retirePending`. Todas as chamadas
de cleanup são isoladas por try/catch, após os guards de ciclo de vida existentes.
Um owner diagnóstico em WeakMap é invalidado, impedindo que callbacks/spans
antigos reconstruam o estado. A reconfiguração cria um novo owner; o worker
reutilizado recebe somente uma nova `diagnosticSource`, preservando sua source
funcional de append/recuperação. Appends em voo capturam o owner anterior e
seus traces são omitidos após encerramento. A memória de ownership é fraca,
sem registro global forte de serviços nem novos timers/listeners.

Outbox durável pode continuar trabalhando após fechar/remover o socket; seus
traces sem owner de socket continuam elegíveis e sujeitos aos mesmos tetos,
TTL e evicção. Cleanup nunca apaga journal/outbox ou modifica trabalho pendente.

## Conferência estática e limitações

Revisão textual dos caminhos de ID repetido, alta cardinalidade, logger com
erro, expiração, limite cheio, troca e encerramento. As operações normais são
constantes; prune é amortizado e limitado à capacidade, e cleanup examina no
máximo 2.560 entradas. Nenhum novo await, consulta, IO ou agendamento no
controle. Sem mudança em filtros, locks, CAS/fencing, WriterBarrier, grants,
TTL de autorização, HMAC, PN/LID, dedupe, receipts, outcome_unknown ou ordenação.
Só timestamps monotônicos diagnósticos têm TTL novo. Marcadores S2, fases,
backlog/durações, UUIDs e referências HMAC opacas permanecem disponíveis.
O log de falha por item mantém o nome e a sanitização e agora não pode abortar
o restante do lote se o logger lançar exceção.

O orçamento não garante justiça por instância/razão ou um trace completo.
Sampled, problemas e falhas podem ser omitidos, além de supressões por TTL,
evicção e owner encerrado. Ausência de log não prova ausência de receipt.
Este orçamento cobre os traces inbound/receipt e falha por item corrigidos;
não redefine logs existentes de autoridade, prepared outbox ou outros módulos.
Logging continua síncrono e depende do custo do logger existente.
Sem testes, parser, lint, build ou execução dos patchers: composição executável
dos anchors, desempenho real e integração permanecem para validação posterior
autorizada. Nenhum acesso à produção, deploy, envio ou reprocessamento.

## S2-R3 — três blockers da revisão R2

Delta focalizado sobre `3eccc77ee93913affbf993ce5eedd6d6fca4e1ea`:

- `cleanupLifecycle` volta a executar somente o comportamento funcional que
  já compartilhava com `creds.update`. Não invalida mais o owner diagnóstico.
  Os hooks terminais de cancelamento, close, `retirePending` e reconfiguração
  permanecem, incluindo a rejeição de traces com owner diagnóstico encerrado.
  Nenhuma alteração no journal, outbox, append ou recuperação de receipts.
- `authorityTiming` e `preparedOutboxTrace` agora reservam saldo por
  `allowDiagnosticTrace`, extraído do mesmo controle usado por inbound/receipts.
  Permanecem exatamente três reservas por processo: 120 sampled, 60 slow e
  60 failed, com janelas monotônicas de 60 s. Sem reservas adicionais ou novos
  Maps. Capacidade, TTL, evicção e limpeza terminal dos três Maps não mudam.
- Timing de autoridade usa failed em exceção, slow a partir de 1.000 ms e
  sampled nos demais casos. Prepared outbox usa failed no término sem
  `ack_persisted` (incluindo CAS não vencido/resposta não suportada), slow quando
  duração ou idade do backlog atinge 1.000 ms, sampled nos demais casos.
  A reserva antecede o logger, dentro do try/catch diagnóstico existente.

Esta ampliação substitui a exclusão de authority/prepared outbox descrita em R1.
Os nomes, fases, durações, IDs opacos e sanitização dos eventos são preservados.
Logs operacionais/de segurança preexistentes permanecem fora deste controle.
Conferência somente textual do delta: nenhum novo await, consulta, timer,
handler ou decisão funcional. Sem testes, parser, lint, build ou produção.
O orçamento pode omitir fases/correlações; mantém-se o teto conservador de
480 emissões por intervalo móvel de 60 s por processo, considerando as bordas
das três janelas. Composição executável e custo do logger aguardam validação
posterior autorizada. Nenhuma promoção ou implantação nesta missão.

