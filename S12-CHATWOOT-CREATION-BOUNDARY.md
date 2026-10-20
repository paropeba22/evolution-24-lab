# S12 P0 — fronteira de criação Chatwoot e confirmação durável

## Veredito e base

A causa operacional específica do POST ainda não está comprovada. A evidência
atual demonstra uma reconciliação válida sem `message_id` após o wrapper de
criação; não demonstra que esse wrapper enviou uma requisição HTTP. Um POST 422,
um timeout sem commit ou um retorno antes do POST reproduzem o mesmo estado.

Esta candidata acrescenta instrumentação segura e testes da fronteira real.
Não altera o contrato de criação, autenticação, dados do POST, retries ou
elegibilidade do journal. Não pretende resolver por suposição o bloqueio do APP.

Evolution: base local/remota limpa
`bca425b1a0d600d5558c97c145f4cd9d12e30dc3`, branch
`candidate/v23-prod-13-s12-cutover-safety`. A imagem implantada informada pelo
operador é `sha256:a88b5f2e4e73946fbe1b4a1f9da89727b57fdcadca36eb02171a61b958c64563`;
nenhuma leitura ou operação dessa imagem/VPS foi executada aqui.

APP examinado: `paropeba22/isp-platform-lab`, candidata
`candidate/v23-prod-13-s12-authority-hold`, local/remoto em
`9665d1a52a76b00e9449b9d346841df324fa89e2`. O SHA do APP efetivamente implantado
não foi fornecido nesta investigação; deve ser conferido pelo Luna antes de
equiparar as garantias deste source ao ambiente operacional.

## Caminho exato no source

1. `nexi-ingress.cjs::run` verifica envelope, sessão/ownership e lease; incrementa
   `attempts`; decodifica o mesmo payload e chama `registration.process(message)`.
2. O handler `messages.upsert` composto chama `observed`, e depois
   `chatwoot(this, messageRaw, () => chatwootService.eventWhatsapp(...))`.
3. `chatwoot` reconcilia primeiro. `message_id` já confirmado gera ACK durável e
   dispensa o POST. Somente `creation_state=absent_retry_safe` permite continuar.
   Antes do wrapper grava `chatwoot_inflight/result_uncertain`.
4. `ChatwootService.eventWhatsapp` obtém `clientCw/getProvider`, verifica filtros,
   extrai conteúdo e chama `createConversation`. No ramo gerenciado, este último
   usa a associação autenticada, valida account/inbox contra o provider e retorna
   `conversation_display_id`. Não procura contato pelo telefone nesse ramo.
5. Texto usa `ChatwootService.createMessage` e o SDK fixado
   `@figuro/chatwoot-sdk` 1.1.17, `Messages.create`. Mídia usa `sendData` com Axios.
   Ambos executam:

   ```text
   POST {provider.url}/api/v1/accounts/{accountId}/conversations/{conversation_display_id}/messages
   ```

   O SDK envia multipart/form-data; `source_id=WAID:<body.key.id>`,
   `message_type=incoming`, `private=false` (string no multipart, convertido pelo
   modelo Rails), conteúdo e anexos quando aplicáveis. O SDK usa o token do
   provider nos headers existentes `Authorization` e `api_access_token`; mídia
   usa `api_access_token`. Nenhum desses valores é registrado pela instrumentação.
6. O SDK usa seu Axios 0.27.2 aninhado. Erros HTTP viram `ApiError.status` após a
   resposta; erros de transporte rejeitam a operação. `cancellable` pede cancelamento
   após 15 s e aguarda o executor real através de `nexiTransportSettled`. Mídia
   mantém seu timeout existente de 15 s. O cliente não prova se o servidor
   terminou uma transação após timeout/cancelamento.
7. O método Rails `MessagesController#create` chama `Messages::MessageBuilder`,
   que seleciona `WhatsappInboundCreation.create!` para entrada pública gerenciada.
   O parâmetro `source_id` é preservado pelo builder. A resposta normal do APP tem
   `id`, `inbox_id` e `conversation_id` como display ID.
8. `eventWhatsapp` captura exceções e retorna vazio depois do aviso genérico
   `Chatwoot event processing failed`. Há também retornos anteriores por provider,
   filtros, conteúdo ou conversa. Antes desta candidata, essas possibilidades
   não eram distinguíveis pelo journal.
9. `chatwoot` reconcilia novamente, mesmo após falha/retorno vazio do wrapper.
   `WhatsappIdentityReceiver` valida a mesma prova e consulta a admissão fixada
   ao journal. Retorna seu `message_id` quando persistido; não faz busca aproximada
   pelo número nem usa um GET de conversa como confirmação.
10. Sem ID nessa resposta válida, a Evolution lança
    `nexi_ingress_chatwoot_unconfirmed`. Com ID, verifica conflito com o ACK do POST,
    persiste `{id,inbox_id,conversation_id}` e só depois envia `ingress.correlated`.
    O guard de materialização continua exigindo associação, ACK e checkpoint reais.

## O que as 42 tentativas provam

O contador é de tentativas do worker, incrementado antes do handler; não é um
contador de POSTs. Uma tentativa pode falhar antes de criar, retornar antes do
POST ou recuperar um resultado já persistido.

O último erro informado prova que a reconciliação posterior respondeu sem ID;
uma falha HTTP dessa reconciliação produziria `remote_rejected/remote_unavailable`,
e um ID conflitante produziria `ack_conflict`. Mas o wrapper anterior pode ter
retornado vazio ou absorvido um erro de criação. GET autenticado da inbox/conversa
não discrimina essas alternativas nem confirma permissão de escrita.

Não foi encontrado um defeito universal de serialização de texto: o handler e
SDK reais, com Axios substituído somente na fronteira de I/O, emitem o endpoint,
account, display ID, source e tipo esperados e concluem quando o APP confirma o
commit. Portanto, não se alterou payload, normalização, endpoint ou autorização
sem evidência do erro operacional.

## Retry, atraso e duplicação

O worker pode repetir um POST após outra resposta `absent_retry_safe`. Não são
necessariamente 42 reconciliações sem efeitos. O mesmo journal, sessão, raw ID e
`WAID:<id>` são preservados. Não foi introduzido um novo retry nesta candidata.

A segurança dessa repetição depende do contrato APP já existente:

- `WhatsappIngressProof.reserve!` fixa journal UUID, assinatura/digest do payload
  e evidência ao mesmo canal/sessão/raw ID. Um novo UUID não substitui a reserva.
- `WhatsappInboundCreation.create!` toma locks de inbox, canal API e managed channel
  na transação de escrita. Verifica `WAID:<raw ID>`, sessão, evidência e associação
  legítimas antes de criar. Não utiliza só telefone como identidade.
- Se evidência/admissão já tem Message, retorna a original. Se encontra o source
  exato, valida o registro e fixa a admissão. Caso contrário, salva Message e
  atualiza `admission.message_id` na mesma transação.
- Os locks serializam duas criações concorrentes, inclusive um POST antigo cujo
  servidor continua depois do timeout. O segundo retorna o primeiro resultado.
  Rollback da transação não deixa uma Message confirmada sem sua atualização de
  admissão. O trigger `channel_wa_ingress_guard` valida o vínculo exato e impede
  substituição de um `message_id` já fixado.

Essas garantias foram verificadas no source e exercitadas com um APP sintético
que implementa a reserva idempotente. Não se certificou concorrência dos triggers
em um PostgreSQL real, nem se comprovou o SHA do APP implantado. Se o ambiente não
estiver nesse contrato, não se deve tratar essa premissa como validada.

Não há HOLD no caminho APP de criação de entrada examinado. O seletor de
`ManagedOutboundCreation` exige mensagem outgoing; uma entrada pública correta
não depende da liberação de WriterBarrier/dispatch. Todos os testes novos mantêm
HOLD ativo.

## Instrumentação entregue

`nexi-ingress.cjs` registra `ingress.creation` e `ingress.reconciliation` com
`journal_id` e tentativa. O patch do SDK instrumenta apenas o POST de mensagens,
na chamada real ao Axios. `patch-ingress-source.mjs` instrumenta o Axios de mídia,
saídas antecipadas relevantes e a exceção absorvida de `eventWhatsapp`.

| Metadados | Interpretação |
| --- | --- |
| `event_whatsapp_started` | Wrapper de criação foi invocado; ainda não prova HTTP |
| `event_whatsapp_returned`, `request_started=false`, `skip_reason` | Provider/conversa/filtro/conteúdo impediu o POST |
| `request_started`, `transport=sdk_message_post/media_message_post` | Axios foi invocado; não prova entrega de bytes/commit APP |
| `http_response`, `http_status=401/403` | Resposta de rejeição de autorização |
| `http_response`, `http_status=400/422` | Resposta de rejeição de validação |
| `http_response`, `http_status=429/5xx` | Resposta de indisponibilidade/limite remoto |
| `transport_error`, `error_class=timeout/cancelled/transport_unavailable` | Falha sem confirmação HTTP; commit segue desconhecido |
| `event_whatsapp_error` | Exceção foi absorvida no serviço; classe sanitizada |
| `event_whatsapp_returned`, `has_message_id` | Presença de ID no retorno do wrapper, sem atribuir sucesso durável |
| `before_creation/after_creation`, `has_message_id`, `result` | Resultado da reconciliação da reserva, ou falha nessa fronteira |
| `ack_persistence_failed` | ID legítimo confirmado, mas checkpoint do ACK não foi persistido |
| `ack_persisted` | Checkpoint do ACK foi persistido; correlação/materialização ainda precisam concluir |

`2xx` sozinho continua insuficiente. O teste de 200 com ID e sem commit mantém
`chatwoot_unconfirmed`; ID conflitante mantém `ack_conflict`. Nenhuma mensagem,
token, URL de provider, telefone, header, corpo de erro, stack ou source ID é
incluído nos novos eventos. No catch de mídia, o erro Axios completo deixa de ser
enviado ao logger quando a instrumentação primária está ativa. Fora desse contexto
o comportamento legado permanece. Falha dos novos diagnósticos no logger não
altera resultado/ACK.

Não houve mudança de schema, configuração, migrations, autenticação, assinatura,
checkpoint exigido, HOLD, WriterBarrier, Signal, backlog financeiro, autorização
antiga de 11/10 ou envio físico. APP não foi alterado. Worker, pump/lease CAS,
materializador e regras de retry permanecem os mesmos; apenas as fronteiras de
observação do resultado foram acrescentadas.

O hash aceito do request do SDK muda para
`09b78f5ac30d7eb3c8b0cbb06d385ab78895cbc0e1bc88b37926804604b36c49`.
O guard de pacote, versões, demais hashes e preflight dos patchers permanecem.
Não há hash alternativo aceito. Provider e todos os fingerprints S6 permanecem
iguais aos da candidata anterior. Runtime helper e SDK devem sair da mesma imagem.

## Testes e gates

- Reprodução inicial: o POST real serializado pelo SDK, respondendo 422 na
  fronteira Axios sintética, reproduziu tentativa 42, association presente,
  ACK ausente e `chatwoot_inflight/result_uncertain/chatwoot_unconfirmed`.
  A asserção de visibilidade HTTP falhou antes da instrumentação e passou depois.
- `ingress-recovery.test.cjs`: 47 PASS, zero skips. Inclui POST 401/403/422/503,
  aceito, timeout antes/depois do commit, 200 sem ID, 200 com ID sem commit, ACK
  conflitante, falha ao persistir ACK, mensagem existente/ausente, source
  incompatível, POST tardio concorrendo com retry, pump concorrente pelo CAS real,
  mídia sem vazamento de erro/token/conteúdo, falha de logger e caminho legado.
- `baileys-transport-s6.test.cjs`: 36 PASS, zero skips.
- TypeScript PostgreSQL `tsc --noEmit`: PASS.
- Build do entrypoint de produção `tsup src/main.ts`: CJS/ESM MySQL e PostgreSQL
  PASS; psql_bouncer utiliza o PostgreSQL como no Dockerfile.
- Patchers de bundle e gates model/Groups/Attendance: PASS nos três providers.
  Gates finais do SDK/Axios/ingress e S6: PASS.
- Verificadores R1 e R2: PASS. R1 foi executado sobre seu estágio pré-S6, pois sua
  asserção antiga de `socket(this).updateMediaMessage` é transformada pelo S6.
- `attendance-source.test.cjs` + `runtime-model.test.cjs`: 22 PASS, zero skips.
- Auth e patch do bundle MySQL: 142 PASS, zero skips.
- Bateria PostgreSQL de auth/autoridade/wire/HOLD/snapshot/storage/socket:
  548 PASS / 2 FAIL, zero skips. São as mesmas duas falhas preexistentes das linhas
  266 e 302 de `attendance-storage-corrections.test.cjs`, com
  `nexi_attendance_capture_socket_mismatch`, documentadas/reproduzidas na entrega
  anterior. Nenhum teste foi ignorado para torná-las verdes.
- Sintaxe e `git diff --check`: PASS. Build/export do container Linux e validação
  integrada real não foram executados neste host.

Os testes usam worker, decoder, handler, métodos Chatwoot, SDK e serialização
reais. Axios e APP são sintéticos, sem HTTP externo/servidor/banco real. O modelo
de reserva e a transação em memória não equivalem à certificação do banco real.

Para repetir a bateria, preparar a árvore composta e o SDK 1.1.17 original
extraído do pacote fixado pelo lockfile, sem aplicar o patch de completion nele:

```sh
NEXI_INGRESS_SOURCE_ROOT=/arvore/composta \
NEXI_INGRESS_PRISTINE_SDK=/sdk-1.1.17-original \
node --test ingress-recovery.test.cjs
```

## Validação segura para o Luna — sem executar aqui

1. Antes da atualização separadamente autorizada, registrar somente metadados do
   journal conhecido: id, estado/checkpoint, tentativa, erro, presença/IDs de
   associação/ACK, admissão e Message APP eventualmente fixada. Conferir o SHA
   implantado do APP e a presença do contrato idempotente examinado.
2. Manter HOLD nos três componentes, WriterBarrier, sessão e backlog. Não tocar
   nas seis operações outcome_unknown, quatro pending nem na autorização de 11/10.
   Não fazer POST de teste, replay, reinjeção, novo WhatsApp ou edição de lease,
   checkpoint/contador para obter evidência.
3. Conferir o SHA da imagem e o gate do SDK instrumentado. Depois de implantação
   autorizada, observar a tentativa normal do worker para o mesmo journal, caso
   a lane esteja elegível e a instância registrada. O wake/backoff existente não
   garante elegibilidade: se não ocorrer tentativa, coletar somente o motivo de
   registro/lease/cabeça da lane; não forçar recuperação.
4. Filtrar apenas `ingress.creation` e `ingress.reconciliation` pelo `journal_id`
   e número da tentativa. Informar a sequência de stage/status/error_class/
   has_message_id/result/skip_reason. Não encaminhar corpos HTTP, headers,
   conteúdo ou logs antigos que possam conter credenciais.
5. Se não há POST, o skip_reason delimita provider, conversa, filtro ou conteúdo.
   Se há 401/403, investigar a autorização específica de escrita; GET continua
   insuficiente. Se há 400/422, localizar a rejeição APP daquele POST com códigos
   sanitizados. Se há timeout/5xx, a reconciliação delimita se houve commit.
   Se há 2xx mas a reserva segue ausente, investigar resposta/roteamento e vínculo
   da transação no APP, sem aceitar o ACK HTTP como sucesso. Se apenas a gravação
   do ACK falha, preservar o ID APP e investigar storage/checkpoint na Evolution.
6. Aceitação funcional exige o mesmo journal/raw source: uma Message APP fixada à
   admissão, ACK durável correspondente, correlação legítima, uma Message local e
   `succeeded/completed`, texto visível no contato correto, HOLD/barreira intactos
   e nenhum envio físico. Se continuar incerto, manter o estado e entregar apenas
   os metadados novos; esta candidata não promete resolver uma causa ainda desconhecida.

Nenhum deploy, migration, restart, replay, reprocessamento real, envio WhatsApp,
liberação de autoridade ou acesso à VPS foi executado neste trabalho.
