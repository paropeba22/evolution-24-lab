# S12 / V23 — transport return no readback assinado

2026-10-23. Branch candidata `candidate/v23-s12-transport-return-reconciliation`.
Base Evolution: `205087f8f1e20f774cbfd576e11e2f44b81dcece`.
Par APP: candidato da mesma branch, base `d9e70361700ef574dd0f52042f19ab2c1c288920`.

O resultado de consumption_readback de operação já consumida expõe o campo
opcional transport_return, copiado exclusivamente dos booleanos persistidos:
boundary_returned=true e succeeded booleano. Não inclui erros livres, conteúdo,
destinatário ou campos extras. Exige consumo/dispatch físicos persistidos,
outcome_unknown=true e state consistente. succeeded=false não é prova de não envio.

O contrato HMAC, request_digest, IDs e namespace continuam idênticos. O dado não
aparece na resposta de consume nem fabrica receipt/ACK/delivery. Readback de
operação já iniciada não chama dispatch ou expiryReadback. Grant expirado continua
sendo consultável como fato histórico, sem renovar autorização de envio.

O APP usa serviço autenticado e endpoint específico para os IDs completos da
mesma mensagem/execução/tentativa/orquestração; verifica vínculos e assinatura e
preenche somente transport_return_metadata uma vez. Mantém consumption_ack,
outcome_unknown, receipts e projeção. O relatório completo está no candidato APP.

Teste focado `node --test attendance-transport-return-readback.test.cjs`: 10/10,
com rede bloqueada, rota e assinatura reais e repositório em memória. Traps provam
ausência de chamadas a dispatch, sendMessage e receipt repository no readback da
operação iniciada. Cobre resultados positivo/negativo, ausência de retorno,
formato inconsistente, adulteração e troca de material. Node --check e diff --check
também verificados. Não comprova runtime, PostgreSQL real ou recuperação de receipt.

Sem migrations, filas, HOLD, grants, WriterBarrier ou configuração operacional.
Os nove limites ausentes de receipt capture não recebem defaults neste patch;
exigem orçamento real e inicialização válida. Configurá-los não recupera receipts
descartados antes do worker/journal. Não limpar health ou supor retransmissão.

Sem acesso OVH, deploy, DB operacional, replay ou WhatsApp. Publicação é candidata,
pendente de revisão independente em outra conversa e validação posterior do Luna.
