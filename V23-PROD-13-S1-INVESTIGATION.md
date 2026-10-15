# NEXI V23-PROD-13-S1 — receipts, outbox preparado e entrada

**Veredito: RUNTIME EVIDENCE REQUIRED.**

Evolution analisada: `09cefdfac9e9bd6af1fd25eef0f84fdee11ca55c`,
`paropeba22/evolution-24-lab`. APP analisada, sem alterações:
`232a3f635e8baaa03879f82a9c7c4eebdedebf37`, `paropeba22/isp-platform-lab`.
Branch local: `candidate/v23-prod-13-s1-ingress-measurement`, pai direto Evolution
acima. O commit desta nota contém somente a medição C e esta investigação.

Evidência operacional recebida no pedido: #926 e #927 em `transport_returned`,
sem ReceiptJournal/receipt APP; criação do outbox preparado → acknowledged de
3,649 s e 0,701 s, respectivamente; relato de entrada com 2–3 minutos de atraso.
Não foram fornecidos no pedido os stanzas, logs por estágio, IDs externos ou
timestamps individuais do Luna L4. Não se afirma ter consultado esses dados.

## A. Receipts: lacuna comprovada, causa das duas mensagens não demonstrada

Fonte rc13 lida: cópia local de `baileys@7.0.0-rc13`,
`tmp/v83-attestation-evidence/package/lib/Socket/messages-recv.js`, SHA256
`850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710`.
É o hash exigido por `patch-trusted-baileys.mjs`; não se executou patcher.
Foram lidos também `generics.js`, `socket.js`, `messages-send.js`,
`event-buffer.js` e `offline-node-processor.js` desse pacote.

Cobertura efetiva de `patch-attendance-source.mjs:266–284`:

| Entrada rc13 | Captura atual |
| --- | --- |
| `CB:receipt` online → processNode → handleReceipt | capture aguardada antes de receiptMutex/emit/consolidação |
| Receipt offline | Mesmo handleReceipt, depois da fila offline serial Baileys |
| `CB:ack,class:message` com attrs.error | captureBadAck antes de recuperação secundária/emit de ERROR |
| `CB:ack,class:message` sem attrs.error | handleBadAck termina sem capture, journal ou messages.update |
| Retorno de sendMessage/sendNode | Não é fonte de receipt |

O último caminho de ACK é uma **lacuna determinística de cobertura**, já presente
na baseline. Não é prova de que tenha recebido os ACKs de #926/#927, nem explica
a ausência de DELIVERY_ACK/READ. A ausência de erro em ACK cru não pode ser
disfarçada como receipt `sender`: a origem seria diferente, e os validadores
Evolution/APP aceitam apenas `handleReceipt.pre_buffer` e `handleBadAck.pre_buffer`
com erro. Sem stanza real e identidade do destinatário desse caminho, não há
correção demonstrada de normalização/correlação a aplicar. Nenhum novo status,
origem de receipt ou fallback pelo retorno de transporte foi introduzido.

Derivação rc13 preservada:

- `isNodeFromMe` compara participant/from com me.lid quando from contém lid,
  ou com me.id nos demais casos. `remoteJid` é from, exceto quando é origem
  própria fora de grupo, quando usa recipient.
- `fromMe = !attrs.recipient || ((type === retry || type === sender) && isNodeFromMe)`.
  O hook usa esse booleano, sem inferir ownership pelo ID ou pela preparação.
- IDs: attrs.id e IDs dos filhos item de content[0]. Bad ACK usa key.id, from
  como remoteJid, fromMe=true e participant dos attrs.
- Normalização remove apenas sufixo de device; aceita PN e LID estritos,
  sem transformar LID em telefone. IDs são deduplicados e filtrados por formato.
- Outgoing: sender→SERVER_ACK; type ausente→DELIVERY_ACK; read/read-self→READ;
  played→PLAYED; retry/outros→UNKNOWN. Incoming permanece UNKNOWN. Bad ACK
  com erro produz ERROR apenas em outgoing. Isso coincide com STATUS_MAP rc13.

Antes do journal, `capture` pode retornar por registro/contexto ausente, endereço
fora de PN/LID, repository indisponível ou limites não configurados. Normalização
pode retornar vazio por sessão inválida, fromMe não booleano, IDs inválidos ou
pacote acima de 128 IDs. Worker pode sinalizar saturação, deadline e falha de
append; recovery em memória é limitado. O append mantém journal e outbox na mesma
transação. As razões já possuem diagnósticos limitados na baseline.

Antes de handleReceipt, `processNode` pode descartar shouldIgnoreJid ou aguardar
fila offline. O shouldIgnoreJid do upstream fixado filtra grupos/broadcast/newsletter,
sem regra de descarte para DM PN/LID ordinária. Um parser/erro anterior à chamada
também não produz journal. Isso é análise de caminhos, não ocorrência confirmada.

Ausência de journal localiza a primeira lacuna antes/no commit de captura;
intake/reducer APP não explicam sozinhos essa ausência na Evolution. A APP mantém
autenticação, provenance, correlação PN/LID/lineages e aplicação separada da
evidência. `transport_returned` não comprova ACK, entrega ou leitura.

Mínimo de evidência runtime ainda necessário, sem reenvio: para IDs externos
correlacionados, observar qual callback real ocorreu (receipt ou message ACK),
presença de erro, classe limitada de endereço, tipo limitado e contagem de IDs;
correlacionar por ref HMAC com pre_buffer/append/gap já existentes. Não coletar
stanza bruto, telefone, payload, token ou erro livre. Se houver apenas ACK sem
erro, será necessário definir sua origem/identidade no contrato antes de admitir
um novo receipt. Não se implementou esse contrato por hipótese.

## B. 3,649 s: mecanismo conhecido, decomposição observada ausente

`prepare` grava estado frozen e `attendance.transport.prepared` na mesma
transação. `enqueue` define pending/nextAttemptAt agora; após commit não chama
drain nem agenda wake imediato na Evolution.

`installRoutes` tem timer de 5.000 ms, com running que ignora ticks sobrepostos.
Seleciona até 20 instâncias, drena cada uma serialmente; drain seleciona até 20
eventos por instância, em createdAt ascendente, com lease/CAS, um POST por vez.
Depois executa recuperação de preparações e workers no mesmo ciclo. Cada POST
tem timeout de 10 s; falha conserva UUID/body e usa backoff. Timeout não é tempo
observado, e o intervalo do timer não é um teto de espera sob backlog.

O período criado→acknowledged contém commit/visibilidade, espera até seleção,
trabalho anterior no ciclo, binding/seleção/claim, HTTP, verificação e transação
APP, callbacks after_commit e atualização CAS do ACK na Evolution. Os valores
3,649 s e 0,701 s são compatíveis com fases diferentes do polling; não provam
quanto cada fase consumiu. Não existe sleep fixo de 3,649 s.

Na APP, `TransportFoundation.observe!` valida a preparação e persiste prova sob
locks antes de responder ack=persisted. `PreparationVerifier.persist!` adianta
due_at. `NexiAttendanceFoundationObservation.after_create_commit` consulta
orquestrações sem lease, atualiza due_at e chama perform_later antes de o fluxo
do callback retornar. Esse trabalho pode integrar a latência HTTP. A execução
do job enfileirado não precisa terminar para o outbox ser acknowledged.
O job usa scheduled_jobs; scanner cron é a cada 5 minutos, lease é de 90 s e
recuperação sem progresso tem backoff. Esses tempos pertencem à orquestração;
não devem ser confundidos com o ACK do outbox.

Medição já disponível, sem nova instrumentação B: localizar o mesmo event_id em
`attendance.prepared_outbox` delivery_started/delivery_ended (outbox_age_ms,
duration_ms, outcome). Age no início aproxima espera até após o claim;
duration_ms mede monotonicamente entrega→persistência ACK, incluindo callback.
Só usar ack_persisted como sucesso desse evento. createdAt vem do banco e age
usa relógio JS: confirmar compatibilidade de relógios antes de atribuir deltas.
Logs são limitados; ausência não comprova ausência da fase.

Não foi demonstrada uma otimização necessária para #926. Wake após commit ou
mudança de tick demandaria avaliar serialização/fairness e carga; não se alterou
polling, concorrência, ordering, CAS, lease ou idempotência por suspeita.

## C. Uma medição adicional: ingresso Baileys → observeInbound

A baseline já mede pré-emit chats.js→ev.process como buffer_age_ms,
enqueue real→início da eventProcessingQueue como queue_age_ms e início do lote
→item como pre_item_ms. Mantém duração do handler e waits internos. O buffer rc13
preserva os objetos de mensagem no caminho normal, permitindo os WeakMaps;
histórico puro ou absorção no histórico não garante a mesma trilha de upsert.
Os logs são amostrados/limitados, não um inventário integral.

O primeiro marcador atual, observeInbound, é posterior à fila offline,
messageMutex, mapeamento PN/LID, decrypt e admission/tratamento anteriores ao
upsert. Portanto não consegue medir essas esperas nem o tempo anterior ao
callback Baileys. Não há prova de culpa da eventProcessingQueue nos 2–3 minutos.

Única medição acrescentada: `receiveInbound(config,node)` no início de
`CB:message`, antes de processNode/shouldIgnoreJid/fila offline. Guarda UTC e tick
monotônico em WeakMap do próprio node e passa node a observeInbound. O processor
offline usa esse mesmo objeto; a observação transfere só números ao span e apaga
a entrada. Não há timer, fila, HTTP, SQL ou await novo.

| Campo/estágio | O que permite localizar |
| --- | --- |
| baileys_received / received_at_ms | Callback JS de stanza já decodificado, antes do processamento local |
| receive_to_observe_ms | Espera local agregada até observeInbound: offline/mapping/mutex/decrypt/admission |
| stanza_clock_delta_ms | Relógio local na chegada menos attrs.t em segundos; indicação de idade anterior ao callback, sujeita ao relógio remoto |
| buffer_age_ms existente | Emit de upsert → enqueue na fila Evolution |
| queue_age_ms existente | Enqueue → início da eventProcessingQueue |
| pre_item_ms e duration_ms existentes | Espera dentro do lote e processamento do item |

Uma trilha com receive_to_observe alto identifica atraso local anterior ao
observeInbound; buffer_age alto identifica espera de buffer; queue_age alto
identifica a fila Evolution. Stanza_clock_delta alto com tempos locais baixos
aponta para antes do callback ou diferença de relógios, sem provar rede/WhatsApp.
O callback é posterior ao decode do socket; bloqueio do event loop anterior a ele
e atraso remoto continuam juntos. attrs.t tem resolução de segundos e não é
prova do instante de envio humano. Não se promete isolar essas causas com esta
medição mínima.

Somente DM PN/LID com contexto diagnóstico já disponível. Ref HMAC opaca de 24
hexadecimais; UTC, durações inteiras e delta de relógio limitado a ±7 dias. Campo
inválido fica ausente. Sem telefone, JID, ID externo cru, conteúdo ou credenciais.
Fluxo saudável segue amostragem 1/64; idade/duração ≥1 s usa a via lenta existente.
Ambos passam por throttle/TTL/tetos e budgets globais compartilhados da baseline
(sampled 120/min, slow 60/min, failed 60/min), sem aumentar limites. O novo estágio
consome esses saldos e pode suprimir outras linhas diagnósticas. Não há garantia
de registro individual nem overhead medido; todos os helpers falham sem alterar
processamento. Registro/contexto ausente e outros domínios ficam fora da medição.

## Entrega e restrições

Arquivos funcionais alterados: `nexi-attendance.cjs` e
`patch-attendance-source.mjs`; esta nota é o terceiro arquivo. APP inalterada.
Nenhuma correção comportamental de receipts/outbox foi alegada ou aplicada.
WriterBarrier, autorização, HMAC de transporte, PN/LID, CAS, ordering,
idempotência, receipts e outcome_unknown preservados no delta.

Revisão exclusivamente textual: diff Git, hooks/âncoras e fontes fixadas.
Sem testes, parser, lint, build, execução de patcher, migration, produção, SSH,
EasyPanel, deploy, promoção, push, reenvio ou alteração de BIA/n8n/Evolution antiga.
Composição do patcher, sintaxe e overhead não validados executavelmente.
