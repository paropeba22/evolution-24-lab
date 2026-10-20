# S12 — rejeição de ingress.observed antes da criação

Base Evolution local/remota conferida: `f0cf49aef8eebc55e8cad74d63d7934b41de3609`,
branch `candidate/v23-prod-13-s12-cutover-safety`. O operador informou build Linux
aprovado, digest `sha256:0e658a932337e2f254bb02a53d94448af5e571d92f88d2635c9d15576bbef84e`,
HOLD ativo e tentativas naturais 59/60 em `recoverable_failure/identity_pending`,
association presente, ACK ausente e `nexi_ingress_remote_rejected`. Nenhuma dessas
operações foi executada por esta tarefa de código.
Uma atualização posterior do operador informou a tentativa 62 no mesmo ponto.

## Lacuna reproduzida e correção de observabilidade

`observed()` grava `identity_pending` e chama `request(ctx, 'ingress.observed')`
antes de `chatwoot()`. A instrumentação anterior estava concentrada na criação
e na reconciliação; portanto não era alcançada nesse ponto de rejeição.

Reproduzimos as tentativas 59/60 com associação anterior preservada, HOLD ativo e
HTTP 401 em `ingress.observed`: estado e erro informados foram reproduzidos,
sem ACK, materialização, POST Chatwoot, `ingress.creation` ou `ingress.reconciliation`.
Na revisão anterior a asserção de visibilidade do HTTP falha, pois não há evento.

A alteração fica em `nexi-ingress.cjs::request`: registra `ingress.request`
independentemente do contexto de criação, para os quatro eventos de ingresso.
Cada registro contém apenas:

- `journal_id`, `attempt`, `ingress_event` e `event_id` determinístico já assinado;
- `stage=request_started`, `http_response` ou `transport_error`;
- `http_status` inteiro quando há resposta e `error_class` sanitizada quando falha.

Não se registram URL, headers, assinatura, corpo/payload, mensagem, telefone,
source ID ou texto/stack da exceção. Logger indisponível não muda o resultado.
O corpo de uma resposta rejeitada continua sem ser lido. Assinatura, timestamp,
event ID, opções HTTP, timeout e erros propagados são preservados.

O journal continua registrando seu código de erro original. Não há nova coluna,
campo de contrato ou migration. A mudança não libera, reclassifica como sucesso
ou reinicia trabalho. Não há alteração no SDK, source TS, fingerprints S6,
guards, ACK/association exigidos, worker, pump, lease, retry, HOLD, WriterBarrier,
Signal, backlog ou autorização antiga de dispatch. APP não foi alterado.

## O motivo APP ainda não está comprovado

`nexi_ingress_remote_rejected` só estabelece HTTP não-2xx inferior a 500, excluindo
429. Não revela se foi 401, 403, 404, 409 ou 422. Association presente no journal
é evidência de um resultado anterior; não comprova aceitação atual pelo APP.

Na candidata APP `9665d1a52a76b00e9449b9d346841df324fa89e2`:

| Ponto | Evidência disponível |
| --- | --- |
| `Webhooks::Nexi::ChannelEventsController#create` | `EvolutionEventReceiver::Rejected` retorna 401; `RequestIdentity::Denied`/RecordNotFound retorna 422; Conflict retorna 409 |
| `EvolutionEventReceiver#perform` | Valida headers, janela de tempo, HMAC, payload e binding antes de despachar identidade/ingresso |
| `WhatsappIdentityReceiver#perform/accept_locked` | Pode rejeitar shape, prova, schema/ledger, canal, sessão, evidência, associação ou reserva |
| `WhatsappIngressProof#validate!/reserve!` | Verifica prova durável, assinatura, identidade e vínculo da reserva; não pode ser contornado para recuperar |

Logo, `error_class=authorization_rejected` descreve a classe HTTP de 401/403;
**401 não comprova HMAC incorreto**. Vários guards posteriores usam a mesma
exceção e retornam esse status. A igualdade do segredo entre processos também
não comprova todos os demais predicados.

O APP já possui logs `attendance.outbound_callback`, apesar desse nome abranger
também callbacks de ingresso. `OrchestrationDiagnostics.callback` aceita
`event_type=ingress.observed` depois da autenticação. Os campos úteis são:

- `phase=header_validation/timestamp_validation/authentication/payload_validation/channel_binding/event_dispatch`;
- `reason_code=callback_headers_rejected/callback_timestamp_rejected/callback_authentication_rejected/callback_contract_rejected/callback_binding_rejected/callback_operation_failed`;
- após autenticação, `event_id`, `event_type` e IDs do canal vinculados pelo APP.

Antes da autenticação não se registram IDs fornecidos pelo remetente. Não
presumir correlação única por horário se houver vários callbacks concorrentes.
Em `event_dispatch`, o código genérico ainda não distingue cada guard interno
de identidade/prova. Se essa for a fase observada, o predicado específico
permanece uma lacuna para investigação focalizada; não foi atribuído um motivo
sem evidência nem alterado um guard preventivamente.

## Identificar o código APP relevante sem expor segredos

O SHA efetivo da imagem continua desconhecido (`GIT_SHA=undefined`, sem label
revision). O Luna pode comparar, somente por leitura, estes SHA256 dos blobs Git
da candidata `9665d1a` com os mesmos arquivos de código dentro da imagem APP:

| Arquivo | SHA256, bytes Git/LF |
| --- | --- |
| `app/controllers/webhooks/nexi/channel_events_controller.rb` | `bd603c18b6f9d335cce8bfa9a7095990b50b88b3fe4b6913fb85db950e07aec3` |
| `app/services/platform/channels/evolution_event_receiver.rb` | `7c9aa077c7ca53b430be21daa29ad36af0ce4da13c290457c47bff813e5a6bb3` |
| `app/services/platform/channels/whatsapp_identity_receiver.rb` | `c1b2d0a77990fda5d70b7e77b18035a808f561cd11d4fe46273fc191b86bc1ba` |
| `app/services/platform/channels/whatsapp_ingress_proof.rb` | `7d847739b457c93549f8c089440c0ac791c19ea012c37eee2a817d11bbffdd46` |
| `app/services/platform/attendance/orchestration_diagnostics.rb` | `db5e0084e9b1e95e0ab673d5f4f122441a84f82c6880afe8cb82da5a00c7e0a1` |

Isso compara apenas esses arquivos públicos de implementação. Não identifica
todo o commit/imagem, configuração efetiva ou schema e não autoriza examinar
segredos. Se diferirem, a análise do APP deve usar o código realmente implantado.

## Validação e entrega ao Luna

1. Depois de atualização separadamente autorizada, observar uma tentativa normal
   do mesmo journal, se estiver elegível. Não fazer replay, novo WhatsApp,
   reinjeção ou edição de estado/lease/contadores.
2. Capturar `ingress.request` filtrado pelo journal e tentativa. Exemplo esperado
   numa rejeição: `ingress_event=ingress.observed`, `stage=http_response`,
   `http_status=401`, `error_class=authorization_rejected`, mais o `event_id`.
   Esses valores são exemplo de teste, não diagnóstico do HTTP real ainda desconhecido.
   Incluir explicitamente esse novo evento no filtro de captura protegida; filtrar
   apenas `ingress.creation`/`ingress.reconciliation` continuará produzindo arquivo
   vazio enquanto a observação for rejeitada. O status/classe ficam nos logs
   sanitizados existentes, sem acrescentar campos ou mudar o erro do journal.
3. Correlacionar o `event_id` com `attendance.outbound_callback` do APP quando
   autenticado. Se não autenticado, usar somente fase e janela temporal como
   indícios; não confiar em IDs de remetente não autenticados. Se não há callback
   APP e aparece 404/403, incluir roteamento/proxy na investigação.
4. Entregar somente status/classe/fase/reason_code/IDs de correlação. Não exportar
   headers, payload, corpo de resposta, telefone, mensagens ou valores secretos.
5. Manter falha e HOLD se rejeitado. Não reutilizar association antiga para pular
   `observed`, não fabricar ACK e não mudar sessão/binding para fazer o guard passar.
   As seis operações outcome_unknown, quatro pending e autorização de 11/10 não
   fazem parte desta alteração.

Testes novos cobrem 401/403/409/422/429/503 antes da criação, timeout sem status
inventado, logger que falha, privacidade/allowlist dos campos e correlação dos
event IDs nas respostas bem-sucedidas. A bateria de ingresso tem 56 PASS, zero
skips, usando worker/decoder/handler/SDK reais e APP/Axios sintéticos. O RED foi
repetido com o runtime imutável extraído de `f0cf49a`.

Gates locais desta revisão:

- `ingress-recovery.test.cjs`: 56 PASS, zero skips.
- `cutover-safety.test.cjs`: 9 PASS, zero skips.
- TypeScript PostgreSQL `tsc --noEmit`: PASS.
- `tsup src/main.ts`, CJS/ESM, PostgreSQL e MySQL: PASS.
- Patchers de bundle e gates model/Groups/Attendance: PASS nos três providers.
- Gates finais do SDK/Axios/ingress e S6: PASS.
- Bundles CJS PostgreSQL e MySQL: byte a byte iguais aos artefatos validados de
  `f0cf`; a alteração de runtime é somente no helper CJS externo. psql_bouncer
  reutiliza o PostgreSQL, como no Dockerfile.
- Sintaxe JS e `git diff --check`: PASS. Build/export da nova imagem Linux
  permanece etapa operacional do Luna; não foi executado aqui.

Nenhum acesso à VPS, replay, deploy, migration, envio físico, mudança de segredo,
sessão, HOLD, WriterBarrier ou backlog foi executado nesta tarefa.
