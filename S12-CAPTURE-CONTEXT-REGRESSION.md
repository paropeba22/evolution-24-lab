# NEXI V23 / S12 — primeiro campo de capture_context_regression

Data: 2026-10-22. Base Evolution: `ff14a2d1c68935380b59ab1e432dc46ada8e5eab`, sobre V2 `926e5afef09f1ec62cea8bd14398275e830da34a`. Branch candidata: `candidate/v23-s12-capture-regression-diagnostics`. SHA publicado acompanha a entrega. Sem alteração APP.

## Conclusão delimitada

A captura informada pelo Luna, correlation `f199f9f9304951ebf44d7554`, comprova uma recusa do guard de monotonicidade em `installCaptureContext`. Não é a exceção genérica de Prisma/commit que antes permanecia possível. O snapshot passou por `captureContextCurrent` e havia contexto anterior com a mesma session_identity. Pelo menos um dos predicados abaixo foi verdadeiro.

O log atual não revela o predicado, valores anteriores ou qual contexto autenticado instalou o anterior. Portanto o campo efetivamente divergente e a classificação de sua origem como condição operacional ou defeito de protocolo ainda NÃO são demonstráveis. O guard está cumprindo sua função de impedir substituição incompatível; isso não prova que os estados que chegaram a ele foram produzidos corretamente.

Mantêm-se os fatos operacionais fornecidos: contexto APP HTTP 200 autenticado, demais checks informados true, resposta Evolution/APP 422, barrier fencing epoch 50/revision 197, sem saída persistida ou dispatch. Não foi feita outra operação por Sol.

## Predicados exatos na base implantada

Todos os testes desta tabela são executados somente se `previous.session_identity === context.session_identity`, na ordem abaixo e com curto-circuito. `previous` é o contexto compartilhado já instalado no registro do socket; `context` é o candidato autenticado recebido da APP. Igualdade de sessão/atestado nos checks anteriores não compara necessariamente os dois contextos destes predicados.

| Campo emitido pelo candidato | Condição exata que recusa |
| --- | --- |
| account_id | Account do contexto anterior diferente da candidata. |
| inbox_id | Inbox anterior diferente da candidata, se account coincidiu. |
| managed_channel_id | Canal anterior diferente do candidato, se os dois campos anteriores coincidiram. |
| writer_epoch | Epoch candidato menor que o anterior. |
| binding_generation | Geração candidata menor que a anterior. |
| barrier_state | Somente no mesmo epoch: estágio candidato anterior ao instalado na ordem unresolved → staged → fencing → active → pause_requested → paused → retired. |
| instance_lineage_id | Somente no mesmo epoch: referência anterior não nula e diferente da candidata. |
| sender_account_lineage_id | Somente no mesmo epoch: referência anterior não nula e diferente da candidata. |
| sender_attestation_id | Somente no mesmo epoch: referência anterior não nula e diferente da candidata. |

O evento registra apenas o PRIMEIRO predicado rejeitante efetivamente alcançado, não um inventário de todos os campos diferentes. A ordem dos estágios é a comparação de monotonicidade existente, não autorização para executar manualmente essa sequência ou avançar epoch/revision. Mudanças de owner são proibidas mesmo que epoch avance. Avanço legítimo de epoch deixa de aplicar os testes de estado/linhagem que eram exclusivos do mesmo epoch; não é permissão para forçá-lo.

## Lacuna de observabilidade e patch mínimo

`installCaptureContext(snapshot, writerProbe = null)` recebe opcionalmente o probe somente na rota de writer authority. Wrappers retornam os mesmos booleanos e preservam every/OR/some, ordem de leitura, curto-circuito, gate de mesmo epoch e o fail original. Não há nova busca, comparação repetida ou leitura dos valores para diagnóstico.

Novo evento WARN: `attendance.writer_probe.capture_regression`. Conteúdo exato: event, operation=writer_probe, correlation já existente e field restrito aos nove nomes da tabela. Não inclui valores, hashes novos, sessão, PN/LID, número, conteúdo, IDs de linhagem, credenciais, envelope ou erro livre. Nome desconhecido é omitido. Falhas do logger/callback diagnóstico não substituem o guard. Demais callers do installer continuam sem probe e sem evento novo.

O terminal permanece `capture_context_installation / nexi_attendance_capture_context_regression`, com a mesma resposta pública e recusa. Não há correção funcional, novo endpoint, migration, fila, configuração, grant ou retry. HOLD, isolamento do backlog, idempotência e CAS permanecem intocados.

## Interpretação operacional e hipótese de protocolo

Não há reparo operacional específico comprovado enquanto o campo for desconhecido. O caminho suportado continua sendo contexto autenticado da APP, obtido por `registrationContext/refreshContext`, instalado no registro do socket respeitando seus guards. `configure` pode restaurar contexto histórico anteriormente autenticado, com digest conferido, da mesma instância/sessão antes de tentar atualizar; uma reinicialização não garante remover a divergência e não é recomendada como reparo.

Se o campo for owner (account/inbox/canal), é preciso provar em qual origem autenticada surgiu o vínculo divergente e a propriedade atual correta. Se for epoch/generation/estado, é preciso relacionar contexto instalado e candidato à sequência de snapshots autenticados e ao barrier da mesma instância/sessão; nenhum contador deve ser alinhado manualmente. Se for linhagem/atestado, é preciso verificar a proveniência e a permanência do mesmo remetente, distinguindo renovação de prova de troca de owner. Isso pode ser descrito por igualdade/diferença, existência e cronologia, sem expor os identificadores ou valores sensíveis.

Uma hipótese concreta de fonte, ainda NÃO atribuída a esta ocorrência: APP `SenderIdentityCapture.perform!` aceita observação autenticada nova da mesma sessão, preserva PN/LID/owner, e cria uma attestation nova quando observation_id não é replay. `WriterBarrierService.receipt_context` escolhe a attestation mais recente; o installer Evolution proíbe substituir uma attestation anterior não nula por outra no mesmo epoch. Os checks de `registration.attestation` anteriores não medem essa igualdade entre referências de contexto. Isso evidencia uma fronteira que precisa de protocolo coerente de renovação, mas não comprova que sender_attestation_id foi o campo desta falha ou que o guard possa ser removido. Não se corrigiu funcionalmente uma hipótese.

Sol não solicita dados/operações OVH nesta etapa. Não há nova tentativa de envio recomendada ou iniciada. Não limpar contexto/registro/banco, reiniciar para apagar memória, editar epoch/revision, fabricar sessão, remover guard, desativar HOLD, recuperar 548/557 ou reutilizar autorização expirada. Qualquer evolução funcional dependerá da identificação do predicado e da prova de continuidade correspondente.

## Verificações e revisão

`node --test attendance-writer-isolation-diagnostics.test.cjs`: **22/22 PASS**, cerca de dois segundos de testes. São os nove casos anteriores mais 13 casos focados no novo diagnóstico: cada um dos nove campos; gate de mesmo epoch; sessão diferente/linhagens anteriores nulas; primeiro predicado sem ler campos posteriores; allowlist e falha do logger. Installer/rota/envelope/storage guard são reais; repositório/transação e aquisição de socket/registration são fixtures conforme declaração do harness. Não comprova runtime, atestado real ou PostgreSQL.

`node --check` dos dois arquivos de produção e `git diff --check`: PASS. Sem dependências instaladas, banco, rede, build ou suíte extensa.

Revisão independente `/root/review_continuous_composer`: nenhum blocker concreto; confirmou preservação das comparações/ordem/curto-circuito/gate e diagnóstico do primeiro campo sem valores. Não executou testes adicionais, DB, rede ou OVH.

**PENDENTES:** campo efetivamente divergente na OVH, sua origem/cronologia, classificação causal operacional versus protocolo e eventual correção funcional. O candidato apenas torna o próximo diagnóstico suficientemente específico; não reconstrói o evento anterior nem autoriza nova operação física.
