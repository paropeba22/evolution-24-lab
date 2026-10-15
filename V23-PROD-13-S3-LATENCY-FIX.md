# NEXI V23-PROD-13-S3 — candidata parcial de latência

**Veredito: PARTIAL FIX — SPECIFIC BLOCKER.**

Repositório: `paropeba22/evolution-24-lab`.
Baseline obrigatória e pai direto: `a62dd0831f72367bbda26520be8d637a1e8678e6`.
Branch: `candidate/v23-prod-13-s3-latency-fix`.

Implementação baseada nos relatórios S1/S2 já presentes nesta baseline. Não houve
nova auditoria S1/S2/L3/L4 nem acesso operacional.

## Esperas removidas

- Removida a chamada `contactProfile` antes de `identity.observed`: não há mais
  consulta de foto, espera local de até dois segundos ou consulta subjacente
  sobrevivendo ao `Promise.race` nesse ponto do ingresso.
- A atualização de contato posterior ao webhook não consulta mais
  `profilePicture` para DMs recebidas PN/LID de instâncias `nexi-wa-*`. Usa apenas
  `contact.profilePicUrl` da consulta por instância/JID que o handler já fazia.
  Isso retira também essa espera que retinha a próxima mensagem da fila.
- O commit de uma preparação passa a sinalizar a drenagem imediatamente. Uma
  nova preparação não depende exclusivamente do próximo tick de cinco segundos.

O nome público continua vindo do stanza autenticado. O payload de identidade
mantém `contact_profile`, com os campos de avatar nulos. Fotos novas/atualizações
automáticas deixam de ser buscadas nesse ingresso; fotos já persistidas são
preservadas. Esta é uma limitação funcional deliberada da candidata, e não uma
fila de enriquecimento que promete completar o trabalho posteriormente.

`managedDirectMessage` é somente uma classificação para apresentação; não
concede identidade/autorização. As capacidades de objeto do decrypt, PN/LID,
sessão, associação obrigatória e binding Chatwoot continuam nos caminhos originais.
Grupos e demais caminhos não recebem essa supressão de consulta de foto.

## Wake do outbox e recuperação

O wake ocorre depois de a Promise de `$transaction` confirmar o commit que
grava conjuntamente a preparação frozen e `attendance.transport.prepared`.
A leitura idempotente de uma preparação já congelada também pode sinalizar
trabalho persistido. Não há wake dentro da transação.

Um consumidor por objeto repository atende tanto os sinais quanto o polling.
Um Map limitado a 256 instâncias coalesce sinais, preserva a posição de quem já
estava aguardando e coloca uma instância novamente sinalizada durante sua
drenagem no final da fila. Há no máximo uma chamada de `drain` ativa por
repository neste processo, com o lote original de até 20 eventos por turno.
Não se cria uma tarefa HTTP por preparação.

Esse Map contém somente dicas descartáveis. UUID, body, fingerprint, estado,
nextAttemptAt, lease e confirmação continuam em `NexiAttendanceEventOutbox`.
Saturação das dicas, morte do processo ou falha de drenagem deixam os eventos
persistidos. O polling de cinco segundos continua buscando trabalhos pendentes,
inclusive de instâncias descarregadas, e os entrega ao mesmo consumidor.
O período do timer não constitui um teto de latência sob backlog.

`drain` não foi alterado: seleção do mais antigo elegível, limite por lote,
lease/CAS, timeout HTTP, backoff, UUID/body imutáveis, validação de ACK,
quarentena e tratamento de binding permanecem. Entre processos, o fencing
continua dependendo do lease/CAS existente, sem nova promessa de exclusão
distribuída. A recuperação de preparações continua limitada a seus estados
originais; pode rodar enquanto o consumidor publica metadados persistidos.

Não há chamada nova ao dispatch físico, admission, release ou sendNode.
WriterBarrier, HMAC, fencing de socket/sessão, receipts, `transport_returned`,
`outcome_unknown`, autorização e isolamento de provedores não são alterados.

## Bloqueio específico da correção A completa

`identity.observed`, criação Chatwoot e `identity.correlated` ainda são aguardados
na `eventProcessingQueue`; seus HTTPs/retries continuam podendo atrasar DMs
seguintes. Não se declara removido o congestionamento integral do recebimento.

A baseline não contém um journal de ingresso com checkpoints que una a
capacidade autenticada consumida por `take`, o payload a persistir, a reserva
de identidade e o estado da tentativa de criação Chatwoot. O outbox atual
publica contratos `attendance.*` com confirmação `ack=persisted`; ele não é um
replayer de ingresso nem aceita diretamente o contrato de resposta da correlação.
Os handlers atuais também capturam falhas sem produzir esse journal.

Liberar a fila antes desses passos sem checkpoints duráveis perderia a capacidade
de autorização após reinício ou abriria repetição de criação após resposta
incerta. Persistir apenas a correlação depois do ACK deixa a janela entre a
criação externa e o commit local descoberta; desacoplar apenas esse HTTP também
exige preservar a ordem de entrada no Atendimento durante backoff/restart.
Por isso nenhum desses awaits foi convertido em tarefa de memória ou replay
de criação. Falhas temporárias nesse trecho conservam as limitações de
recuperação da baseline; a candidata não oferece garantia nova de ausência de
perda no ingresso. Resolver esse bloqueio exige implementar e validar o journal
e os checkpoints de ingresso, com tratamento explícito da criação incerta.

A interceptação de grupos permanece na fila original: desacoplá-la sem um
journal/lifecycle equivalente também não oferece recuperação demonstrada.

## Arquivos e limites de validação

- `nexi-identity.cjs`: remoção do enriquecimento por consulta e classificação de DM.
- `patch-financial-delivery-source.mjs`: retirada da consulta anterior à associação
  e reutilização da foto persistida na atualização de contato.
- `patch-attendance-source.mjs`: composição das âncoras com os caminhos alterados.
- `nexi-attendance.cjs`: wake após commit e consumidor comum limitado/coalescido.
- Este relatório.

Revisão somente textual dos diffs, das âncoras e dos contratos necessários à
implementação. Sem testes locais, parser, lint, build, patcher, laboratório,
instalação de pacotes, banco em execução, envios reais, EasyPanel ou deploy.
Nenhuma alteração em APP, Evolution antiga, BIA ou n8n.

Sintaxe/composição executável dos patchers, múltiplos commits simultâneos,
saturação/fairness, reinício entre commit e wake, falha HTTP/lease, duplicatas,
contatos sem foto e efeitos de backlog ainda dependem de validação funcional
pelo proprietário. A meta operacional de aproximadamente 2–3 segundos não foi
medida nem declarada atingida.
