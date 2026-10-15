# NEXI V23-PROD-12-S1 — latência, backlog e confirmações

Veredito: **PARTIAL — SPECIFIC DEFECT IDENTIFIED**.

Há um defeito específico no call site da consulta de contatos usada pelo fallback
LID, com patch candidato. A causa operacional dos atrasos de 2–5 minutos e da
ausência de receipts do teste de 15/10 permanece **OPERATIONAL EVIDENCE REQUIRED**.
O patch LID não deve ser apresentado como solução desses dois incidentes.

## Escopo e proveniência

- Overlay: `paropeba22/evolution-24-lab`, base
  `b9b625caf411837d0a280b9ee627c05bd4508bdd`.
- Branch candidata: `fix/v23-prod-12-s1-latency-receipts`, criada diretamente da base.
- Upstream local limpo `../evolution-reference`, HEAD
  `e273b904d53f5726970fd6a244ed9caa61dfeb9a`.
- Baileys: código local preexistente `../v83-attestation-evidence/package`, cujo
  `package.json` declara `7.0.0-rc13`. O lock upstream e os guardas do patcher exigem
  essa versão e a integridade aceita. Não se instalou nem se executou dependência.
- APP: leitura auxiliar do checkout `../../isp-platform-v23-prod-11-s4`, HEAD
  `223d00ad4336a54662c8af1ed3dae49c495eed0a`, apenas para contratos de intake/redução.
  Esse checkout não comprova qual revisão está implantada.

Somente leitura/edição de código e Git. Nenhum teste, parser, lint, build, patcher,
migration, container, browser, SSH, consulta de produção, envio, reprocessamento,
restart, deploy ou promoção executado. Nenhuma alteração na VPS antiga, suas
instâncias, automações, n8n ou BIA. Nenhuma evidência operacional nova foi coletada.
Message #830 não é usada como prova de falha física: a negativa da APP é distinta
da preparação inicial aprovada.

## A. Entrada e primeiro bloqueio potencial

Fluxo efetivo, considerando a ordem dos patches do Dockerfile:

`WhatsApp → socket Baileys → processNode → handleMessage/decrypt/upsertMessage
→ event-buffer → ev.process → eventProcessingQueue.then → interceptEvents
→ findSettings → messaging-history.set → messages.upsert → Chatwoot/receiver APP`.

Há dois níveis anteriores à fila Evolution: nodes offline são processados
sequencialmente pelo Baileys, incluindo message/receipt/notification/call;
eventos bufferizáveis são consolidados antes de `ev.process`. Um atraso antes
desse callback não pode ser atribuído à fila Evolution sem timestamps.

Dentro da fila Evolution, o primeiro await inserido pelo overlay é
`nexi-groups.cjs::interceptEvents` (a função pode aguardar ingestão/invalidação de
grupos no mesmo lote). Para um lote exclusivamente direto sem essas operações,
o primeiro await de I/O é `findSettings`, uma consulta Prisma por `instanceId`.
`lifecycleAwait` verifica a validade antes/depois; não acrescenta deadline.

Referências upstream: `whatsapp.baileys.service.ts:265,1043,1270,2109`;
`channel.service.ts:202,435`. Overlay: `patch-groups-source.mjs` nos anchors de
`ev.process`, `findSettings`, `connection.update` e `creds.update`;
`nexi-groups.cjs::interceptEvents/lifecycleAwait`.

## B. O que prova backlog e o que ainda falta

O callback de `ev.process` acrescenta uma closure a
`this.eventProcessingQueue = this.eventProcessingQueue.then(async () => ...)`
e termina sem retornar/aguardar essa cadeia. O produtor pode continuar enfileirando.
Não há contador/limite de itens, admissão por capacidade nem deadline global
dessa fila. Não se encontrou descarte seguro ou cancelamento do trabalho pendente.

**Demonstrável:** um await que leve 60 s retém o restante daquele lote e todos os
lotes seguintes da instância por pelo menos esse intervalo. Um await que nunca
resolva impede o avanço indefinidamente. O `catch` permite avançar quando uma
operação rejeita; ele não resolve uma Promise permanentemente pendente.
Reiniciar pode remover essa fila em memória, mas a melhora relatada não identifica
a operação lenta nem comprova a durabilidade dos eventos removidos.

**Ainda não demonstrado:** qual await reteve a OVH, profundidade/idade reais da
fila, taxa de chegada versus processamento, saturação de banco/CPU/event loop,
ou o mesmo mecanismo na VPS antiga. O compartilhamento de upstream/rc13 sugere
pontos de inspeção comuns, mas não comprova igualdade de configuração/artefato.

Mecanismos temporais encontrados:

| Mecanismo | Valor no código | Interpretação permitida |
| --- | --- | --- |
| Query Baileys `defaultQueryTimeoutMs` | 60 s | consultas ao WhatsApp podem aguardar aproximadamente um minuto |
| Event buffer rc13 | auto-flush 30 s; pequenos flushes de 100 ms | há agrupamento antes da fila; não é um flush fixo de 60 s |
| `profilePicture` após cada mensagem | aguarda `profilePictureUrl`; usa query Baileys | possível retenção de até a ordem de 60 s, precisa medir |
| Identidade `managedObservation` | até 3 requests de 10 s + pausas 1–1,5 s e 2–2,5 s | cerca de 33–34 s por chamada com falhas/timeout; há chamada de correlação adicional quando aplicável |
| Perfil autenticado `contactProfile` | race de 2 s, cache de 6 h | espera limitada na fila; query subjacente pode continuar |
| Outbox Atendimento | polling 5 s, POST 10 s, backoff até 300 s | atraso de evidência/callback; não é o relógio de recepção das mensagens diretas |
| Keepalive/conexão | 30 s | não constitui pacing intencional de mensagens |

Esses valores são limites/configurações, não durações mínimas nem atribuição do
incidente. Em particular, o agrupamento perto de 60 s é compatível com consultas
lentas repetidas, mas não prova essa hipótese. Não se alterou timeout ou fila.

## C. Histórico, mensagens novas e mensagens próprias

No mesmo lote, `messaging-history.set` é aguardado antes de `messages.upsert`,
`messages.update` e `message-receipt.update`. O histórico consulta chats e IDs de
mensagens da instância, prepara lotes, pode persistir `createMany` e aguarda
`contacts.upsert`. Essa rotina pode consultar fotos por contato. Portanto, uma
mensagem nova paga o trabalho histórico anterior, inclusive quando veio em
outro lote já enfileirado. Desabilitar histórico indiscriminadamente não é patch:
o rc13 alerta que essa sincronização participa das associações iniciais LID.

`messages.upsert` percorre cada item sequencialmente. Antes de encaminhar a
mensagem ao Chatwoot/APP, pode aguardar consulta de chat, perfil/associação de
identidade autenticada, read receipt e processamento Chatwoot. Depois ainda pode
aguardar correlação da identidade, transcrição, persistência, cache, download e
upload de mídia, contato/foto e atualização de contato. A foto genérica após a
mensagem não usa o cache/deadline de 2 s de `contactProfile` e pode atrasar o próximo
item mesmo quando o anterior já apareceu na APP.

Não há exclusão geral de `fromMe` nem de `append`. Ecos de outros dispositivos e
histórico podem consumir processamento, banco e consultas mesmo sem criarem uma
associação autenticada de entrada. O filtro de CTA financeiro é específico;
não deve ser ampliado para descartar toda mensagem própria.

Distinção de await: `sendDataWebhook(MESSAGES_UPSERT, ...)` e os webhooks do
histórico são disparados sem await nesse caminho. Não é correto afirmar que os
retries HTTP desse webhook bloqueiam diretamente a fila. Já
`chatwootService.eventWhatsapp` e `managedObservation` são aguardados.
`chatbotController.emit` retorna sem aguardar os controllers de bots que dispara;
o await externo também não prova que a fila espera pela resposta completa da BIA.
Essas operações ainda podem competir por recursos compartilhados.

A correção de isolamento por item já existe em `3f81bbb`, ancestral da base.
Ela permite continuar após exceção em item NEXI, mas não contorna item lento.
Nenhuma fila paralela, mudança de ordem ou descarte foi introduzido.

## D. Saída e observação de 8–10 segundos

Preparação cria/persiste candidato e faz requests autenticados de attempt/reserve/
readback. A APP decide admission/grant/release. O endpoint authority valida o
envelope e consome a release sob transação/guards, antes de chamar `dispatch`.

O trecho físico é:

`dispatch → conteúdo imutável → releasedGrantCapability → client.sendMessage
→ generateWAMessage/relayMessage → dispositivos/sessões/criptografia/tctoken
→ sendNode → snapshot/assertNode → dispatchStart → encodeBinaryNode
→ sendRawMessage → Noise → ws.send(callback)
→ commit das chaves Signal → retorno de sendMessage → conferência de ID/JID
→ transportReturned → resposta assinada da authority`.

O CAS `dispatchStart` está imediatamente antes da codificação/escrita, e não na
entrada de `dispatch`. Antes dele, há um refresh HMAC da APP, validações de
identidade/sessão/owner e transação com lock e CAS. Deadline de request de contexto
é 10 s; transações específicas usam `maxWait:3000, timeout:10000`. Não são sleeps.
Anexos ainda precisam baixar/verificar bytes da APP (deadline de 60 s), e preparar
mídia no Baileys. Isso não se aplica ao texto `teste nexi`.

Esse caminho de Atendimento **não usa** `sendMessageWithTyping`, presence/delay
do endpoint legado, nem o delay de 500 ms do webhook Chatwoot. Não há piso de
8–10 s ou mecanismo que garanta envio em 2–3 s. Consultas de dispositivos e
sessões frias, locks/pool de banco, HTTP APP e filas de chaves podem somar latência.
O código não demonstra qual delas ocorreu no teste.

A fila Evolution não envolve diretamente a requisição authority/dispatch. Há
competição indireta por banco, socket, event loop e estado Signal. O cache de
chaves rc13 usa mutex em torno do I/O; transações Signal têm mutex/queues próprios.
O commit pode tentar até 10 vezes, com 3 s entre falhas, conforme socketConfig.
Essas esperas não foram medidas. A rotina de emissão de tctoken após o envio é
fire-and-forget; não se deve somar sua duração integral ao retorno do método.

Separação necessária: criação/commit e fila na APP → início da chamada Evolution
→ entrada em dispatch → CAS → escrita socket → retorno do método → receipt.
O relógio visual do celular agrega fases e rede/WhatsApp. Não se atribuem os
8–10 s inteiros à Evolution. A meta de 2–3 s requer medir e reduzir a fase que
efetivamente dominar, preservando os gates existentes.

## E. Receipts, journal, outbox e APP

1. `CB:receipt → processNode → handleReceipt` deriva `remoteJid`, `fromMe`,
   `participant` e todos os IDs do stanza segundo o rc13.
2. O patch chama `capture(config, attrs, key, ids)` antes de `receiptMutex`,
   `ev.emit` e consolidação do buffer. Não depende de `messages.update` chegar
   ao `eventProcessingQueue` Evolution.
3. `ReceiptWorker` limita itens/bytes/concorrência/deadline. Um cliente Prisma
   dedicado grava **journal + outbox na mesma transação**, com dedupe por
   `instanceId/sourceKey`. Falha não vira confirmação positiva.
4. Um timer global a cada 5 s drena instâncias sequencialmente; por instância,
   até 20 eventos, um POST por vez. Cada request tem timeout 10 s. Enquanto
   `running` é true, ticks são ignorados. Exemplo condicional: seis POSTs que
   gastem 10 s ocupam cerca de 60 s, antes de outras instâncias/recuperações.
5. Callback usa UUID durável, corpo/fingerprint canônicos e HMAC renovado.
   Somente ACK `persisted` com UUID/fingerprint/version coincidentes fecha o
   evento. Há backoff, quarantine após 12 tentativas, estados `unsupported` e
   `binding_unavailable`. Repetir callback não repete envio WhatsApp.
6. Na APP inspecionada, `ReceiptReceiver` persiste evidência antes de responder;
   isso não significa que `ReceiptReducer` já correlacionou/projetou a mensagem.
   A aplicação pode ficar pending/quarantined/historical_only. Correlação exige
   namespace/lineages, atestação histórica, external ID e PN/LID da versão
   autenticada; `participant` precisa ser nulo para esse envio direto.

Semântica rc13 compatível no caminho implementado: receipt `sender` → SERVER_ACK,
sem `type` → DELIVERY_ACK, `read/read-self` → READ, `played` → PLAYED. `retry` e
tipo desconhecido não promovem status. Incoming permanece UNKNOWN. Bad ACK com
`attrs.error` é capturado separadamente como ERROR, sem envio automático.
Não foi encontrada divergência concreta nessas regras em relação ao rc13 lido.

Limitação concreta de cobertura: `CB:ack,class:message` chama `handleBadAck`, e o
hook customizado desse caminho só captura quando há `attrs.error`. Um ACK de
mensagem sem erro não é journalizado por esse hook. O receipt `sender` é outra
fonte de SERVER_ACK suportada. Não se conclui que toda mensagem tenha de produzir
esse receipt. Acrescentar confirmação de ACK cru exige preservar origem e um
contrato correspondente na APP; não se forjou receipt `sender` nem status a
partir do simples retorno do socket. Essa limitação, sozinha, não explica a
ausência de DELIVERY_ACK/READ de uma mensagem recebida no celular.

Perdas/lacunas possíveis no código: contexto de captura ausente/ambíguo,
repository/limites indisponíveis, JID fora do contrato, pacote com mais de 128 IDs
(normalização retorna vazio e sinaliza gap), saturação/timeout/erro de append.
Recovery em memória também é limitado e não sobrevive a crash; a saúde fica
marcada como evidence_gap. Uma operação de banco ainda pendente ocupa sua vaga
até terminar. Receipts offline podem esperar a fila offline Baileys; captura
aguardada também adia o ACK do receipt ao WhatsApp. Não se demonstrou que algum
desses caminhos ocorreu no teste.

`transportReturn` pode faltar depois da escrita física: processo/socket pode
falhar; commit Signal, validação do retorno, releitura ou persistência podem
falhar depois de `ws.send`. A base já contém a correção do filtro JSON Prisma
(`b9b625c`); não se reaplicou o defeito antigo. Retorno bem-sucedido continua
`outcomeUnknown:true`: retorno local não é aceitação pelo servidor, entrega ou
leitura. A entrega observada no celular é evidência humana, não receipt técnico
correlacionado que o reducer possa fabricar.

**Conclusão:** nenhum defeito determinístico novo explica a falta de confirmação
do envio de 03:37. É necessário localizar a primeira ausência entre captura,
journal, outbox, intake e redução. Não se limpou outcome_unknown.

## F. Erro LID e patch mínimo

Caminho localizado no upstream:
`eventWhatsapp → resolveLidToPhone → findContactByIdentifier → clientCw`.
`clientCw` constrói `new ChatwootClient({config: ...})`; a consulta usa
`(client as any).get('contacts/search', ...)`, e o fallback usa `.post(...)`.
São chamadas de interface Axios aplicadas à raiz do SDK. O restante do serviço
usa `client.contacts.search` ou `chatwootRequest(config, {method,url,body})`.
O artefato local preexistente `../evolution/dist/main.js` preserva precisamente
`let e=await this.clientCw(...); ... e.get("contacts/search",...)`, correspondendo
ao símbolo do erro relatado. Esse artefato é auxiliar, sem prova de equivalência
com a imagem OVH. O código interno do pacote SDK não estava disponível para
leitura no checkout; falta o stack operacional para ligar inequivocamente o
incidente a esse call site, em vez de outro `.get` minificado.

Patch em `patch-attendance-source.mjs::patchAttendanceContactLookup`: troca apenas
os dois requests inválidos pelo helper HTTP já importado/usado no próprio
upstream, com caminho explícito `/api/v1/accounts/${this.provider.accountId}`,
query/body equivalentes, credenciais/config e interpretação da resposta
preservadas. Anchors exatos falham fechado antes da escrita de qualquer arquivo.
Integra-se à transformação Chatwoot existente, sem novo módulo ou Docker layer.

O `catch` de `resolveLidToPhone` registra o aviso e retorna null; a exceção
imediata não deixa a Promise da fila permanentemente pendente. Pode impedir a
identificação do contato nessa via ou levar a `conversation not found`.
Entrada NEXI com associação autenticada já pula a heurística; managed inbound
sem associação continua rejeitado. Mensagens próprias sem essa associação ainda
podem entrar no fallback. `nexi_identity_association_rejected` é outro catch,
associado à operação assinada de identidade, e não prova a mesma causa.

O patch não altera a política de escolha/associação PN/LID, resposta da APP,
barreira, grants/TTL, single writer, CAS/fencing, sender attestation, sessão/owner,
HMAC, isolamento de provedores, dedupe ou política de não reenvio. Não libera
envio direto do Manager. Seu impacto esperado é remover o erro de interface
nessas consultas; não reduzir comprovadamente o backlog.

## G. Entrega e revisão

Mudança funcional: somente `patch-attendance-source.mjs`. Relatório:
`V23-PROD-12-S1-INVESTIGATION.md`. Branch indicada acima; o SHA é informado na
entrega após o commit. Sem push ou PR. Validação feita por leitura dos anchors,
ordem de aplicação no Dockerfile e diff Git; nenhuma validação executável.
O candidato precisa de revisão e validação em etapa autorizada antes de uso.

## H. Três conjuntos indispensáveis para Luna

Solicitações somente de evidência; esta missão não as executa e não autoriza
reinício, envio adicional ou alteração em produção. Não incluir conteúdo,
credenciais, tokens, assinatura HMAC, sessão secreta ou telefones integrais.

1. **Trace de entrada da instância OVH afetada**, na janela 14/10/2026
   18:55–19:15 BRT (21:55–22:15 UTC): para os mesmos external IDs, timestamp de
   chegada ao handler Baileys, enqueue/start/end do lote Evolution, categoria/
   quantidade de eventos e início/fim do await em curso; horário de intake APP.
   Critério: `queue_start - enqueue` crescente demonstra fila; `enqueue - raw`
   alto localiza atraso anterior. O await dominante identifica o responsável.
   Esses marcos não estão todos instrumentados na base: se não houver trace
   existente, declarar indisponível, sem inferir do log agrupado. Uma captura
   futura desses marcos exige etapa operacional própria; sem ela, não há prova
   retrospectiva suficiente para mudar ordenação/paralelismo.
2. **Uma correlação completa do texto `teste nexi` de 15/10 às 03:37 BRT
   (06:37 UTC), sem reenviar**: image digest/revisão efetiva; Message/attempt/
   preparation/externalId; timestamps APP commit/job/request, Evolution
   releaseConsumedAt/dispatchStartedAt/transportReturn e escrita socket se já
   registrada. Para esse mesmo `(instanceId, externalId)`, todas as rows de
   `NexiReceiptJournal`, outbox por sourceKey e receipt/application/projection
   APP, com status, capturedAt/createdAt/acknowledgedAt, attempts/nextAttemptAt,
   razão de pending/quarantine e presença/igualdade dos IDs de linhagem/atestação.
   Ausência de row deve ser explícita. Anexar os `attendance.evidence_gap` dessa
   instância na janela de ±2 min. Isso distingue falta de captura, entrega do
   callback, correlação e retorno, e decompõe os 8–10 s sem novo envio.
3. **Um único stack completo de `TypeError: e.get is not a function`** já
   registrado, com prefixo da mensagem (`Error resolving LID from database` ou
   outro), timestamp, instância e referência linha/coluna do bundle. Confrontar
   com a imagem efetiva do item 2. Critério: frame em
   `findContactByIdentifier` confirma a atribuição operacional do defeito de
   interface; frame diferente exige diagnóstico próprio.

Não há recomendação de promoção canônica. Os dois sintomas principais permanecem
abertos até a evidência apontar a primeira divergência real.
