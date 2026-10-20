# S12 P0 — recuperação do ingresso persistido

Base conferida localmente e no remoto:
`ac45339a1d2aababae341264c0d2e649fb9e2bfe`, branch
`candidate/v23-prod-13-s12-cutover-safety`, repositório
`paropeba22/evolution-24-lab`. As correções `eff836c`, `ec0b09c` e `ac45339`
permanecem na ancestralidade. Nenhum reset, rebase ou force push foi usado.

## Causa demonstrada no source

O patcher de produção é `patch-ingress-source.mjs`; o Dockerfile compõe o fonte
upstream fixado em `e273b904d53f5726970fd6a244ed9caa61dfeb9a`. O arquivo
`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` é gerado nessa
composição, não um fonte versionado diretamente neste repositório de overlays.

Antes da correção, o handler composto continha estes dois gates:

```ts
if (this.instance.name.startsWith('nexi-wa-') && trustedObservation && this.localChatwoot?.enabled) {
  // observed(...)
}
if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && /* ... */) {
  // chatwoot(...), correlated(...)
}
// Worker always reached this guard, even when both blocks were skipped:
if (ingress.current(this) && await ingress.materializePrimary(this, messageRaw)) continue;
```

O journal é admitido pelo webhook autenticado, sem exigir essas flags da
integração legada. `run()` verifica o envelope, sessão, binding e lease,
decodifica o payload durável e chama `registration.process(message)`, que retoma
esse handler. Uma configuração Chatwoot da instância ausente/desabilitada pula
ambos os blocos, inclusive com `CHATWOOT_ENABLED=true` global. A primeira etapa
que gravaria `identity_pending` nunca ocorre. O guard rejeita a materialização;
o catch do worker atualiza estado/erro/tentativas, sem avançar o checkpoint.
Por isso o resultado é exatamente `recoverable_failure / persisted`, sem
association/ACK, com `nexi_ingress_primary_requirements_missing`.

Isso foi reproduzido com o worker, handler e decoder reais da composição antiga,
HOLD ativo e oito tentativas anteriores. O teste falha com o erro acima na
baseline e passa com a composição corrigida. Os verifiers de prova, sessão,
lease e assinatura não foram substituídos nos testes.

O usuário confirmou a flag global no EasyPanel. O valor de `localChatwoot.enabled`
efetivamente carregado no momento da falha operacional não foi fornecido. O Luna
deve conferir presença/booleano desse registro e sua carga no serviço, sem expor
credenciais. A reprodução demonstra o defeito de source e seu mecanismo; não
equivale a uma leitura do estado interno da VPS.

## Ordem real do protocolo

1. Baileys observa a identidade após decrypt autenticado. `capture()` transfere
   essa capacidade por identidade de objeto e `append()` persiste payload,
   envelope HMAC, dedup, scope e lane antes do receipt de entrega existente.
2. O worker recupera a mesma mensagem assinada, mantém sua identidade original
   e adquire lease/ownership da sessão viva. Não instala nem ressuscita sessão.
3. `observed()` grava `identity_pending`, envia `ingress.observed`, recebe a
   associação/reserva real do APP e grava `identity_confirmed`.
4. `chatwoot()` envia `ingress.reconcile` antes de criar qualquer Message. Se o
   APP já confirma um `message_id`, persiste esse ACK sem nova criação.
5. Somente `creation_state=absent_retry_safe` permite chamar o criador Chatwoot
   existente. Antes disso grava `chatwoot_inflight / result_uncertain`.
   Reconsulta o APP depois da tentativa, mesmo se a resposta da criação se perder.
6. O ACK da API `{id, inbox_id, conversation_id(display_id)}` é persistido em
   `acknowledgement`, com `chatwoot_confirmed`. Ele é distinto do ACK completo
   de associação enviado no evento seguinte.
7. `correlated()` grava `correlation_pending`, envia `ingress.correlated` com
   associação/generation/identidade e `message_id` reais, e só depois da aceitação
   grava `correlation_confirmed`. O APP valida sua reserva e o Message persistido.
8. `materializePrimary()` exige esse checkpoint, association.message_id e a mesma
   identificação em acknowledgement e no corpo. A Message local e as intenções
   secundárias são persistidas atomicamente. `finish()` confirma `succeeded`.

Na recuperação de uma mensagem ainda não materializada, o handler executa
novamente observação/reconciliação. Os IDs de evento são estáveis por journal,
etapa e ACK; timestamp/assinatura HTTP são renovados. A reserva APP impede uma
segunda Message. Quando `mainMaterializedAt` já existe, o worker reconcilia o
mesmo resultado e finaliza, sem repetir o handler. Estados legados desconhecidos
continuam exigindo reconciliação manual.

## Correção mínima e dependências

Os dois gates agora permitem o protocolo obrigatório quando `ingress.current(this)`
confirma o contexto privado do worker. Fora desse contexto, as flags continuam
governando o caminho legado. Os catches de observação/correlação propagam o erro
original no worker: 503/429 permanece `remote_unavailable`, rejeição HTTP permanece
`remote_rejected`, binding/proof fencing permanece fencing. Falhas não viram sucesso.

O guard `nexi_ingress_primary_requirements_missing` está byte a byte inalterado.
Também não mudaram worker, schemas, dedup, checkpoints, autorização, autenticação,
HOLD, WriterBarrier, Signal, preparações físicas ou dispatch. Nenhum ACK ou
associação é fabricado pela correção.

O hash S6 do provider composto muda de
`4f968359cf1dbaabe7db36bac057b55f61d4fbee61385f73678f48f6abe22ecb` para
`bbbd6550e820bd92d5d10b9c84ba253d93705f480fafcf41680a56690f0cb2e9`.
Os outros cinco hashes e os seis arquivos de runtime S6 permanecem iguais.
Testes reconstroem a composição histórica byte a byte e comprovam sua rejeição
antes de qualquer escrita; ela não foi adicionada como hash alternativo aceito.

Sem migration nova, mudança de configuração exigida pelo patch ou mudança de
contrato compartilhado. O APP candidato já oferece `ingress.observed`,
`ingress.reconcile` e `ingress.correlated` em
`app/services/platform/channels/whatsapp_identity_receiver.rb`.
O webhook sozinho reserva/reconcilia; não cria a Message. Se faltar a configuração
do provedor Chatwoot ou seu acesso legítimo ao APP, a criação continua pendente
(`chatwoot_unconfirmed`), sem sucesso fictício. Essa dependência deve ser conferida
pelo Luna; este hotfix não cria configuração nem deriva token de outro segredo.

## Validação local

Todos os dados, credenciais e mensagens dos testes são sintéticos. APP, repositório
e criação Chatwoot são simulados; admission/worker/handler/decoder, HMAC, gates e
ownership são os reais. A transação em memória testa retomada e rollback, sem
pretender certificar concorrência ou triggers de um banco real.

| Verificação | Resultado |
| --- | --- |
| Reprodução na composição antiga | RED: mesmo persisted/recoverable_failure/primary_requirements_missing |
| `ingress-recovery.test.cjs` | 22 PASS, zero skips |
| `baileys-transport-s6.test.cjs` | 36 PASS, zero skips |
| Bateria PostgreSQL de auth/autoridade/wire/HOLD/snapshot/storage/socket | 548 PASS, 2 falhas preexistentes, zero skips |
| Auth/patch de bundle MySQL | 142 PASS, zero skips |
| `attendance-source.test.cjs` | 11 PASS |
| `runtime-model.test.cjs`, com bundle/schema configurados | 11 PASS, zero skips |
| `verify-ingress-r2.mjs` | PASS |
| TypeScript PostgreSQL `tsc --noEmit` | PASS |
| Builds do entrypoint de produção `tsup src/main.ts` | PostgreSQL e MySQL: CJS/ESM PASS |
| Patchers de bundle + gates model/Groups/Attendance | MySQL, PostgreSQL e psql_bouncer: PASS |
| Assertions finais ingress/SDK/Axios e S6 | PASS para os três providers |
| Sintaxe JS e `git diff --check` | PASS |

Os 22 testes cobrem journal persisted sem association/ACK, HOLD, flags local/global,
falha intermediária, processo do worker reconstruído antes de retomar, resposta
perdida após commit APP, rollback local, retry, duplicado, associação tardia,
503, 401/422, resposta de conta estrangeira, envelope estrangeiro/assinatura
inválida, falha legítima sem ACK, outcome_unknown preservado, guard obrigatório,
PN brasileiro com oito/nove dígitos sem normalização, e recebimento legado
habilitado/desabilitado. Nenhuma rotina de envio físico é fornecida pelo fixture;
o trap de rede bloqueia chamadas externas acidentais.

As duas falhas de storage estão nas linhas 266 e 302 de
`attendance-storage-corrections.test.cjs`: esperam `/unguarded/`, mas o fixture
não fornece o contexto atual de socket exigido por `dispatchStart`, resultando
em `nexi_attendance_capture_socket_mismatch`. Ambas também falham numa extração
Git limpa de `ac45339`, com 315 PASS / 2 FAIL. Não foram corrigidas, ignoradas ou
reclassificadas como PASS neste hotfix. Uma execução inicial teve nove falhas de
resolução do WAProto por falta da junction local de dependências; após corrigir
o ambiente, todos os nove testes de snapshot passaram.

A composição foi refeita a partir do arquivo do upstream fixado e dos pacotes
Baileys/SDK preservados localmente, seguindo a ordem do Dockerfile. Build do
entrypoint usa a configuração tsup composta; psql_bouncer reutiliza o bundle
PostgreSQL como no Dockerfile. Não foi construído/exportado um container Linux
neste host. Build final da imagem e validação integrada na VPS cabem ao Luna.

Para repetir os testes novos numa árvore já composta:

```sh
NEXI_INGRESS_SOURCE_ROOT=/caminho/da/arvore-composta node --test ingress-recovery.test.cjs
```

## Validação operacional segura para o Luna — não executada aqui

1. Antes de uma atualização separadamente autorizada, obter somente leitura do
   journal conhecido: id, external_message_id, estado, checkpoint, tentativas,
   erro, presença/IDs de association e ACK, mainMaterializedAt e metadados da lane.
   Não exportar payload, envelope completo, headers, tokens ou material Signal.
2. Conferir HOLD ativo em APP/worker/Evolution, WriterBarrier mantida e nenhum
   envio físico liberado. Preservar as seis operações outcome_unknown e quatro
   pending de saída; elas não são alvos desta recuperação.
3. Conferir mesma sessão autenticada, ownership, binding conta/inbox, configuração
   Chatwoot da instância (presença/booleanos), acesso legítimo do criador e contrato
   APP disponível. Registrar os IDs do journal, reserva/evidência APP e Message
   eventualmente já existente para comparar depois. Não trocar segredos de
   assinatura enquanto esse journal estiver pendente.
4. Confirmar que a imagem construída contém o SHA entregue e passa os gates do
   Dockerfile. Este documento não autoriza nem executa deploy, migration ou restart.
5. Depois da atualização autorizada, observar somente leitura se o worker realmente
   registrou a instância e a lane está elegível: pending positivo, nextAttemptAt
   alcançado, lease liberado/expirado e essa mensagem na cabeça da lane. O fonte
   possui wake periódico de 5 s e backoff de até cerca de 5 min; isso não prova que
   o worker está registrado ou que a mensagem é elegível no ambiente real.
6. Não disparar replay, reinjetar evento, alterar checkpoint/estado/lease ou mandar
   outra mensagem WhatsApp. Se a recuperação existente não ocorrer, coletar apenas
   motivo/estado/ownership e investigar a elegibilidade; não presumir replay automático.
7. Evidência de aceitação: mesmo journal/external_message_id; associação e ACK reais
   com o mesmo Message; `correlation_confirmed` antes de `main_materialized`; depois
   `succeeded/completed`, uma Message local e uma Message APP para esse source,
   texto visível no histórico do contato correto, HOLD/barreira ainda ativos e
   nenhum envio físico. Checkpoints podem avançar entre consultas; usar o journal
   final e a reserva/evidência APP para comprovar a correlação, sem exigir flagrar
   cada estado transitório por polling.
8. Se houver 401/422, indisponibilidade APP, provider ausente, fencing de sessão/prova,
   Message conflitante ou lane bloqueada, manter a falha/hold e entregar o reason
   code sanitizado. Não fabricar IDs, remover guards nem editar a fila para avançar.

Nenhuma VPS foi acessada, nenhuma mensagem real foi reenviada e nenhum replay,
migration, deploy, release de HOLD/WriterBarrier ou reset Signal foi executado.
