# NEXI V23 / S12 — diagnóstico após storage_guard_executed

Data: 2026-10-22. Candidato Evolution baseado em `926e5afef09f1ec62cea8bd14398275e830da34a`; branch `candidate/v23-s12-writer-isolation-diagnostics`. SHA publicado acompanha a entrega. Nenhuma mudança APP.

## Evidência real recebida e classificação

Luna executou uma única tentativa autorizada pelo composer. APP chegou a probe_http/probe_returned, recebeu Evolution HTTP 422 e recusou com evolution_writer_unproved. Barrier permaneceu fencing, epoch 50/revision 197. Não houve Message outgoing, execution, attempt nem dispatch_marked_at vinculados à tentativa. A autorização operator_composer ficou não consumida e expirará naturalmente; não reutilizar ou alterar.

Evolution autenticou envelope e contexto APP HTTP 200, validou binding fencing e executou storageGuard. Flags, CAS do socket, lifecycle/socket e todos os checks informados de registration/context/session/attestation foram true. O terminal foi last_stage=storage_guard_executed, failure_stage=writer_isolation, category=unexpected_failure.

Isso NÃO sustenta atribuir a falha a socket ou sessão inválidos. storageGuard retornou antes da etapa registrada; uma recusa interna desse guard não é compatível com essa sequência, assumindo eventos correlacionados e completos. Ainda não se pode concluir commit da transação: o evento ocorre dentro dela.

## Primeiro trecho ainda não explicado

Na base, `nexi-attendance-authority.cjs` executa, nesta ordem:

1. storageGuard; evento storage_guard_executed.
2. instance.updateMany para CAS do owner e checks lifecycle/socket — passaram segundo a captura.
3. writerIsolation — checks informados de registration/context/attestation passaram. A verificação final de UUID das três linhagens não tinha boolean próprio, mas sua recusa normal produz nexi_attendance_writer_isolation_unproved, já reconhecido pelo diagnóstico. Logo, essa condição isoladamente não explica unexpected_failure.
4. installCaptureContext(snapshot).
5. retorno do callback e conclusão da transação Prisma.
6. lifecycle/captureContextCurrent após a transação; a recusa normal também já tem código reconhecido.

O passo 4 pode lançar dois códigos estáveis que NÃO estavam na allowlist e viravam unexpected_failure:

- nexi_attendance_capture_context_superseded: snapshot não é mais atual, por exemplo mudança de revisão do registro durante a espera do contexto. O guard também protege identidade de registro, instância, sessão e owner.
- nexi_attendance_capture_context_regression: instalação violaria a monotonicidade do contexto anterior da mesma sessão — owner/account/inbox/canal, epoch/generation, estado ou linhagens/atestado no mesmo epoch. A igualdade de sessão/attestation citada no log compara outros predicados e não prova igualdade entre todos esses campos do contexto anterior e do candidato.

Também são possíveis exceções de runtime nos passos restantes ou falha da transação Prisma ao terminar, ainda agrupadas como writer_isolation. Um retorno de CAS não comprova que a transação concluiu. Os logs fornecidos não distinguem esses casos. Nem ausência de schema, nem dependência ausente, nem conflito real do contexto está demonstrado; nenhuma correção funcional foi justificada.

## Mudança mínima

Somente instrumentação nos dois arquivos de produção:

- `nexi-attendance-authority.cjs`: fases writer_socket_cas, writer_registration_validation, capture_context_installation, writer_transaction_completion e writer_post_transaction_validation. writer_transaction_completion é selecionada após installCaptureContext retornar, ainda dentro do callback; identifica espera/erro na conclusão da transação, não certifica commit ou rollback.
- `nexi-attendance.cjs`: reconhece os dois guards de captura acima e capture_socket_mismatch. O terminal attendance.writer_probe.rejected acrescenta error_class e error_code de listas fechadas. Classes JS/Prisma conhecidas, códigos Prisma selecionados e códigos estáveis de timeout/rede/módulo ausente podem ser distinguidos; os demais viram OtherError/unclassified. Category de erros Prisma desconhecidos ao classificador anterior continua unexpected_failure, acompanhada agora de classe/código permitidos.
- A seleção em allowlists utiliza o mesmo valor capturado uma vez, evitando que getters variáveis façam a verificação aprovar um valor e emitir outro. Testes cobrem isso.

Não há stack, mensagem livre de exceção, metadata/cause cru, credencial, token, conteúdo, PN/LID, telefone, IDs de linhagem ou valores do contexto no novo diagnóstico. Correlation continua o hash já existente. Falha de logger não muda resposta ou exceção de autorização.

Não foram modificados predicados, ordem das verificações, guards, storage, instalação do contexto, transações, grants, sessão, CAS, idempotência, endpoints ou corpo/status públicos. Nenhuma migration, flag, fila ou consumer novo. HOLD e backlog permanecem protegidos pelas regras existentes. O patch não inicia envio nem adiciona retry/readback.

## Testes e revisão

`node --test attendance-writer-isolation-diagnostics.test.cjs`: **PASS, 9/9**. O harness usa rota, HMAC/envelope/token, storage guard e installer reais, com repository/transação em memória. A aquisição de snapshot/socket e writerIsolation são fronteiras de fixture previamente validadas: estes testes verificam localização/classificação, não segurança real do socket, attestation ou PostgreSQL.

Casos: superseded e regression recusados pelo installer real após checks de fixture true; exceções injetadas no CAS/registration/conclusão de transação com código Prisma; recusa normal do CAS; invalidação do snapshot após retorno da transação; prova assinada no percurso positivo da fixture; privacidade, getters hostis e falha do logger. Todos verificam ausência de consumo/dispatch-start da fixture.

`node --check` dos dois arquivos de produção e `git diff --check`: PASS. Sem suíte ampla, banco, rede, build ou instalação. Não repetimos os testes anteriores dependentes de libsignal ausente.

Revisão independente focada por `/root/review_continuous_composer`: confirmou a fronteira causal, preservação de guards/ordem e limites das fixtures. Identificou a leitura repetida de getter no diagnóstico; correção incorporada e testada. Resultado final da revisão acompanha a entrega.

## Uso posterior e limites

Este candidato depende de revisão antes de qualquer implantação pelo Luna; Sol não operou a OVH. Não há autorização ou recomendação de novo envio nesta rodada. Não repetir a operação antiga, criar UUID para reencaminhá-la, alterar epoch/revision, limpar autorizações/grants/CAS/filas ou desativar HOLD. Preservar a autorização não consumida até expirar naturalmente e não tocar em 548/557.

O patch não reconstrói retroativamente a exceção perdida. Se uma captura futura for autorizada separadamente, ela deve ser classificada pelo par failure_stage + error_code/error_class, mantendo correlation. capture_context_installation com um dos dois guards prova uma recusa do contexto; writer_transaction_completion com erro Prisma localiza a conclusão da transação; TypeError ou MODULE_NOT_FOUND indicam a classe/código de runtime, sem expor mensagem ou provar sua origem específica. Nenhum desses resultados, por si só, autoriza relaxar a proteção.

PENDENTES: código/classe reais da exceção desta tentativa, campo/condição exata se houver regression/superseded, estado completo da transação Evolution e validação no runtime. Não declarar correção funcional ou envio PASS. A ausência operacional de outgoing/execution/attempt/dispatch informada pelo Luna permanece a evidência desta recusa; o candidato não executou outra tentativa.
