# NEXI V23-PROD-13-S4-R2 — contratos das integrações

Veredito de implementação: **S4-R2 INTEGRATION CONTRACTS READY** para novas
admissões, sujeito às verificações de runtime/deploy posteriores descritas aqui.
Nenhuma das seis famílias novas permanece desativada em `blocked_contract`.
Sucesso de transporte não é prova de conclusão do negócio no destino.

Branches nos dois repositórios: `candidate/v23-prod-13-s4-r2-integration-contracts`.
Pais diretos confirmados remotamente antes da implementação:

- Evolution: `3bfde91b644185c7d19a2a0a4dc9f76a05ffc3f9`.
- APP: `4797f7c7fb326b3a634926dc345761e1037be9ab`.

## Famílias efetivamente executadas

| Família | Classificação | Gatilho, efeito e conclusão |
| --- | --- | --- |
| `message_webhook` | `FUNCTIONAL — CONSERVATIVE AT-MOST-ONCE ATTEMPT` | `MESSAGES_UPSERT`, depois da materialização principal; executa os destinos selecionados por configuração/evento. Cada destino tem tentativa e resultado próprios. |
| `chatbot` | `FUNCTIONAL — CONSERVATIVE AT-MOST-ONCE ATTEMPT` | Mensagem autenticada materializada; chama os controllers habilitados, preservando filtros, triggers, sessão e fallback existentes. Aguarda todos os handlers, debounce e callbacks registrados. Não concede autorização de envio. |
| `contact_webhook` | `FUNCTIONAL — CONSERVATIVE AT-MOST-ONCE ATTEMPT` | `CONTACTS_UPSERT` inicial e `CONTACTS_UPDATE` posteriores; decisão persistida com a intenção. Utiliza PN autenticado, nome observado e foto já armazenada. |
| `contact_chatwoot` | `FUNCTIONAL — SAFE CONTRACT` | Novo evento assinado `ingress.profile`; sincroniza uma projeção complementar no Contact já associado na APP, sem criar outro Contact/Message nem alterar identificador, telefone ou nome manual. |
| `chat_name_webhook` | `FUNCTIONAL — CONSERVATIVE AT-MOST-ONCE ATTEMPT` | `CHATS_UPSERT` quando o nome público autenticado difere do snapshot local; entrega o snapshot persistido. A projeção local continua transacional e repetível. |
| `contact_cache` | `FUNCTIONAL — SAFE CONTRACT` | Cache local transacional de aliases PN/LID exatos, isolado por conta/inbox/instância/sessão, com unicidade, sequência e expiração. Leitura gerenciada usa esse cache, não o cache global legado com variações de números. |

Configuração desabilitada ou evento não selecionado produz um manifesto sem
aquele destino; não produz uma alegação de entrega. O dispatcher mantém os
filtros de grupos existentes. A configuração S4 de admissão continua exigindo
webhook local sem base64/byEvents; essa restrição não foi relaxada nesta revisão.

## Fronteira principal e capacidade

O caminho permanece Baileys → journal autenticado → workers principais →
identidade/APP/Chatwoot/correlação → Message local e intenções atômicas → conclusão
principal. Nenhum dispatcher é executado na transação de materialização.
Snapshots/decisões de contato e chat são consultas locais nessa transação.

Os efeitos rodam somente após o pai estar `succeeded` com `mainMaterializedAt`.
Continuam separados dos quatro workers principais, com dois workers secundários
por processo e um por instância. Um semáforo adicional limita a dois os transportes
de fanout simultâneos, inclusive callbacks aninhados de chatbot. O slot só é
liberado após a Promise real e seus callbacks acompanhados terminarem. O handler
de chatbot não ocupa esse semáforo enquanto espera seus próprios callbacks,
evitando deadlock entre pai e filhos. São limites por processo, não cluster-wide.

Uma chamada externa sem término pode ocupar uma vaga indefinidamente; não existe
timeout fictício para descartá-la. A admissão continua sujeita aos limites de
armazenamento/backpressure da S4/R1, incluindo 10.000 intenções secundárias ativas
por escopo. Saturação dessa capacidade pode impedir materialização adicional;
não há promessa de progresso infinito com recursos finitos e destinos parados.

## Manifesto por destino, ordenação e recuperação

`nexi-ingress-dispatch.cjs` persiste os manifestos dentro do `result` do efeito,
sem substituir os checkpoints existentes. Cada manifesto contém contexto do
efeito/journal, instância, sessão, destino identificável, hash da configuração e
payload exato. Headers/credenciais de configuração são vinculados por digest.
Campos legados do payload como `apikey` continuam presentes se a opção de
exposição existente estiver habilitada. O JSON arbitrário é assinado como string estável; o
canonicalizador de autoridade continua rejeitando números fracionários.

HMAC `ingress-dispatch:v1:<instance>` sela os campos imutáveis. A recuperação
confere assinatura, contexto exato e configuração; não pode transplantar um
manifesto de outro journal/sessão. Cada destino tem ID determinístico e uma
tentativa máxima. O HTTP recebe `X-Nexi-Operation-Id`, `X-Nexi-Attempt: 1` e os
campos equivalentes de payload. O caminho NEXI assinado mantém seu envelope HMAC
e um Event ID estável derivado dessa operação.

Transições por destino: `pending` → `inflight` persistido → `succeeded` ou
`outcome_unknown`. Não há retry HTTP oculto. O processo aguarda o transporte e os
callbacks antes do checkpoint final. Erro registrado e engolido por um handler
legado é observado pelo escopo e impede sucesso fictício. Uma rejeição, timeout,
erro parcial ou perda de resposta é incerta; HTTP 2xx confirma o ACK HTTP, não
todo o processamento remoto. Não se promete exactly-once físico.

Para mensagem/contato/nome, um manifesto anterior da mesma conversa/família
termina antes do próximo começar. A incerteza bloqueia apenas a lane do mesmo
destino/configuração. Destinos saudáveis da mensagem seguinte ainda executam;
outras conversas e a mensagem principal continuam elegíveis. Chatbot mantém a
lane causal da conversa porque os controllers compartilham estado de sessão.
Uma execução de chatbot incerta impede repetição e continuação causal insegura.
Notificações aninhadas e telemetria têm resultados próprios não causais: são
aguardadas e auditadas, mas sua incerteza não bloqueia a lógica principal do bot.

| Cenário | Comportamento implementado |
| --- | --- |
| Queda antes da tentativa de um destino | `pending` pode ser executado na recuperação do mesmo manifesto/ID. |
| Queda durante HTTP ou depois de efeito remoto sem checkpoint | `inflight` vira `outcome_unknown`; nenhuma nova execução desse destino. |
| Resposta perdida/erro depois de trabalho parcial | Destino incerto, sem retry automático; irmãos ainda podem executar. |
| Operação demora | Capacidade permanece ocupada enquanto a Promise acompanhada não termina. Deadline/abort não provam ausência de efeito. |
| Mensagem/callback original duplicado | Journal, efeito e manifesto reutilizam suas identidades; destinos confirmados/incertos não executam outra vez. |
| Sessão substituída ou lease perdida | Guardas e CAS impedem novos passos/aplicação local; efeitos eventualmente já iniciados permanecem incertos. |
| Configuração do destino mudou durante recuperação | Manifesto é fenced; não é redirecionado silenciosamente. Novas mensagens têm suas próprias configurações/intentos. |
| Destino indisponível | Tentativa rejeitada/ambígua fica incerta; não há reenvio automático sem cooperação/reconciliação. |
| Dois workers disputam a mesma família | Leases/CAS e predecessor por sequência limitam execução; recuperação de `inflight` não repete efeito. |

A APP é a exceção reconciliável: `ingress.profile` exige a mesma evidência já
correlacionada e Message ID reservado. Atualiza o snapshot complementar somente
quando ainda não aplicado/superado; repetição não repete update/callbacks. Não
cria evidência, não chama `InboundIdentityCapture`, não ativa writer e não muda
PN/LID. Sua falha recuperável permite retry desse contrato idempotente.

## Contratos de transporte usados

- Webhook: POST Axios aguardado, redirects desabilitados, timeout configurado e
  nenhuma chamada ao retry genérico legado. Destinos local/global separados.
- Socket.IO 4.8.3: `timeout(15000).emitWithAck`; espera os acknowledgements de
  clientes, não apenas o retorno síncrono de `emit`. Clientes sem ACK recebem o
  evento, mas a tentativa termina incerta e não é repetida.
- RabbitMQ: canal de confirmação separado, RPCs de exchange/queue/binding
  aguardados por callback e `publish` aguardado até publisher confirm ou erro.
- NATS: `publish` seguido de `flush`; confirma o transporte ao broker, não o
  processamento por consumidores.
- SQS: client dedicado com `maxAttempts: 1`, ACK com Message ID e identidade FIFO
  estável. Payload grande usa objeto S3 estável, com `etag` confirmado. A janela
  finita de dedup FIFO não autoriza replay posterior de uma incerteza.
- Pusher 5.3.3: aguarda a Promise de `trigger`, em vez de descartar seu retorno.
- Kafka: producer de tentativa sem retries de produção, `acks: -1` e conclusão
  aguardada; não chama os loops de retry do controller legado.
- Chatbot: sete controllers configuráveis, executados com resultados por
  controller. Debounce retorna Promise de seu callback final e usa chave com
  instância. O timer de envio de texto não engole rejeição. Callbacks de evento
  ignorados pelo chamador são registrados e drenados. O cliente OpenAI passa a
  ser isolado por contexto, com `maxRetries: 0` nesse caminho. Nenhum diretório
  de adapter n8n, workflow n8n ou BIA foi alterado.
- Telemetria configurada: no caminho secundário também tem tentativa acompanhada
  e limitada, com resultado independente da causalidade do chatbot.

Esses ACKs são específicos de transporte/API. Não são SERVER_ACK, DELIVERY_ACK
ou READ do WhatsApp. Nenhum adapter fabrica esses receipts.

## Histórico R1, retenção e limites

As novas seis definições usam versão 2 e lanes próprias. Registros R1 antigos em
`blocked_contract`/`outcome_unknown` não são reabertos, resignados ou convertidos
em novas operações automaticamente. Isso não é backfill das integrações que R1
deixou de executar. Seu tratamento posterior precisa conferir prova, tentativa,
payload ainda retido e dependências; payload já podado pode impedir reconstrução
segura. Não existe botão genérico de force-retry. Se a promoção exigir recuperar
integralmente esse histórico, essa decisão/operação continua pendente.

A retenção R1 de sete dias remove payloads/resultados grandes somente depois de
trabalho terminal. Para dispatch, preserva cada ID/destino/estado/tentativa,
timestamps, erros e digests em um resumo novamente assinado, incluindo referência
à assinatura e digest do manifesto original. Não apaga silenciosamente a
incerteza de um filho quando o pai terminou. Tombstones/auditoria permanecem;
cache de contato expirado é removido na recuperação periódica de retenção.

Os dados de transcrição e mídia continuam atualizando o registro original, sem
outro Message ID. Consulta de foto não retorna ao ingresso. S1/S2/S3, wake
coalescido do outbox e recuperação periódica permanecem. Não há atomicidade
Signal/PostgreSQL; a janela entre avanço Signal e commit do journal continua
fora deste trabalho.

## Revisão e verificações finitas

Revisão técnica direcionada feita pelo próprio Codex: composição fail-closed dos
patchers, contexto/HMAC do manifesto, checkpoints e crashes, predecessor e
isolamento por destino, cancelamento R1, isolamento do cliente OpenAI, callbacks
aninhados, autoridade de envio, perfil APP idempotente e retenção dos filhos.
As verificações encontraram e permitiram corrigir a normalização de JSON
arbitrário e uma sombra de variável que impediria a chamada do webhook.

Verificações offline executadas:

- `verify-ingress-r2.mjs`: sintaxe dos arquivos TypeScript gerados, todos os
  destinos/callbacks aguardados, recuperação sem replay de HTTP interrompido,
  destinos saudáveis e conversas independentes, HMAC do payload, execução real
  do novo adapter webhook com Axios simulado, capacidade, falhas engolidas,
  fencing e debounce real.
- `verify-ingress-r1.mjs`: cinco regressões R1 aprovadas, incluindo API real do
  SDK Chatwoot com transporte simulado e espera pelo executor após cancelamento.
- APP: `ruby -c` nos dois receivers; `script/verify_ingress_r2_profile.rb` executa
  a projeção real com objetos em memória, comprova mesmo ID, update único e
  ausência de alterações de evidência/associação.
- `git diff --check` e conferência dos overlays enterprise relacionados (nenhum
  override correspondente).

Não houve Rails boot, banco, migration executada, envio real, build, typecheck,
browser, infraestrutura ou deploy. Os brokers e os sete backends de chatbot não
foram validados em runtime real. A composição verificada é de fonte; bundle/
imagem final ainda exige o pipeline posterior autorizado. A latência de 2–3
segundos não foi medida nem declarada atingida.

## Arquivos, migration e ordem posterior de deploy

Evolution: `nexi-ingress-dispatch.cjs`, `ingress-event-adapters.ts.inc`,
`patch-ingress-integrations.mjs`, `ingress-effects.ts.inc`, `nexi-ingress.cjs`,
`nexi-ingress-effects.cjs`, `nexi-transport.cjs`, `patch-ingress-source.mjs`,
`ingress-models.prisma`, `Dockerfile`, verificações R1/R2, migrations e documentos.
O novo patcher roda depois da composição S4/R1; o helper permanece externo ao
bundle e é copiado para a imagem final.

Migration Evolution `20261015000002_nexi_ingress_contact_cache` (PostgreSQL/MySQL;
psql_bouncer usa PostgreSQL): cria cache com escopo e adiciona versão/lane causal
e índice aos efeitos. Destinos usam rows `dispatch_destination` nas lanes
secundárias existentes. Manifestos permanecem no JSON do efeito. APP não exige
migration nova, mas exige os dois receivers R2 para aceitar `ingress.profile`.

Posteriormente, com autorização de deploy: preservar todos os pré-requisitos
S4/R1; instalar APP R2; parar todos os workers Evolution antigos; aplicar as
migrations Evolution pendentes na ordem; iniciar imagem/cliente gerado R2 de
forma coordenada. Não misturar workers antigos/R2 nem fazer rollback que ignore
os novos estados/intentos. Nenhuma dessas ações foi executada nesta tarefa.
