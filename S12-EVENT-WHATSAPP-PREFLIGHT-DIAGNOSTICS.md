# S12 P0 — exceção absorvida e preparação do SDK Chatwoot

## Resultado e limite da investigação

A causa específica da tentativa natural 117 **não está comprovada**. O evento
`event_whatsapp_error/unclassified_failure` comprova uma exceção dentro do `try`
de `ChatwootService.eventWhatsapp`; não identifica a instrução nem prova início
de POST. Esta candidata corrige a perda de observabilidade, sem hotfix funcional
especulativo. Não promete desbloquear a mensagem por si só.

Base Evolution local/remota limpa: `aecc681d9239e56a7afcbccf76618191613a25cb`,
branch `candidate/v23-prod-13-s12-cutover-safety`. A ancestralidade inclui
`f0cf49aef8eebc55e8cad74d63d7934b41de3609` e
`bca425b1a0d600d5558c97c145f4cd9d12e30dc3`; as correções anteriores são preservadas.
Imagem implantada informada: `sha256:9f3581e331397352fcdfa2165b56c39036e6339942a01173337b9fc63ac1e11e`.
Não houve acesso à VPS, imagem ou ao arquivo operacional
`ingress-request-aecc-target-records-20261020.jsonl` (SHA-256 informado
`78705ba57b3902680ff872f9c7b0e332560266a1e106dbc483e200183bda386d`).
Os HTTP 200 de observed/reconcile nas tentativas 115–117 são evidência fornecida
pelo operador. O roteamento já corrigido não foi reinvestigado.

APP examinado, sem alterações: `9665d1a52a76b00e9449b9d346841df324fa89e2`.
Não se atestou o OCI implantado do APP nesta investigação.

## Fronteira real e perda de classificação

O código executado é composto por `patch-ingress-source.mjs`; não há um SDK
substituto criado para esta investigação. Os testes extraem os métodos TS
compostos e carregam `Messages.js`, `request.js`, `CancelablePromise` e
`ApiError` reais do SDK fixado `@figuro/chatwoot-sdk` 1.1.17, com Axios 0.27.2
aninhado. Só a fronteira de I/O e a persistência do APP são simuladas.

1. `eventWhatsapp` chama `clientCw/getProvider`: cache, configuração da instância,
   construção de `ChatwootClient`. Ausência de provider retorna antes do POST.
2. Prepara conteúdo/filtros/referência citada; `createConversation` gerenciado
   exige a associação autenticada e account/inbox correspondentes ao provider.
   Retorna o display ID da conversa; não faz fallback por telefone.
3. `createMessage` resolve novamente o cliente e referências, prepara dados e
   entra em `cancellable(() => client.messages.create(...))`. Uma exceção síncrona
   no factory também chega ao `catch` externo, sem necessariamente entrar no SDK.
4. `Messages.create` prepara anexos e chama `request`. Este executa, nessa ordem,
   `getUrl`, `getFormData`, `getRequestBody`, `await getHeaders` e `sendRequest`.
   Dentro de `sendRequest`, ainda há preparação do cancelamento/configuração
   antes de `axios.request`. Portanto, nem `chatwoot_inflight`, nem entrada na
   operação SDK, nem entrada em `sendRequest` comprovam transporte HTTP.
5. O único POST SDK é
   `/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages`.
   Usa account do provider, display ID autenticado e `source_id=WAID:<raw WA ID>`
   estável. O SDK serializa multipart e utiliza os headers de autenticação
   existentes. Mídia usa o Axios direto já instrumentado. Nenhum desses dados
   foi alterado ou acrescentado aos logs.
6. `sendRequest` preserva respostas HTTP rejeitadas para `catchErrorCodes`, que
   lança `ApiError` com `status`. Falhas sem resposta são relançadas. O wrapper
   de cancelamento preserva a exceção e aguarda o executor real terminar.
7. O `catch` de `eventWhatsapp`, instrumentado em
   `patch-ingress-source.mjs`, chama `creationFailure(error)` e absorve o erro.
   `nexi-ingress.cjs::creationError` da base só reconhecia status HTTP e alguns
   códigos de transporte; `TypeError`, `ReferenceError`, `URIError` etc. viravam
   `unclassified_failure`, sem nome seguro nem etapa. Essa lacuna é comprovada.

Uma rejeição HTTP normal preservada pelo SDK teria status/classificação; o
evento fornecido não demonstra essa rejeição nem exclui resposta perdida após
aceitação. Não há prova para alterar endpoint, token, payload, normalização ou
APP. A linha concreta que falhou na tentativa 117 permanece desconhecida.

## Instrumentação mínima

- `patch-ingress-source.mjs`: marcos fixos de resolução do cliente, conteúdo,
  conversa, preparação da mensagem, referências e entrada em `messages.create`.
- `patch-chatwoot-completion.mjs`: marcos nas etapas reais de preparação do SDK,
  resposta e retorno; exceção mantém a última etapa e é rejeitada normalmente.
  As âncoras são exatas e rejeitam composição divergente antes de gravar o SDK.
- `nexi-ingress.cjs`: nome/código de erro por allowlist, presença de resposta,
  última etapa e sinal de chamada ao Axios. Erros nativos e códigos conhecidos
  de configuração e classes Prisma passam a ter classificação segura específica. Outros nomes
  ficam `other`; nunca são copiados livremente.
- `assert-ingress-runtime.mjs`: hash esperado do SDK instrumentado atualizado
  para `a5c0763b4217451dca743dd42948aac705b9fc48e9ad91c7c3db267033dcfa55`.
  Versão, hashes pristine e demais guards continuam estritos.

Os eventos continuam vinculados a journal/tentativa. Não registram mensagem da
exceção, stack, URL, telefone, source ID, token, headers, payload ou corpo de
resposta. Falha no logger não altera o resultado da operação.

| Evidência nova | Interpretação permitida |
| --- | --- |
| `preparation`, `operation_step=client_resolution/body_preparation/conversation_resolution` | Preparação no integrador |
| `operation_step=message_preparation/reply_resolution/sdk_operation` | Preparação da criação / entrada no factory SDK |
| `operation_step=sdk_url/sdk_form/sdk_body/sdk_headers` | Preparação efetiva do SDK, anterior ao Axios |
| `operation_step=sdk_send`, `request_started=false` em erro | Falha ao entrar/preparar `sendRequest`, antes do ponto Axios |
| `request_started`, `boundary=axios_invocation` | Chamada ao Axios; não prova adapter, bytes enviados ou commit APP |
| `http_response`, status numérico | Resposta HTTP observada; status de sucesso sozinho não prova reserva persistida |
| `preparation_error` ou `event_whatsapp_error`, `error_name/error_code` | Etapa e classe/código allowlisted da exceção, sem dados privados |
| `sdk_response/sdk_return`, `event_whatsapp_returned.has_message_id` | Leitura e retorno do SDK / presença de ID no resultado |
| `after_creation=message_confirmed`, `ack_persisted` | Reconciliação APP e ACK durável; guard continua exigindo correlação |

O nome histórico `request_started` é explicitamente delimitado pela fronteira
`axios_invocation`. Não há alegação de observação de socket/TCP ou entrega física.
A ausência isolada de um log, em coleta incompleta, também não comprova ausência
de HTTP. A exceção em etapa anterior, com trace completo, oferece essa distinção.

## Tentativas, reserva e duplicação

117 é contador de execuções do worker, não de POSTs. Em cada recuperação,
`nexi-ingress.cjs::chatwoot` reconcilia antes de criar. ID já reservado dispensa
o SDK; somente resposta autenticada `absent_retry_safe` permite a criação.
Após retorno vazio/erro/timeout, reconcilia novamente. Sem confirmação conserva
`result_uncertain/chatwoot_inflight`; não fabrica ACK ou association.

O APP examinado mantém `WhatsappIngressProof.reserve!` e
`WhatsappInboundCreation.create!`: locks transacionais Inbox → ChannelApi →
ManagedChannel, verificação de source exato/identidade/sessão, retorno da Message
preexistente e gravação da Message com `admission.message_id` na mesma transação.
Isso protege uma criação atrasada e outra tentativa que use a mesma reserva.
Não houve mudança de retries, lease, identidade, source ou contrato compartilhado.
Os testes simulam essa reserva; não certificam concorrência em um banco APP real.

## Validação offline

| Verificação | Resultado |
| --- | --- |
| `node --test ingress-recovery.test.cjs` | 65/65 PASS, sem skips |
| `baileys-transport-s6.test.cjs` na composição real | 36/36 PASS |
| `verify-ingress-r1.mjs` | PASS, incluindo cancelamento/settlement do SDK real |
| `verify-ingress-r2.mjs` | PASS nos dez grupos |
| TypeScript 6.0.3 `tsc --noEmit`, cliente PostgreSQL | PASS |
| Build tsup, PostgreSQL e MySQL | PASS |
| Gates finais models/groups/attendance, PostgreSQL/MySQL/psql_bouncer | PASS |
| Gates SDK/ingress e S6 do conjunto final de providers | PASS |
| `attendance-source.test.cjs` + `runtime-model.test.cjs`, MySQL | 22/22 PASS, sem skips |
| `nexi-transport.test.cjs` + `bundle-patch.test.cjs`, MySQL | 142/142 PASS |
| Regressões amplas PostgreSQL | 548/550 PASS; duas falhas preexistentes abaixo |

Nove novos casos cobrem exceção síncrona do factory SDK, rejeição assíncrona,
falha síncrona na URL real, rejeição assíncrona nos headers reais, falha ao
resolver provider, retorno SDK antes do POST, nomes/códigos privados e erro de
configuração na fronteira Axios e classe/código Prisma sem query ou dados do schema. Repetem a mesma operação sob HOLD sem criação,
ACK ou materialização indevidos. As regressões existentes cobrem provider ausente,
HTTP 401/403/422/503, timeout antes/depois do commit, resposta sem ID, falha de
persistência ACK, reconciliação posterior, Message existente, source incompatível,
HOLD, assinatura/conta estrangeira, concorrência e criação atrasada idempotente.

As duas falhas amplas são `attendance-storage-corrections.test.cjs:266` e `:302`:
esperam `/unguarded/`, mas recebem `nexi_attendance_capture_socket_mismatch`.
São as mesmas falhas do controle baseline local já preservado (315/317 nessa
subsuíte). Nenhum arquivo de autoridade/storage/dispatch foi alterado para
eliminá-las. A suíte ampla não é declarada integralmente verde.

## Impacto e validação operacional pelo Luna

Sem mudanças no APP, migrations, configuração, sessão Signal ou backlog.
HOLD, WriterBarrier, autenticação, checkpoints e guard de materialização intactos.
Nenhum deploy ou acesso operacional foi executado pelo Sol.

Após implantação autorizada separadamente, o Luna deve:

1. Atestar a nova revisão e os gates do SDK/provider; manter HOLD nos três serviços.
2. Aguardar apenas a recuperação natural do mesmo journal. Não chamar replay,
   modificar contadores/lease/checkpoint, reenviar WhatsApp ou criar uma Message
   manualmente. Se não houver tentativa natural, registrar essa ausência.
3. Coletar um trace completo da mesma tentativa: `ingress.request` observado e
   reconciliações, `ingress.creation` com as novas etapas e exceção, resultado de
   reconciliação, persistência do ACK e checkpoint final. Fornecer somente enums,
   IDs técnicos já sanitizados, booleanos e status numéricos.
4. Se falhar, encaminhar a sequência mínima: `attempt`, `operation_step`, `stage`,
   `request_started`, `boundary`, `error_name`, `error_code` quando presente,
   `error_class`, `has_http_response`, `http_status`, presença de `message_id` e
   resultado de reconciliação. Não encaminhar erro textual/stack/payload/headers.
5. Se concluir, confirmar por leitura a única Message do source exato já esperado,
   a reserva APP apontando para o mesmo ID, um único ACK durável e correlação,
   `succeeded/completed` e uma única materialização local. Conferir ausência de
   duplicação e de envio físico, sem tocar operações financeiras/outcome_unknown.

Se a tentativa continuar falhando, esses metadados são a evidência ainda
necessária para uma correção funcional sustentada. Não reinterpretar incerteza
como autorização para novo POST manual nem como sucesso.
