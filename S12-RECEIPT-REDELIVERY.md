# S12 / V23 — callback de receipt original em quarentena

2026-10-23. Branch candidata `candidate/v23-s12-receipt-redelivery`.
Base Evolution `54ba18e26c1dfb216b06059f421cdcf68ff8d206`.
Par APP base `7583e239e4bd635af39230607948bd96118435dd`.

Baseline não possui recovery endpoint para receipts quarantined; drainer só
seleciona pending. Replay de ingresso/consume não serve para essa evidência.

O novo action receipt_redelivery na rota authority exige API-key e envelope APP
HMAC fresco, formato fechado e physical_dispatch=false. O APP só assina após
autenticação normal, administrador atual e binding completo da operação/mensagem.
Inclui consumo original, UUID/fingerprint originais do evento e contador esperado.

Módulo nexi-attendance-receipt-redelivery.cjs verifica preparation frozen,
grant/release/consumo, namespace/external ID, outbox receipt e journal original,
digests/proveniência, guards de storage e prazo DB. CAS de quarantined com contador
exato adquire lease30s e incrementa attempts; nunca escreve pending ou reseta
contadores. Só esse evento pode realizar um callback HTTPS ao APP configurado.
Body e event UUID são preservados, assinatura/timestamp renovados; timeout8s e
redirect proibido. O módulo é copiado nos stages Docker builder/runtime.

ACK persisted com UUID/fingerprint/version exatos permite CAS para acknowledged;
falha mantém quarantined e o contador. Lease expirada ou dono substituído não
pode finalizar. Não há laço/retry; mesmo manifesto consumido não chama HTTP outra
vez. Outra tentativa após incerteza requer ação administrativa explícita com
contador atualizado. Already acknowledged é readback sem callback. Dedupe APP
normal mantém uma evidência por event/journal, inclusive após resposta perdida.

Nenhum sendMessage/consume/dispatch/probe/grant é chamado. Não cria receipt, não
edita payload/ID, não promove delivery, não altera HOLD/WriterBarrier/identidade,
backlog comercial ou sequências548/557. Nenhuma migration/OVH/WhatsApp executada.
receipt_retained=false significa confirmação ausente, não ausência de commit.
ReceiptReceiver/reducer originais continuam validando/aplicando a evidência.

Teste focado:21/21 em attendance-receipt-redelivery.test.cjs, rede bloqueada,
storage/contratos/rota reais e DB em memória. Cobre assinatura do callback original,
CAS concorrente, contador/lease, resposta perdida, ACK incorreto, bindings e estados
excluídos. Sem build, DB real ou replay operacional; integração/runtime pendentes.

Relatório completo e endpoint APP em S12-RECEIPT-REDELIVERY.md do candidato APP.
Solicitar revisão independente antes de implantação; não executar recuperação
nem enviar outra mensagem nesta entrega.
