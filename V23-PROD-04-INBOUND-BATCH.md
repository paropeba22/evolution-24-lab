# NEXI V23-PROD-04 — isolamento dos itens de ingresso

Baseline main confirmado por Git remoto:
`25b5b82f1f1d11c94c267f9d1193aeee5cd46816`.
Candidata: `fix/v23-prod-04-inbound-batch`, worktree isolada.
Companion APP: `fix/v23-prod-04-integrated-attendance`, baseline
`1b9d3bf37cd9168e95f505cbb4006d941f9f1133`.
Relatório integrado: `docs/attendance/v23-prod-04-integrated-investigation.md`
na candidata APP. Resultado: **READY FOR INDEPENDENT REVIEW**, sem aceite E2E.

Defeito demonstrado no upstream fixado pelo Dockerfile
(`e273b904d53f5726970fd6a244ed9caa61dfeb9a`): o catch de messages.upsert
envolve todo o for. Uma exception de chat/read/cache/persistência/perfil no
primeiro item encerra o handler e impede os próximos itens válidos de alcançar
o caminho de persistência NEXI. Dois returns dos skips de mídia S3 têm o mesmo
efeito. Uma Message já pode ter sido persistida na APP antes de a persistência
local Evolution falhar; repetir o lote seria inseguro e não é a correção.

`patchAttendanceInboundBatch`, no patcher Attendance existente, delimita o
handler e aplica anchors únicos após os patches de identidade/financeiro e
Groups. Adiciona catch por item. Para nexi-wa-, a falha gera diagnóstico
`nexi_inbound_item_failed` com instance_id e external_message_id técnico
validado, sem conteúdo, JID, erro bruto, stack ou segredo; o for continua.
Os skips de vídeo/mídia usam continue em nexi-wa-. Instâncias não NEXI
mantêm o catch externo e os returns upstream. Os demais filtros, capacidades,
admissão de Groups, HMAC, ACK, provider isolation, dedup e grants ficam iguais.

Não há retries de mensagens, reprocessamento, outbox novo ou tentativa de
envio. Não se transforma histórico/offline em prova realtime, não se cria
PN/LID por cache, nem se reabre evidência pendente de criação incerta.
O limite existente de ausência de journal durável integral de entradas
diretas permanece explícito. Esta correção impede que uma falha de um item
também elimine o processamento dos itens posteriores; não recupera o item
falhado nem garante ingresso de todos os eventos.

A coleta de Luna comprovou ingresso de 7378 e não localizou o de 4988 na APP.
Nenhum desses fatos demonstra que o defeito de lote causou a ausência de 4988.
Para essa conclusão ainda faltam external_message_id, instance/session,
decrypt/upsert/lote, requests identity.observed/correlated e Message/ACK,
e eventuais exceptions anteriores no mesmo handler. Manager não é histórico
completo do transporte. A coleta futura pertence à Luna, em missão separada.

Inspeção exclusivamente estática do upstream local Git, ordem do Dockerfile,
anchors e delta. O patcher e a fonte transformada não foram executados ou
gerados. Nenhum parser, lint, teste, build, laboratório, banco, migration,
VPS, logs operacionais, navegador, deploy, cutover ou mensagem WhatsApp.
Commits/push da candidata usam hooks vazios para evitar verificações locais.
Sem alteração de canônica, WriterBarrier, dispatch_enabled, grants/sessões,
fencing/CAS, unknown ou dados históricos. Revisão independente ainda necessária.
